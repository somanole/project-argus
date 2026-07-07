import { z } from 'zod';
import { workflowListItemSchema } from './workflows.js';
import {
  unownedWorkflowSchema,
  singleOwnerCriticalGapSchema,
  personalSpaceCriticalGapSchema,
  noBackupOwnerGapSchema,
  auditTimelineEntrySchema,
} from './ownership.js';

/**
 * The S6 governance-overview contract (server ↔ web, spec
 * .agents/specs/governance-overview.md). This slice CLOSES THE CORE: one screen
 * that composes ownership (S4), health (S3), criticality (S2), gaps (S4), graph
 * exposure (S5) into "here's the state of our estate".
 *
 * The discipline of the slice — **composition, never divergence**. Every figure
 * below is sourced from the SAME repo read the individual view calls
 * (`governanceGaps`, `healthEstate`, `listWorkflows`, `computeMcpReach`,
 * `listAudit`); a number here is byte-for-byte the number that view shows, and a
 * drilled workflow set is exactly the query result behind its count. The one new
 * computation is the governance score — deterministic, explainable, and honest
 * about the estate's built-in uncertainty (rule 5).
 */

// ── The governance score (the one new computation) ──────────────────────────

/** The five explainable pillars the estate score is a weighted average of. */
export const scorePillarKeySchema = z.enum(['ownership', 'reliability', 'resilience', 'hygiene', 'exposure']);
export type ScorePillarKey = z.infer<typeof scorePillarKeySchema>;

/**
 * One pillar's contribution — never a black box. `score` is 0–100 (higher is
 * better); `scored:false` (score null) means the pillar had NO measurable inputs
 * (e.g. health entirely unavailable) so it is dropped from the average and its
 * weight redistributed — never silently counted as 100 (rule 5). `inputs` carries
 * the raw counts that produced the sub-score, so it is always auditable/drillable.
 */
export const scorePillarSchema = z.object({
  key: scorePillarKeySchema,
  label: z.string(),
  /** The pillar's fixed nominal weight in the average (0–1), before redistribution. */
  weight: z.number().min(0).max(1),
  /** The weight actually applied after dropping unscored pillars (0 when unscored). */
  effectiveWeight: z.number().min(0).max(1),
  score: z.number().min(0).max(100).nullable(),
  scored: z.boolean(),
  /** Plain-English statement of what drove the sub-score. */
  reason: z.string(),
  /** The raw counts behind the sub-score (explainability + drill). */
  inputs: z.record(z.string(), z.number()),
});
export type ScorePillar = z.infer<typeof scorePillarSchema>;

/** The estate governance score + its full pillar breakdown. */
export const governanceScoreSchema = z.object({
  /** Overall 0–100 (weighted average of scored pillars), or null if nothing was scorable. */
  score: z.number().min(0).max(100).nullable(),
  pillars: z.array(scorePillarSchema),
});
export type GovernanceScore = z.infer<typeof governanceScoreSchema>;

// ── Composed figures (each drills to its exact workflows) ───────────────────

/** Unowned split by criticality (the "23 unowned" headline, decomposed). */
export const unownedByCriticalitySchema = z.object({
  critical: z.number().int().min(0),
  high: z.number().int().min(0),
  medium: z.number().int().min(0),
  low: z.number().int().min(0),
  /** Unowned workflows with no criticality label (couldn't analyze). */
  none: z.number().int().min(0),
});
export type UnownedByCriticality = z.infer<typeof unownedByCriticalitySchema>;

/**
 * One MCP-exposure surface: an externally-exposed workflow and what it can reach
 * through CONFIRMED edges only (S5 trust spine — `possible` never counts). `owned`
 * distinguishes an exposed workflow with an answerable owner from an unowned one.
 */
export const exposureSurfaceSchema = z.object({
  instanceId: z.string(),
  instanceLabel: z.string(),
  workflowId: z.string(),
  name: z.string(),
  /** true when the workflow has an answerable (assigned or inferred) owner. */
  owned: z.boolean(),
  ownerLabel: z.string().nullable(),
  /** true when its confirmed forward reach touches a sensitive system. */
  reachesSensitive: z.boolean(),
  /** The sensitive systems in reach (confirmed-only). */
  sensitiveSystems: z.array(z.string()),
  /** How many downstream workflows it can reach (confirmed-only). */
  reachableWorkflows: z.number().int().min(0),
});
export type ExposureSurface = z.infer<typeof exposureSurfaceSchema>;

/** A count + the exact workflow set behind it (the drill contract, made uniform). */
export const overviewFigureSchema = z.object({
  count: z.number().int().min(0),
  workflows: z.array(workflowListItemSchema),
});
export type OverviewFigure = z.infer<typeof overviewFigureSchema>;

/**
 * The whole S6 governance-overview payload. Pure composition of existing reads;
 * `generatedAt` + the health windows carry freshness so staleness is visible.
 */
export const governanceOverviewResponseSchema = z.object({
  score: governanceScoreSchema,

  // Ownership (S4) — sourced from governanceGaps().
  unowned: z.object({
    total: z.number().int().min(0),
    byCriticality: unownedByCriticalitySchema,
    /** The exact unowned set (each carries its advisory inferred owner). */
    workflows: z.array(unownedWorkflowSchema),
  }),
  spofOwners: z.array(singleOwnerCriticalGapSchema),
  personalSpaceCritical: z.array(personalSpaceCriticalGapSchema),
  noBackupOwner: z.array(noBackupOwnerGapSchema),

  // Reliability (S3) — the OWNED subset of failing+degraded (the actionable incidents).
  failingWithOwner: overviewFigureSchema,

  // Hygiene (S1b/S2/S3) — each sub-figure drills to its exact set.
  hygiene: z.object({
    brokenRefs: overviewFigureSchema,
    staleEnrichment: overviewFigureSchema,
    activeNoExecutions: overviewFigureSchema,
  }),

  // Exposure (S5) — MCP-exposed surface, confirmed reach only.
  exposure: z.object({
    mcpExposed: z.number().int().min(0),
    reachingSensitive: z.number().int().min(0),
    reachingSensitiveUnowned: z.number().int().min(0),
    surfaces: z.array(exposureSurfaceSchema),
  }),

  // Changelog — the recent estate changes from the sacred append-only audit log.
  changelog: z.array(auditTimelineEntrySchema),

  // Freshness / context (drives the reliability pillar + honest "unavailable" display).
  health: z.object({
    summary: z.object({
      failing: z.number().int().min(0),
      degraded: z.number().int().min(0),
      healthy: z.number().int().min(0),
      idle: z.number().int().min(0),
      unknown: z.number().int().min(0),
    }),
    windows: z.array(
      z.object({
        instanceId: z.string(),
        instanceLabel: z.string(),
        windowHours: z.number().int().positive(),
        available: z.boolean(),
      }),
    ),
  }),

  generatedAt: z.string().datetime(),
});
export type GovernanceOverviewResponse = z.infer<typeof governanceOverviewResponseSchema>;
