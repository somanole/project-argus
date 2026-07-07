import type { WorkflowListItem, GovernanceScore, ScorePillar, ScorePillarKey } from '@argus/shared';

/**
 * The S6 governance score — the ONE new computation of the slice, and the only
 * thing on the dashboard that isn't a verbatim existing read.
 *
 * It is a **pure, deterministic** function of already-composed inputs: the same
 * inputs always yield the same number, and every pillar exposes the raw counts
 * that produced it (never a black box). It preserves the estate's built-in
 * uncertainty rather than laundering it (rule 5):
 *  - **factual ownership means an EXPLICITLY ASSIGNED owner.** Inferred ownership
 *    is advisory only — a hint to help find the right owner, never a substitute for
 *    confirming one (confirming ownership is a core job of Argus). So an inferred or
 *    unowned workflow is NOT counted as owned by the score;
 *  - workflows whose health is unknown/unavailable are EXCLUDED from reliability
 *    (never scored healthy); idle is neither pass nor fail;
 *  - only CONFIRMED graph reach feeds exposure (`possible` never counts);
 *  - a pillar with no measurable inputs reports "couldn't score" and is dropped
 *    from the weighted average with its weight redistributed — never a silent 100.
 *
 * Higher is better on every pillar (0–100). Weights are fixed defaults, owner-
 * confirmed at spec review: ownership .30, reliability .25, resilience .20,
 * hygiene .15, exposure .10.
 */

export const PILLAR_WEIGHTS: Record<ScorePillarKey, number> = {
  ownership: 0.3,
  reliability: 0.25,
  resilience: 0.2,
  hygiene: 0.15,
  exposure: 0.1,
};

const PILLAR_LABELS: Record<ScorePillarKey, string> = {
  ownership: 'Ownership',
  reliability: 'Reliability',
  resilience: 'Accountability resilience',
  hygiene: 'Hygiene',
  exposure: 'Exposure',
};

/** Criticality weighting — an unowned/at-risk critical hurts far more than a low. */
function critWeight(criticality: string | null | undefined): number {
  if (criticality === 'critical') return 3;
  if (criticality === 'high') return 2;
  return 1; // medium, low, or unlabeled
}

export const wfKey = (w: { instanceId: string; id: string }): string => `${w.instanceId}::${w.id}`;

/**
 * Factual ownership = an explicitly ASSIGNED owner. Inferred ownership is advisory
 * (a lead for who to confirm), never counted as ownership here. A workflow that is
 * only inferred, or unowned, is treated as having no owner for scoring.
 */
function isOwned(w: WorkflowListItem): boolean {
  return w.owner != null && w.owner.status === 'assigned';
}

/** One decimal place, deterministic. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Everything the score needs, already derived from the composed reads (so score.ts
 * touches no DB and stays trivially testable). Sets are keyed by `wfKey`.
 */
export interface ScoreInputs {
  /** Every workflow in the estate (carries owner + health + enrichment). */
  workflows: WorkflowListItem[];
  /** Critical workflows whose sole owner is a single-point-of-failure (S4 gap). */
  spofWorkflowKeys: Set<string>;
  /** Critical, assigned workflows with no backup owner (S4 gap). */
  noBackupKeys: Set<string>;
  /** Critical workflows inferred to live in a personal project (S4 gap). */
  personalSpaceCriticalKeys: Set<string>;
  /** Workflows whose enrichment is stale (S2). */
  staleKeys: Set<string>;
  /** MCP-exposed workflows and their confirmed reach (S5). */
  exposure: { key: string; owned: boolean; reachesSensitive: boolean }[];
}

function ownershipPillar(inputs: ScoreInputs): ScorePillar {
  const total = inputs.workflows.length;
  let totalWeight = 0;
  let ownedWeight = 0;
  let unowned = 0;
  let criticalUnowned = 0;
  for (const w of inputs.workflows) {
    const wt = critWeight(w.enrichment?.criticality);
    totalWeight += wt;
    if (isOwned(w)) ownedWeight += wt;
    else {
      unowned += 1;
      if (w.enrichment?.criticality === 'critical') criticalUnowned += 1;
    }
  }
  const inputsCounts = { total, assigned: total - unowned, unowned, criticalUnowned };
  if (totalWeight === 0) {
    return pillar('ownership', null, 'No workflows to score ownership on.', inputsCounts);
  }
  const score = round1((ownedWeight / totalWeight) * 100);
  const reason =
    unowned === 0
      ? 'Every workflow has a confirmed (assigned) owner.'
      : `${unowned} of ${total} workflows have no assigned owner (${criticalUnowned} critical), criticality-weighted. Inferred owners are advisory only and don't count.`;
  return pillar('ownership', score, reason, inputsCounts);
}

