import { z } from 'zod';

/**
 * The estate-wide workflow inventory contract (server ↔ web). One flat list
 * across every connection; `instanceId` is a filter attribute, not a partition
 * (PLAN.md — estate-wide from day one).
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
});
export type WorkflowListItem = z.infer<typeof workflowListItemSchema>;

export const workflowsResponseSchema = z.object({
  workflows: z.array(workflowListItemSchema),
  /** When the server built this response (the list is served from cache). */
  generatedAt: z.string().datetime(),
});
export type WorkflowsResponse = z.infer<typeof workflowsResponseSchema>;
