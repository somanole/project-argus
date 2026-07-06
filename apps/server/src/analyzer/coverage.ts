import type { CoverageGapKind, CoverageReport, WorkflowFacts } from '@argus/shared';

/** One workflow's coverage input: its facts (or null when it couldn't be analyzed). */
export interface CoverageEntry {
  instanceId: string;
  instanceLabel: string;
  facts: WorkflowFacts | null;
}

const GAP_KINDS: CoverageGapKind[] = ['unknownNodeType', 'dynamicRef', 'unresolvedRef', 'unknownCredential', 'parseAnomaly'];

/**
 * Aggregate per-workflow facts into the estate coverage report — the trust number.
 * A workflow with null facts ("couldn't analyze") counts against total and is NOT
 * understood, honestly. `dynamic` refs are reported but never counted against
 * coverage; only `unresolved` refs (a real analyzer gap) and unknown node types do.
 */
export function coverageOf(entries: CoverageEntry[]): CoverageReport {
  const total = entries.length;
  let understood = 0;
  let unresolvedRefTotal = 0;
  let dynamicRefTotal = 0;
  let brokenRefTotal = 0;
  const gapsByKind: Record<CoverageGapKind, number> = {
    unknownNodeType: 0,
    dynamicRef: 0,
    unresolvedRef: 0,
    unknownCredential: 0,
    parseAnomaly: 0,
  };
  const unknownNodeTypeWorkflows = new Map<string, number>();
  const perInstanceAgg = new Map<string, { instanceLabel: string; total: number; understood: number }>();

  for (const e of entries) {
    const inst = perInstanceAgg.get(e.instanceId) ?? { instanceLabel: e.instanceLabel, total: 0, understood: 0 };
    inst.total += 1;

    if (e.facts && e.facts.coverage.understood) {
      understood += 1;
      inst.understood += 1;
    }
    perInstanceAgg.set(e.instanceId, inst);

    if (!e.facts) {
      // Not analyzed — a real gap, bucketed as a parse anomaly.
      gapsByKind.parseAnomaly += 1;
      continue;
    }

    for (const d of e.facts.directDeps) {
      if (d.resolution === 'unresolved') unresolvedRefTotal += 1;
      if (d.resolution === 'dynamic') dynamicRefTotal += 1;
      if (d.resolution === 'broken') brokenRefTotal += 1;
    }

    // Count each workflow once per gap KIND it exhibits.
    const kindsHit = new Set(e.facts.coverage.reasons.map((r) => r.kind));
    for (const k of kindsHit) gapsByKind[k] += 1;
    for (const t of e.facts.coverage.unknownNodeTypes) {
      unknownNodeTypeWorkflows.set(t, (unknownNodeTypeWorkflows.get(t) ?? 0) + 1);
    }
  }

  const perInstance = [...perInstanceAgg.entries()]
    .map(([instanceId, v]) => ({
      instanceId,
      instanceLabel: v.instanceLabel,
      total: v.total,
      understood: v.understood,
      understoodPct: pct(v.understood, v.total),
    }))
    .sort((a, b) => a.instanceLabel.localeCompare(b.instanceLabel));

  const unknownNodeTypes = [...unknownNodeTypeWorkflows.entries()]
    .map(([type, workflows]) => ({ type, workflows }))
    .sort((a, b) => b.workflows - a.workflows || a.type.localeCompare(b.type));

  // Ensure every gap kind is present (0 default) for a stable shape.
  for (const k of GAP_KINDS) if (!(k in gapsByKind)) gapsByKind[k] = 0;

  return {
    total,
    understood,
    understoodPct: pct(understood, total),
    gapsByKind,
    unknownNodeTypes,
    unresolvedRefTotal,
    dynamicRefTotal,
    brokenRefTotal,
    perInstance,
  };
}

function pct(n: number, d: number): number {
  if (d === 0) return 100;
  return Math.round((n / d) * 1000) / 10; // one decimal place
}