function reliabilityPillar(inputs: ScoreInputs): ScorePillar {
  // Only KNOWN, non-idle health counts. Unknown/unavailable is excluded, never
  // scored healthy; idle (0 runs) is neither pass nor fail.
  let denomWeight = 0;
  let penalty = 0;
  let failing = 0;
  let degraded = 0;
  let healthy = 0;
  let excludedUnknown = 0;
  let excludedIdle = 0;
  for (const w of inputs.workflows) {
    const s = w.health?.status;
    if (s == null || s === 'unknown') {
      if (s === 'unknown') excludedUnknown += 1;
      continue;
    }
    if (s === 'idle') {
      excludedIdle += 1;
      continue;
    }
    const wt = critWeight(w.enrichment?.criticality);
    denomWeight += wt;
    if (s === 'failing') {
      failing += 1;
      penalty += wt;
    } else if (s === 'degraded') {
      degraded += 1;
      penalty += wt * 0.5;
    } else {
      healthy += 1;
    }
  }
  const inputsCounts = { evaluated: failing + degraded + healthy, failing, degraded, healthy, excludedUnknown, excludedIdle };
  if (denomWeight === 0) {
    return pillar('reliability', null, "Couldn't score — no workflow has readable, non-idle health.", inputsCounts);
  }
  const score = round1((1 - penalty / denomWeight) * 100);
  const reason =
    failing + degraded === 0
      ? `All ${healthy} evaluated workflows are healthy${excludedUnknown ? ` (${excludedUnknown} excluded — health unavailable)` : ''}.`
      : `${failing} failing, ${degraded} degraded of ${failing + degraded + healthy} evaluated (criticality-weighted)${excludedUnknown ? `; ${excludedUnknown} excluded — health unavailable` : ''}.`;
  return pillar('reliability', score, reason, inputsCounts);
}

function resiliencePillar(inputs: ScoreInputs): ScorePillar {
  // Accountability resilience of the estate's CRITICAL workflows: is each critical
  // workflow backed by a confirmed, resilient owner? A critical workflow is at risk
  // when it has NO assigned owner at all (nobody accountable — the worst case), OR its
  // sole owner is a single point of failure, OR it has no backup owner. Criticality is
  // the scope; "couldn't score" is reserved for an estate with no KNOWN criticals
  // (criticality not yet analyzed) — never for criticals that are simply unowned.
  const criticals = inputs.workflows.filter((w) => w.enrichment?.criticality === 'critical');
  let unownedCritical = 0;
  const atRiskKeys = new Set<string>();
  for (const w of criticals) {
    const k = wfKey(w);
    if (!isOwned(w)) {
      unownedCritical += 1;
      atRiskKeys.add(k);
    } else if (inputs.spofWorkflowKeys.has(k) || inputs.noBackupKeys.has(k)) {
      atRiskKeys.add(k);
    }
  }
  const inputsCounts = {
    criticalTotal: criticals.length,
    unownedCritical,
    spofWorkflows: inputs.spofWorkflowKeys.size,
    noBackup: inputs.noBackupKeys.size,
    atRisk: atRiskKeys.size,
  };
  if (criticals.length === 0) {
    return pillar('resilience', null, "Couldn't score — no critical workflows are known yet (criticality not analyzed).", inputsCounts);
  }
  const score = round1((1 - atRiskKeys.size / criticals.length) * 100);
  let reason: string;
  if (atRiskKeys.size === 0) {
    reason = `All ${criticals.length} critical workflows have a confirmed, backed-up owner.`;
  } else {
    const parts: string[] = [];
    if (unownedCritical) parts.push(`${unownedCritical} with no assigned owner`);
    const assignedAtRisk = atRiskKeys.size - unownedCritical;
    if (assignedAtRisk) parts.push(`${assignedAtRisk} single-point-of-failure or no backup`);
    reason = `${atRiskKeys.size} of ${criticals.length} critical workflows lack resilient accountability (${parts.join('; ')}).`;
  }
  return pillar('resilience', score, reason, inputsCounts);
}

