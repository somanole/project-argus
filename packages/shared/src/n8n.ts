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
 * One node in a workflow's `nodes` array — the analyzer's input (S1b). Params are
 * `passthrough()` and credentials are loose: a param/shape drift must NEVER fail
 * the parse and drop a workflow from inventory. We only pin the handful of fields
 * the analyzer reads; everything else rides through untouched.
 * Contract: contracts/n8n-16-workflow-list-facts-shape.json.
 */
export const n8nNodeSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.string(),
    typeVersion: z.number().optional(),
    disabled: z.boolean().optional(),
    webhookId: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional().default({}),
    /** credential-type-name → { id, name }. Loose: unresolved ids are null. */
    credentials: z
      .record(z.string(), z.object({ id: z.string().nullable().optional(), name: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();
export type N8nNode = z.infer<typeof n8nNodeSchema>;

/** Workflow-level settings the analyzer reads (rule-1 verified in n8n-16). */
export const n8nWorkflowSettingsSchema = z
  .object({
    errorWorkflow: z.string().optional(),
    availableInMCP: z.boolean().optional(),
    callerPolicy: z.string().optional(),
    callerIds: z.string().optional(),
  })
  .passthrough();

/**
 * A workflow as it appears in the LIST response. Carries the `shared` owner link
 * (projectId) but NOT the nested `project` object (resolve the name via /projects).
 *
 * S1b: the list item ALSO carries the full node graph inline — node facts come from
 * the TOP-LEVEL `nodes` array (always present), NOT `activeVersion` (null for every
 * non-active workflow — see contracts/n8n-16). All S1b fields are optional/defaulted
 * so a shape change degrades a workflow to "not analyzed", never drops it.
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
  // S1b analyzer input:
  nodes: z.array(n8nNodeSchema).optional(),
  connections: z.record(z.string(), z.unknown()).optional(),
  settings: n8nWorkflowSettingsSchema.optional(),
  triggerCount: z.number().optional(),
  tags: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()).optional().default([]),
});
export type N8nWorkflowListItem = z.infer<typeof n8nWorkflowListItemSchema>;

/**
 * One entry in GET /api/v1/executions — the S3 health source (contracts/n8n-17).
 * `status` is the health signal (NOT `finished`: an errored run reports
 * `finished:false`). Fetched WITHOUT `includeData` + WITH `redactExecutionData=true`,
 * so no execution payloads ride along. `startedAt`/`stoppedAt` are nullable for
 * running/waiting runs → duration is unmeasurable there (never fabricated).
 */
export const n8nExecutionSchema = z.object({
  id: z.string(),
  status: z.string(),
  workflowId: z.string(),
  startedAt: z.string().nullish(),
  stoppedAt: z.string().nullish(),
  finished: z.boolean().optional(),
  mode: z.string().optional(),
});
export type N8nExecution = z.infer<typeof n8nExecutionSchema>;

/**
 * A project as it appears in GET /api/v1/projects (contracts/n8n-03). `type` is
 * `personal` | `team`; a personal project's `name` embeds the human ("First Last
 * <email>"); `creatorId` links to the user roster — both used for S4 ownership
 * inference. `creatorId` is optional so a shape drift never drops a project.
 */
export const n8nProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  creatorId: z.string().nullish(),
});
export type N8nProject = z.infer<typeof n8nProjectSchema>;

/**
 * One member of a team project — GET /api/v1/projects/{id}/users (contracts/n8n-19).
 * `role` is the per-project role slug (project:admin | project:editor | project:viewer),
 * the S4 team-inference signal. Requires the instance licensed for project roles + the
 * key's `user:list` scope; otherwise the endpoint 401/403s and inference degrades honestly.
 */
export const n8nProjectMemberSchema = z.object({
  id: z.string(),
  email: z.string(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  role: z.string().nullable(),
});
export type N8nProjectMember = z.infer<typeof n8nProjectMemberSchema>;

/**
 * One user from GET /api/v1/users?includeRole=true (contracts/n8n-04) — resolves a
 * personal project's `creatorId` to a person and populates the assign-owner picker.
 * `role` here is the GLOBAL role (global:admin/member/owner/…), not a project role.
 */
export const n8nUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  role: z.string().nullish(),
});
export type N8nUser = z.infer<typeof n8nUserSchema>;

/** The cursor-paginated envelope both list endpoints share. */
export const n8nWorkflowListResponseSchema = z.object({
  data: z.array(n8nWorkflowListItemSchema),
  nextCursor: z.string().nullish(),
});

export const n8nProjectListResponseSchema = z.object({
  data: z.array(n8nProjectSchema),
  nextCursor: z.string().nullish(),
});

export const n8nProjectMemberListResponseSchema = z.object({
  data: z.array(n8nProjectMemberSchema),
  nextCursor: z.string().nullish(),
});

export const n8nUserListResponseSchema = z.object({
  data: z.array(n8nUserSchema),
  nextCursor: z.string().nullish(),
});
