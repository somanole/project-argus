import { z } from 'zod';
import { workflowFactsSchema, coverageReportSchema } from './facts.js';
import { workflowEnrichmentSchema } from './enrichment.js';
import { workflowHealthSchema } from './workflow-health.js';
import { workflowOwnerSchema, type WorkflowOwner } from './ownership.js';

/**
 * The estate-wide workflow inventory contract (server ↔ web). One flat list
 * across every connection; `instanceId` is a filter attribute, not a partition
 * (PLAN.md — estate-wide from day one). S1b enriches each item with the catalog
 * facts the table renders without a detail fetch (systems, triggers, MCP, coverage).
 */
export const workflowListItemSchema = z.object({
  /** The connection this workflow belongs to (filter attribute). */
  instanceId: z.string(),
  /** The connection's human label, denormalized for display. */
  instanceLabel: z.string(),
  /** n8n workflow id (unique within an instance). */
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  isArchived: z.boolean(),
  /** Owning project name, or null when it couldn't be resolved (rule 5). */
  project: z.string().nullable(),
  /** n8n's last-updated time, or null if absent. */
  updatedAt: z.string().datetime().nullable(),
  // S1b catalog facts (denormalized for the list; null when not yet analyzed):
  /** External systems this workflow touches (resolved display names). */
  systems: z.array(z.string()),
  /** Trigger node types this workflow uses. */
  triggers: z.array(z.string()),
  /** Published to n8n's MCP server. */
  mcpExposed: z.boolean(),
  nodeCount: z.number().int().nullable(),
  /** Whether the analyzer fully understood this workflow (null = not analyzed). */
  understood: z.boolean().nullable(),
  /** Count of certain-broken outbound references. */
  brokenRefCount: z.number().int(),
  /** S6.3 Layer 1 — advisory: a node is configured so a failure could be swallowed (from facts). */
  canMaskFailures: z.boolean(),
  // S2 sense-making layer (null when enrichment is off / not yet run for this workflow):
  /** LLM summary + category + criticality-with-reason + risk flags, with honest status. */
  enrichment: workflowEnrichmentSchema.nullable(),
  // S3 health layer (null when health hasn't been computed yet for this workflow):
  /** Argus-computed execution health with honest status + freshness (poll-fresh). */
  health: workflowHealthSchema.nullable(),
  // S4 ownership layer (null before ownership has ever been resolved for this workflow):
  /** The resolved owner — assigned (authoritative) over inferred (advisory) over unowned. */
  owner: workflowOwnerSchema.nullable(),
});
export type WorkflowListItem = z.infer<typeof workflowListItemSchema>;

/**
 * Does a workflow match a free-text search? Matches the workflow NAME or its resolved
 * (assigned-over-inferred) OWNER — name or email — so flows can be found by who owns them.
 * A blank query matches everything. Used by the Health + Ownership searches; the Explore
 * catalog mirrors this precedence in SQL (buildResolvedOwner: assigned wins, else inferred).
 */
export function workflowMatchesQuery(
  item: { name: string; owner?: WorkflowOwner | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.name.toLowerCase().includes(q)) return true;
  const owner = item.owner?.owner;
  return !!owner && ((owner.name?.toLowerCase().includes(q) ?? false) || (owner.email?.toLowerCase().includes(q) ?? false));
}

/** The filter facets the UI builds chips from (distinct values + counts). */
export const workflowFacetsSchema = z.object({
  systems: z.array(z.object({ value: z.string(), count: z.number().int() })),
  triggers: z.array(z.object({ value: z.string(), label: z.string(), count: z.number().int() })),
  instances: z.array(z.object({ id: z.string(), label: z.string(), count: z.number().int() })),
});
export type WorkflowFacets = z.infer<typeof workflowFacetsSchema>;

export const workflowsResponseSchema = z.object({
  /** One page of the filtered estate (server-side paginated — an estate can have thousands). */
  workflows: z.array(workflowListItemSchema),
  /** Facets across the WHOLE estate (unfiltered), so chips are stable while filtering. */
  facets: workflowFacetsSchema,
  /** Total workflows matching the current filters (across all pages) — the "N match" number. */
  total: z.number().int().nonnegative(),
  /** Page size and the row offset this page started at (echoed back so the client can page). */
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /** When the server built this response (the list is served from cache). */
  generatedAt: z.string().datetime(),
});
export type WorkflowsResponse = z.infer<typeof workflowsResponseSchema>;

/** The detail-drawer payload: enriched item + full facts + n8n deep-link. */
export const workflowDetailSchema = z.object({
  workflow: workflowListItemSchema,
  facts: workflowFactsSchema.nullable(),
  /** Opens this workflow in its instance's n8n editor. */
  deepLink: z.string(),
});
export type WorkflowDetail = z.infer<typeof workflowDetailSchema>;

/** The coverage widget + verify source. */
export const coverageResponseSchema = coverageReportSchema;
export type CoverageResponse = z.infer<typeof coverageReportSchema>;

/**
 * The S3 "what's failing right now" view feed. Every health state as its own list
 * of full list items (so each carries its S2 criticality) — failing/degraded lead,
 * healthy/idle browsable behind their tiles — a summary count of every health state,
 * and the per-instance retention window (shown honestly, and flagged
 * `available: false` when executions couldn't be read for that instance).
 */
export const healthEstateResponseSchema = z.object({
  failing: z.array(workflowListItemSchema),
  degraded: z.array(workflowListItemSchema),
  healthy: z.array(workflowListItemSchema),
  idle: z.array(workflowListItemSchema),
  unknown: z.array(workflowListItemSchema),
  /** S6.3 — workflows observed SILENTLY failing (orthogonal to status: they read green). */
  silentlyFailing: z.array(workflowListItemSchema),
  /** S6.3 — workflows CONFIGURED so a failure could be masked (config-risk, orthogonal to status). */
  canMask: z.array(workflowListItemSchema),
  summary: z.object({
    failing: z.number().int().min(0),
    degraded: z.number().int().min(0),
    healthy: z.number().int().min(0),
    idle: z.number().int().min(0),
    unknown: z.number().int().min(0),
    /** Count of workflows with an observed silent failure (may overlap healthy/idle). */
    silentlyFailing: z.number().int().min(0),
    /** Count of workflows configured to mask failures (may overlap any status). */
    canMask: z.number().int().min(0),
  }),
  windows: z.array(
    z.object({
      instanceId: z.string(),
      instanceLabel: z.string(),
      windowHours: z.number().int().positive(),
      available: z.boolean(),
    }),
  ),
  generatedAt: z.string().datetime(),
});
export type HealthEstateResponse = z.infer<typeof healthEstateResponseSchema>;
