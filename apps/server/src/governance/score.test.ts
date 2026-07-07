import { describe, it, expect } from 'vitest';
import type { WorkflowListItem, WorkflowOwner, WorkflowHealth, Criticality } from '@argus/shared';
import { computeGovernanceScore, PILLAR_WEIGHTS, wfKey, type ScoreInputs } from './score.js';

/**
 * The governance score is the ONE new computation of S6. These tests pin its two
 * contract-critical properties: it is a pure, deterministic function, and it
 * preserves the estate's uncertainty rather than laundering it (rule 5).
 */

const owner = (status: WorkflowOwner['status']): WorkflowOwner => ({
  status,
  owner: status === 'unowned' ? null : { email: 'a@b.io', name: 'A' },
  backupOwner: null,
  reason: null,
  source: status === 'assigned' ? 'assigned' : status === 'inferred' ? 'project-member' : null,
  memberRole: null,
  assignedBy: null,
  assignedAt: null,
});

const health = (status: WorkflowHealth['status'], failureRate: number | null = null): WorkflowHealth => ({
  status,
  failureRate,
  runsInWindow: status === 'idle' ? 0 : 10,
  failuresInWindow: 0,
  lastRunAt: null,
  lastStatus: null,
  avgDurationMs: null,
  windowHours: 336,
  computedAt: '2026-07-07T00:00:00.000Z',
  unavailableReason: status === 'unknown' ? 'executions unreadable' : null,
});

function wf(over: Partial<WorkflowListItem> & { id: string }): WorkflowListItem {
  return {
    instanceId: 'prod',
    instanceLabel: 'prod',
    name: over.id,
    active: true,
    isArchived: false,
    project: null,
    updatedAt: null,
    systems: [],
    triggers: [],
    mcpExposed: false,
    nodeCount: 1,
    understood: true,
    brokenRefCount: 0,
    enrichment: null,
    health: null,
    owner: owner('unowned'),
    ...over,
  };
}

function enrichmentWith(criticality: Criticality): WorkflowListItem['enrichment'] {
  return {
    status: 'analyzed',
    provider: 'openai',
    model: 'gpt',
    enrichedAt: '2026-07-07T00:00:00.000Z',
    corrected: false,
    summary: null,
    description: null,
    category: null,
    criticality,
    criticalityReason: null,
    riskFlags: [],
    suggestedOwnerRationale: null,
    businessContext: null,
  };
}

const emptyInputs = (workflows: WorkflowListItem[]): ScoreInputs => ({
  workflows,
  spofWorkflowKeys: new Set(),
  noBackupKeys: new Set(),
  personalSpaceCriticalKeys: new Set(),
  staleKeys: new Set(),
  exposure: [],
});

describe('governance score — determinism & shape', () => {
  it('is a pure function: identical inputs yield an identical result', () => {
    const workflows = [
      wf({ id: 'a', owner: owner('assigned'), enrichment: enrichmentWith('critical'), health: health('healthy') }),
      wf({ id: 'b', owner: owner('unowned'), enrichment: enrichmentWith('low'), health: health('failing', 0.9) }),
    ];
    const a = computeGovernanceScore(emptyInputs(workflows));
    const b = computeGovernanceScore(emptyInputs(workflows));
    expect(a).toEqual(b);
  });

  it('exposes all five pillars with the confirmed default weights', () => {
    const res = computeGovernanceScore(emptyInputs([wf({ id: 'a', owner: owner('assigned') })]));
    expect(res.pillars.map((p) => p.key)).toEqual(['ownership', 'reliability', 'resilience', 'hygiene', 'exposure']);
    expect(Object.fromEntries(res.pillars.map((p) => [p.key, p.weight]))).toEqual(PILLAR_WEIGHTS);
    // Every pillar carries its inputs (explainable, never a black box).
    for (const p of res.pillars) expect(Object.keys(p.inputs).length).toBeGreaterThan(0);
  });
});

describe('governance score — only ASSIGNED ownership is factual; inferred is advisory', () => {
  it('an inferred owner does NOT count as owned (inference is a hint, not ownership)', () => {
    const inferred = computeGovernanceScore(emptyInputs([wf({ id: 'a', owner: owner('inferred') })]));
    const ownershipInferred = inferred.pillars.find((p) => p.key === 'ownership')!;
    expect(ownershipInferred.score).toBe(0); // inferred-only = no confirmed owner
    expect(ownershipInferred.inputs.unowned).toBe(1);

    const assigned = computeGovernanceScore(emptyInputs([wf({ id: 'a', owner: owner('assigned') })]));
    const ownershipAssigned = assigned.pillars.find((p) => p.key === 'ownership')!;
    expect(ownershipAssigned.score).toBe(100); // only an assignment counts
    expect(ownershipAssigned.inputs.unowned).toBe(0);

    const unowned = computeGovernanceScore(emptyInputs([wf({ id: 'a', owner: owner('unowned') })]));
    expect(unowned.pillars.find((p) => p.key === 'ownership')!.score).toBe(0);
  });

  it('an unowned critical costs more than an unowned low (criticality-weighted)', () => {
    const crit = computeGovernanceScore(
      emptyInputs([
        wf({ id: 'a', owner: owner('assigned'), enrichment: enrichmentWith('low') }),
        wf({ id: 'b', owner: owner('unowned'), enrichment: enrichmentWith('critical') }),
      ]),
    ).pillars.find((p) => p.key === 'ownership')!;
    const low = computeGovernanceScore(
      emptyInputs([
        wf({ id: 'a', owner: owner('assigned'), enrichment: enrichmentWith('critical') }),
        wf({ id: 'b', owner: owner('unowned'), enrichment: enrichmentWith('low') }),
      ]),
    ).pillars.find((p) => p.key === 'ownership')!;
    // Same 1-of-2 unowned, but the critical-unowned case scores strictly lower.
    expect(crit.score!).toBeLessThan(low.score!);
  });
});

