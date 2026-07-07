import { z } from 'zod';

/**
 * The cross-workflow graph contract (S5). One shape shared by the server (which
 * computes edges in an estate-wide pass and serves scoped graph + impact views) and
 * the web (which renders the fleet graph and blast-radius highlight).
 *
 * THE TRUST SPINE (rule 5, Principle 1): every edge carries a `confidence`. Only
 * `confirmed` edges — the ones n8n literally wired — may appear in a factual impact
 * count. `possible` edges (webhook-URL guesses, shared-resource associations) render
 * distinctly and are NEVER counted. A wrong "X depends on Y" is fatal for a
 * governance tool, so this is enforced at the query layer and asserted in verify.
 */

/** Edge kinds. Direction is always source → target = "source depends on / calls / uses target". */
export const edgeTypeSchema = z.enum([
  // confirmed workflow→workflow calls (from S1b resolved direct deps):
  'call', // executeWorkflow sub-workflow call
  'tool', // toolWorkflow call
  'agent_tool', // agentTool call
  'error_workflow', // settings.errorWorkflow
  'caller_policy', // settings.callerIds allow-list (who MAY call the target)
  // webhook↔HTTP matches:
  'webhook_http', // intra-instance HTTP→webhook — POSSIBLE (URL guess)
  'cross_instance_webhook', // A's HTTP → B's webhook (host known) — CONFIRMED
  // resource bindings (workflow→resource) — CONFIRMED:
  'binds_credential',
  'binds_datatable',
  // resource-sharing associations (workflow↔workflow) — POSSIBLE, never counted:
  'shared_credential',
  'shared_datatable',
]);
export type EdgeType = z.infer<typeof edgeTypeSchema>;

export const edgeConfidenceSchema = z.enum(['confirmed', 'possible']);
export type EdgeConfidence = z.infer<typeof edgeConfidenceSchema>;

/** The edge types that count in "what breaks if X fails?" — confirmed call-like edges only. */
export const FAILURE_IMPACT_EDGE_TYPES: EdgeType[] = [
  'call',
  'tool',
  'agent_tool',
  'error_workflow',
  'cross_instance_webhook',
];

/** A graph node is a workflow or a shared resource (credential / data table). */
export const graphNodeKindSchema = z.enum(['workflow', 'credential', 'datatable']);
export type GraphNodeKind = z.infer<typeof graphNodeKindSchema>;

/**
 * A node in the fleet graph. `id` is a self-contained composite
 * (`wf:<instanceId>:<workflowId>` / `cred:<instanceId>:<credId>` /
 * `dt:<instanceId>:<dtId>`) so the client needs no cross-referencing.
 */
export const graphNodeSchema = z.object({
  id: z.string(),
  kind: graphNodeKindSchema,
  instanceId: z.string(),
  instanceLabel: z.string(),
  label: z.string(),
  /** The raw resource id (workflow / credential / datatable id) — for impact queries. */
  resourceId: z.string(),
  /** Workflow-only fields (null for resource nodes). */
  workflowId: z.string().nullable(),
  /** Health status for node coloring (S3); null for resource nodes / unknown. */
  health: z.string().nullable(),
  active: z.boolean().nullable(),
  archived: z.boolean().nullable(),
  isAgent: z.boolean().nullable(),
  brokenRef: z.boolean().nullable(),
  mcpExposed: z.boolean().nullable(),
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

/** A directed edge between two graph nodes, carrying its confidence and a human reason. */
export const graphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(), // node id — depends on target
  target: z.string(), // node id
  type: edgeTypeSchema,
  confidence: edgeConfidenceSchema,
  /** True when source and target live in different instances (the prominent finding). */
  crossInstance: z.boolean(),
  /** Plain-English reason, e.g. "executeWorkflow call" / "HTTP → prod webhook order-intake". */
  reason: z.string(),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphScopeSchema = z.enum(['neighborhood', 'instance', 'system', 'estate']);
export type GraphScope = z.infer<typeof graphScopeSchema>;

/** A scoped slice of the fleet graph for rendering. */
export const dependencyGraphSchema = z.object({
  scope: graphScopeSchema,
  /** The focus node id / instance id / system name, depending on scope; null for estate. */
  focus: z.string().nullable(),
  hops: z.number().int().nullable(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  /** True when the view was clustered/capped for scale (the full fleet is never a raw hairball). */
  truncated: z.boolean(),
  nodeTotal: z.number().int(),
  generatedAt: z.string(),
});
export type DependencyGraph = z.infer<typeof dependencyGraphSchema>;

/** Impact analysis modes — each traverses a DIFFERENT set of edge types. */
export const impactModeSchema = z.enum(['failure', 'credential_rotation', 'deprecate']);
export type ImpactMode = z.infer<typeof impactModeSchema>;

export const impactedWorkflowSchema = z.object({
  instanceId: z.string(),
  instanceLabel: z.string(),
  workflowId: z.string(),
  name: z.string(),
  /** BFS distance from the focus (1 = direct dependent). */
  hops: z.number().int(),
});
export type ImpactedWorkflow = z.infer<typeof impactedWorkflowSchema>;

/**
 * A complete, honest impact answer. `total` counts CONFIRMED edges only;
 * `possibleExcluded` reports how many possible edges were deliberately ignored, so
 * the honesty is visible, not hidden.
 */
export const impactResultSchema = z.object({
  mode: impactModeSchema,
  focusKind: graphNodeKindSchema,
  focusInstanceId: z.string(),
  focusId: z.string(),
  focusLabel: z.string(),
  edgeTypesTraversed: z.array(edgeTypeSchema),
  affected: z.array(impactedWorkflowSchema),
  total: z.number().int(),
  /** Possible edges touching the focus that were NOT counted (transparency). */
  possibleExcluded: z.number().int(),
  /** The plain-English headline, e.g. "5 affected, nothing else." */
  statement: z.string(),
  generatedAt: z.string(),
});
export type ImpactResult = z.infer<typeof impactResultSchema>;

/**
 * MCP exposure-reach: what an external caller can touch THROUGH an MCP-exposed
 * workflow (forward reachability). Feeds the "highlight MCP exposure" graph mode and
 * the S4 mcp_exposed_sensitive signal.
 */
export const mcpReachSchema = z.object({
  instanceId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  /** Sub-workflows reachable via confirmed call edges. */
  reachableWorkflows: z.array(impactedWorkflowSchema),
  /** External systems reachable (from this workflow and everything it can call). */
  reachableSystems: z.array(z.string()),
  /** Credential display names reachable. */
  reachableCredentials: z.array(z.string()),
  /** True when any reachable system/credential is sensitive (payments / CRM / prod DB). */
  reachesSensitive: z.boolean(),
  generatedAt: z.string(),
});
export type McpReach = z.infer<typeof mcpReachSchema>;