function hygienePillar(inputs: ScoreInputs): ScorePillar {
  const total = inputs.workflows.length;
  const issueKeys = new Set<string>();
  let brokenRefs = 0;
  let stale = 0;
  let activeNoExec = 0;
  for (const w of inputs.workflows) {
    const k = wfKey(w);
    let issue = false;
    if (w.brokenRefCount > 0) {
      brokenRefs += 1;
      issue = true;
    }
    if (inputs.staleKeys.has(k)) {
      stale += 1;
      issue = true;
    }
    if (w.active && w.health?.status === 'idle') {
      activeNoExec += 1;
      issue = true;
    }
    if (inputs.personalSpaceCriticalKeys.has(k)) issue = true;
    if (issue) issueKeys.add(k);
  }
  const inputsCounts = {
    total,
    brokenRefs,
    staleEnrichment: stale,
    activeNoExecutions: activeNoExec,
    personalSpaceCritical: inputs.personalSpaceCriticalKeys.size,
    issueWorkflows: issueKeys.size,
  };
  if (total === 0) {
    return pillar('hygiene', null, 'No workflows to score hygiene on.', inputsCounts);
  }
  const score = round1((1 - issueKeys.size / total) * 100);
  const reason =
    issueKeys.size === 0
      ? 'No hygiene issues (broken refs, stale analysis, idle-active, personal-space-critical).'
      : `${issueKeys.size} of ${total} workflows have a hygiene issue (broken refs, stale analysis, idle-active, personal-space-critical).`;
  return pillar('hygiene', score, reason, inputsCounts);
}

function exposurePillar(inputs: ScoreInputs): ScorePillar {
  const mcpExposed = inputs.exposure.length;
  let reachingSensitive = 0;
  let reachingSensitiveUnowned = 0;
  let penalty = 0;
  for (const e of inputs.exposure) {
    if (!e.reachesSensitive) continue;
    reachingSensitive += 1;
    if (e.owned) penalty += 0.5;
    else {
      reachingSensitiveUnowned += 1;
      penalty += 1;
    }
  }
  const inputsCounts = { mcpExposed, reachingSensitive, reachingSensitiveUnowned };
  // Zero MCP-exposed workflows is a MEASURED input (no external exposure) → an
  // honest 100, not a laundered one. So this pillar is always scored.
  if (mcpExposed === 0) {
    return pillar('exposure', 100, 'No MCP-exposed workflows — no external exposure surface.', inputsCounts);
  }
  const score = round1((1 - penalty / mcpExposed) * 100);
  const reason =
    reachingSensitive === 0
      ? `${mcpExposed} MCP-exposed workflows, none reaching a sensitive system (confirmed reach).`
      : `${reachingSensitive} of ${mcpExposed} MCP-exposed workflows reach a sensitive system (${reachingSensitiveUnowned} of them unowned), confirmed reach only.`;
  return pillar('exposure', score, reason, inputsCounts);
}

function pillar(key: ScorePillarKey, score: number | null, reason: string, inputs: Record<string, number>): ScorePillar {
  return {
    key,
    label: PILLAR_LABELS[key],
    weight: PILLAR_WEIGHTS[key],
    effectiveWeight: 0, // filled in after we know which pillars scored
    score,
    scored: score != null,
    reason,
    inputs,
  };
}

/** Compose the estate governance score from already-derived inputs. Pure + deterministic. */
export function computeGovernanceScore(inputs: ScoreInputs): GovernanceScore {
  const pillars: ScorePillar[] = [
    ownershipPillar(inputs),
    reliabilityPillar(inputs),
    resiliencePillar(inputs),
    hygienePillar(inputs),
    exposurePillar(inputs),
  ];

  // Redistribute weight across only the pillars that could be scored.
  const scored = pillars.filter((p) => p.scored);
  const scoredWeight = scored.reduce((sum, p) => sum + p.weight, 0);
  for (const p of pillars) {
    p.effectiveWeight = p.scored && scoredWeight > 0 ? p.weight / scoredWeight : 0;
  }

  const score =
    scoredWeight > 0 ? round1(scored.reduce((sum, p) => sum + (p.score ?? 0) * (p.weight / scoredWeight), 0)) : null;

  return { score, pillars };
}