describe('governance score — unavailable health is excluded, never scored healthy', () => {
  it('a workflow whose health is unknown does not lift or lower reliability', () => {
    const res = computeGovernanceScore(
      emptyInputs([
        wf({ id: 'a', owner: owner('assigned'), health: health('failing', 1) }),
        wf({ id: 'b', owner: owner('assigned'), health: health('unknown') }),
      ]),
    );
    const rel = res.pillars.find((p) => p.key === 'reliability')!;
    expect(rel.inputs.excludedUnknown).toBe(1);
    expect(rel.inputs.evaluated).toBe(1); // only the failing one counts
    expect(rel.score).toBe(0); // 1 failing of 1 evaluated — unknown never softened it
  });

  it('when NO workflow has readable non-idle health, reliability is "couldn\'t score" and its weight is redistributed (no silent 100)', () => {
    const res = computeGovernanceScore(
      emptyInputs([
        wf({ id: 'a', owner: owner('assigned'), health: health('unknown') }),
        wf({ id: 'b', owner: owner('assigned'), health: health('idle') }),
      ]),
    );
    const rel = res.pillars.find((p) => p.key === 'reliability')!;
    expect(rel.scored).toBe(false);
    expect(rel.score).toBeNull();
    expect(rel.effectiveWeight).toBe(0);
    // The remaining scored pillars' effective weights renormalize to 1.
    const total = res.pillars.reduce((s, p) => s + p.effectiveWeight, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe('governance score — exposure (confirmed reach only) & resilience', () => {
  it('an unowned MCP workflow reaching a sensitive system hurts more than an owned one', () => {
    const unowned = computeGovernanceScore({
      ...emptyInputs([]),
      exposure: [{ key: 'prod::a', owned: false, reachesSensitive: true }],
    }).pillars.find((p) => p.key === 'exposure')!;
    const owned = computeGovernanceScore({
      ...emptyInputs([]),
      exposure: [{ key: 'prod::a', owned: true, reachesSensitive: true }],
    }).pillars.find((p) => p.key === 'exposure')!;
    expect(unowned.score!).toBeLessThan(owned.score!);
    expect(unowned.inputs.reachingSensitiveUnowned).toBe(1);
  });

  it('zero MCP-exposed workflows is an honest 100 (measured no-exposure), still scored', () => {
    const exp = computeGovernanceScore(emptyInputs([wf({ id: 'a' })])).pillars.find((p) => p.key === 'exposure')!;
    expect(exp.scored).toBe(true);
    expect(exp.score).toBe(100);
    expect(exp.inputs.mcpExposed).toBe(0);
  });

  it('a critical, owned, single-point-of-failure workflow lowers resilience', () => {
    const wfs = [wf({ id: 'a', owner: owner('assigned'), enrichment: enrichmentWith('critical') })];
    const res = computeGovernanceScore({ ...emptyInputs(wfs), spofWorkflowKeys: new Set([wfKey({ instanceId: 'prod', id: 'a' })]) });
    const resil = res.pillars.find((p) => p.key === 'resilience')!;
    expect(resil.inputs.atRisk).toBe(1);
    expect(resil.score).toBe(0);
  });

  it('critical workflows with NO assigned owner are the worst case — resilience 0, NOT "couldn\'t score"', () => {
    const wfs = [
      wf({ id: 'a', owner: owner('unowned'), enrichment: enrichmentWith('critical') }),
      wf({ id: 'b', owner: owner('inferred'), enrichment: enrichmentWith('critical') }), // inferred ≠ owned (rule 12)
    ];
    const resil = computeGovernanceScore(emptyInputs(wfs)).pillars.find((p) => p.key === 'resilience')!;
    expect(resil.scored).toBe(true); // it CAN be assessed — the accountability is measurably absent
    expect(resil.score).toBe(0);
    expect(resil.inputs.atRisk).toBe(2);
    expect(resil.inputs.unownedCritical).toBe(2);
  });

  it("resilience is \"couldn't score\" ONLY when there are no known critical workflows", () => {
    const resil = computeGovernanceScore(
      emptyInputs([wf({ id: 'a', owner: owner('assigned'), enrichment: enrichmentWith('low') })]),
    ).pillars.find((p) => p.key === 'resilience')!;
    expect(resil.scored).toBe(false);
    expect(resil.inputs.criticalTotal).toBe(0);
  });
});
