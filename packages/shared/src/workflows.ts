import { z } from 'zod';
import { workflowFactsSchema, coverageReportSchema } from './facts.js';
import { workflowEnrichmentSchema } from './enrichment.js';

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
  // S2 sense-making layer (null when enrichment is off / not yet run for this workflow):
  /** LLM summary + category + criticality-with-reason + risk flags, with honest status. */
  enrichment: workflowEnrichmentSchema.nullable(),
});
export type WorkflowListItem = z.infer<typeof workflowListItemSchema>;

/** The filter facets the UI builds chips from (distinct values + counts). */
export const workflowFacetsSchema = z.object({
  systems: z.array(z.object({ value: z.string(), count: z.number().int() })),
  triggers: z.array(z.object({ value: z.string(), label: z.string(), count: z.number().int() })),
  instances: z.array(z.object({ id: z.string(), label: z.string(), count: z.number().int() })),
});
export type WorkflowFacets = z.infer<typeof workflowFacetsSchema>;

export const workflowsResponseSchema = z.object({
  workflows: z.array(workflowListItemSchema),
  /** Facets across the WHOLE estate (unfiltered), so chips are stable while filtering. */
  facets: workflowFacetsSchema,
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
