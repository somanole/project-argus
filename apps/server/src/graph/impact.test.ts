import { describe, it, expect } from 'vitest';
import { computeImpact } from './impact.js';
import type { StoredEdge, GraphWorkflowMeta } from './repo.js';
import type { NodeIdent } from './build.js';

const wfIdent = (instanceId: string, id: string, label: string): NodeIdent => ({ kind: 'workflow', instanceId, id, label });
const credIdent = (instanceId: string, id: string, label: string): NodeIdent => ({ kind: 'credential', instanceId, id, label });

const meta = (id: string, name: string): GraphWorkflowMeta => ({
  instanceId: 'p',
  instanceLabel: 'prod',
  id,
  name,
  active: true,
  archived: false,
  facts: null,
  health: null,
  mcpExposed: false,
  brokenRef: false,
});

const callEdge = (from: string, to: string, confidence: 'confirmed' | 'possible' = 'confirmed'): StoredEdge => ({
  src: wfIdent('p', from, from),
  dst: wfIdent('p', to, to),
  type: 'call',
  confidence,
  crossInstance: false,
  reason: 'call',
});

describe('computeImpact — "what breaks if X fails" (confirmed-only, explicit total)', () => {
  const workflows = ['slack', 'a', 'b', 'c', 'd', 'e'].map((id) => meta(id, id === 'slack' ? 'Send Slack Alert' : `Caller ${id}`));
  const edges: StoredEdge[] = ['a', 'b', 'c', 'd', 'e'].map((c) => callEdge(c, 'slack'));

  it('returns exactly the 5 callers and states the total', () => {
    const r = computeImpact(edges, workflows, { mode: 'failure', kind: 'workflow', instanceId: 'p', id: 'slack' }, 't');
    expect(r.total).toBe(5);
    expect(new Set(r.affected.map((a) => a.workflowId))).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
    expect(r.statement).toBe('5 affected, nothing else.');
  });

  it('EXCLUDES a possible edge from the count (the trust spine)', () => {
    const withPossible = [...edges, callEdge('ghost', 'slack', 'possible')];
    const workflowsPlus = [...workflows, meta('ghost', 'Ghost Possible Caller')];
    const r = computeImpact(withPossible, workflowsPlus, { mode: 'failure', kind: 'workflow', instanceId: 'p', id: 'slack' }, 't');
    expect(r.total).toBe(5); // ghost's possible edge is NOT counted
    expect(r.affected.some((a) => a.workflowId === 'ghost')).toBe(false);
    expect(r.possibleExcluded).toBe(1); // but the exclusion is reported honestly
  });

  it('traverses transitively (a caller of a caller is affected)', () => {
    // z → a → slack : failing slack breaks a AND z.
    const chain = [...edges, callEdge('z', 'a')];
    const r = computeImpact(chain, [...workflows, meta('z', 'Z')], { mode: 'failure', kind: 'workflow', instanceId: 'p', id: 'slack' }, 't');
    expect(r.affected.some((x) => x.workflowId === 'z' && x.hops === 2)).toBe(true);
  });
});

describe('computeImpact — rotate credential is a DIFFERENT answer than failure', () => {
  it('rotation returns the credential binders, not the call-graph callers', () => {
    const workflows = [meta('binderA', 'Binder A'), meta('binderB', 'Binder B'), meta('caller', 'Caller')];
    const edges: StoredEdge[] = [
      { src: wfIdent('p', 'binderA', 'Binder A'), dst: credIdent('p', 'C1', 'Warehouse'), type: 'binds_credential', confidence: 'confirmed', crossInstance: false, reason: 'binds' },
      { src: wfIdent('p', 'binderB', 'Binder B'), dst: credIdent('p', 'C1', 'Warehouse'), type: 'binds_credential', confidence: 'confirmed', crossInstance: false, reason: 'binds' },
      callEdge('caller', 'binderA'),
    ];
    const rot = computeImpact(edges, workflows, { mode: 'credential_rotation', kind: 'credential', instanceId: 'p', id: 'C1' }, 't');
    expect(new Set(rot.affected.map((a) => a.workflowId))).toEqual(new Set(['binderA', 'binderB']));
    expect(rot.edgeTypesTraversed).toEqual(['binds_credential']);

    const fail = computeImpact(edges, workflows, { mode: 'failure', kind: 'workflow', instanceId: 'p', id: 'binderA' }, 't');
    // Failing binderA breaks its caller — a different set than rotation.
    expect(new Set(fail.affected.map((a) => a.workflowId))).toEqual(new Set(['caller']));
  });
});
