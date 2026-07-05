import { z } from 'zod';

/**
 * Raw shapes of the n8n **public API** responses Argus's read-only client
 * consumes, captured from a real running instance (standing rule 1):
 *   - workflow LIST → contracts/n8n-15-workflow-list-shape.json
 *   - projects      → contracts/n8n-03-projects-shape.json
 *
 * We validate only the fields the live inventory needs; unknown fields are
 * stripped (zod default), so an n8n upgrade that *adds* fields won't break us.
 * A field we rely on going missing is a loud parse failure — which is what we
 * want (drift fails loudly, standing rule 1).
 */

/** One entry in a workflow's `shared` array — the ownership link to a project. */
export const n8nSharedEntrySchema = z.object({
  role: z.string(),
  projectId: z.string(),
});

/**
 * A workflow as it appears in the LIST response. Note: list items carry the
 * `shared` owner link (projectId) but NOT the nested `project` object — the
 * project *name* is resolved separately via the projects endpoint.
 */
export const n8nWorkflowListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  isArchived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  versionId: z.string().nullable(),
  shared: z.array(n8nSharedEntrySchema).optional().default([]),
});
export type N8nWorkflowListItem = z.infer<typeof n8nWorkflowListItemSchema>;

/** A project as it appears in GET /api/v1/projects. */
export const n8nProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});
export type N8nProject = z.infer<typeof n8nProjectSchema>;

/** The cursor-paginated envelope both list endpoints share. */
export const n8nWorkflowListResponseSchema = z.object({
  data: z.array(n8nWorkflowListItemSchema),
  nextCursor: z.string().nullish(),
});

export const n8nProjectListResponseSchema = z.object({
  data: z.array(n8nProjectSchema),
  nextCursor: z.string().nullish(),
});
