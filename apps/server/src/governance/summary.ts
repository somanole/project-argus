import type Database from 'better-sqlite3';
import type {
  GovernanceOverviewResponse,
  WorkflowListItem,
  UnownedByCriticality,
  ExposureSurface,
} from '@argus/shared';
import { listWorkflows } from '../workflows/repo.js';
import { governanceGaps } from '../ownership/repo.js';
import { healthEstate } from '../health/repo.js';
import { listAudit } from '../audit/read.js';
import { readAllEdges, readGraphWorkflows } from '../graph/repo.js';
import { computeMcpReach, isSensitiveSystem } from '../graph/mcp.js';
import { computeGovernanceScore, wfKey, type ScoreInputs } from './score.js';

/**
 * The S6 governance-overview composer. This is a VIEW LAYER — it re-uses the exact
 * repo reads the individual views call (`governanceGaps`, `healthEstate`,
 * `listWorkflows`, `computeMcpReach`, `listAudit`) so a dashboard figure can never
 * diverge from its source view (the non-divergence test guards this). It adds no
 * new analysis; the only computed thing is the deterministic governance score.
 */

const CHANGELOG_LIMIT = 20;

/**
 * Factual ownership = an explicitly ASSIGNED owner (matches score.ts). Inferred
 * ownership is advisory only — a lead for who to confirm, never counted as ownership.
 */
function isOwned(w: WorkflowListItem): boolean {
  return w.owner != null && w.owner.status === 'assigned';
}

function ownerLabel(w: WorkflowListItem): string | null {
  const o = w.owner?.owner;
  return o?.name ?? o?.email ?? null;
}

export function governanceOverview(db: Database.Database, generatedAt: string): GovernanceOverviewResponse {
  // ── The shared source reads (each is exactly what a view calls) ──────────
  const all = listWorkflows(db); // the whole estate, unfiltered
  const gaps = governanceGaps(db);
  const estate = healthEstate(db);
  const changelog = listAudit(db, { limit: CHANGELOG_LIMIT });

  // ── Ownership (S4) ───────────────────────────────────────────────────────
  const byCriticality: UnownedByCriticality = { critical: 0, high: 0, medium: 0, low: 0, none: 0 };
  for (const u of gaps.unowned) {
    if (u.criticality === 'critical') byCriticality.critical += 1;
    else if (u.criticality === 'high') byCriticality.high += 1;
    else if (u.criticality === 'medium') byCriticality.medium += 1;
    else if (u.criticality === 'low') byCriticality.low += 1;
    else byCriticality.none += 1;
  }

  // ── Reliability (S3): the ASSIGNED-owner subset of failing+degraded — the
  // incidents with a real person to page (inferred-only doesn't count as an owner) ─
  const failingWithOwnerList = [...estate.failing, ...estate.degraded].filter(isOwned);

  // ── Hygiene (S1b/S2/S3): derived from the single `all` read ────────────────
  const brokenRefs = all.filter((w) => w.brokenRefCount > 0);
  const staleEnrichment = all.filter((w) => w.enrichment?.status === 'stale');
  const activeNoExecutions = all.filter((w) => w.active && w.health?.status === 'idle');

  // ── Exposure (S5): MCP-exposed surface, confirmed reach only ───────────────
  const mcpWorkflows = all.filter((w) => w.mcpExposed);
  const edges = readAllEdges(db);
  const graphWorkflows = readGraphWorkflows(db);
  const surfaces: ExposureSurface[] = mcpWorkflows.map((w) => {
    const reach = computeMcpReach(edges, graphWorkflows, { instanceId: w.instanceId, workflowId: w.id }, generatedAt);
    const sensitiveSystems = reach.reachableSystems.filter(isSensitiveSystem);
    return {
      instanceId: w.instanceId,
      instanceLabel: w.instanceLabel,
      workflowId: w.id,
      name: w.name,
      owned: isOwned(w),
      ownerLabel: ownerLabel(w),
      reachesSensitive: reach.reachesSensitive,
      sensitiveSystems,
      reachableWorkflows: reach.reachableWorkflows.length,
    };
  });
  const reachingSensitive = surfaces.filter((s) => s.reachesSensitive);

  // ── The score (the one new computation), from already-composed inputs ──────
  // Gap items key on `workflowId`; workflow list items key on `id`.
  const gapKey = (g: { instanceId: string; workflowId: string }) => wfKey({ instanceId: g.instanceId, id: g.workflowId });
  const spofWorkflowKeys = new Set<string>();
  for (const g of gaps.singleOwnerCritical) for (const w of g.workflows) spofWorkflowKeys.add(gapKey(w));
  const noBackupKeys = new Set(gaps.noBackupOwner.map(gapKey));
  const personalSpaceCriticalKeys = new Set(gaps.personalSpaceCritical.map(gapKey));
  const staleKeys = new Set(staleEnrichment.map((w) => wfKey(w)));
  const scoreInputs: ScoreInputs = {
    workflows: all,
    spofWorkflowKeys,
    noBackupKeys,
    personalSpaceCriticalKeys,
    staleKeys,
    exposure: surfaces.map((s) => ({ key: `${s.instanceId}::${s.workflowId}`, owned: s.owned, reachesSensitive: s.reachesSensitive })),
  };
  const score = computeGovernanceScore(scoreInputs);

  return {
    score,
    unowned: {
      total: gaps.unowned.length,
      byCriticality,
      workflows: gaps.unowned,
    },
    spofOwners: gaps.singleOwnerCritical,
    personalSpaceCritical: gaps.personalSpaceCritical,
    noBackupOwner: gaps.noBackupOwner,
    failingWithOwner: { count: failingWithOwnerList.length, workflows: failingWithOwnerList },
    silentlyFailing: { count: estate.silentlyFailing.length, workflows: estate.silentlyFailing },
    hygiene: {
      brokenRefs: { count: brokenRefs.length, workflows: brokenRefs },
      staleEnrichment: { count: staleEnrichment.length, workflows: staleEnrichment },
      activeNoExecutions: { count: activeNoExecutions.length, workflows: activeNoExecutions },
    },
    exposure: {
      mcpExposed: mcpWorkflows.length,
      reachingSensitive: reachingSensitive.length,
      reachingSensitiveUnowned: reachingSensitive.filter((s) => !s.owned).length,
      surfaces,
    },
    changelog,
    health: { summary: estate.summary, windows: estate.windows },
    generatedAt,
  };
}
