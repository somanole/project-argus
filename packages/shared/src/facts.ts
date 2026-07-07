import { z } from 'zod';

/**
 * The deterministic catalog facts (S1b). One contract shared by the server (which
 * computes + stores them at sync time) and the web (which renders them). NO LLM —
 * every field is extracted from the workflow JSON, and anything unrecognized is
 * recorded raw + marked unknown, never guessed (standing rule 5).
 */

/** How a direct-dependency reference resolved. `broken` is emitted ONLY when certain. */
export const refResolutionSchema = z.enum(['resolved', 'broken', 'dynamic', 'unresolved']);
export type RefResolution = z.infer<typeof refResolutionSchema>;

/** Kind of outbound reference. `errorWorkflow` is workflow-level; the rest are nodes. */
export const refKindSchema = z.enum(['subWorkflow', 'toolWorkflow', 'agentTool', 'errorWorkflow']);
export type RefKind = z.infer<typeof refKindSchema>;

/** One outbound direct dependency — a workflow this workflow directly connects to. */
export const directDepSchema = z.object({
  kind: refKindSchema,
  /** Source node (null for the workflow-level errorWorkflow). */
  nodeId: z.string().nullable(),
  nodeName: z.string().nullable(),
  /** How the target was expressed. */
  mode: z.enum(['id', 'name', 'list', 'expression', 'unknown']),
  /** Exactly what n8n stored (an id, a name, or expression text). */
  rawValue: z.string().nullable(),
  /** cachedResultName if present — a DISPLAY hint only, never used to resolve (rule 5). */
  cachedName: z.string().nullable(),
  resolution: refResolutionSchema,
  /** Set only when resolution === 'resolved'. */
  resolvedId: z.string().nullable(),
  /** Target workflow name, filled in pass 2 for resolved refs. */
  resolvedName: z.string().nullable(),
});
export type DirectDep = z.infer<typeof directDepSchema>;

/** An external system the workflow touches, and how we know. */
export const systemFactSchema = z.object({
  /** Normalized display name (e.g. "Salesforce"), or null when unknown. */
  system: z.string().nullable(),
  via: z.enum(['credential', 'node']),
  credentialType: z.string().nullable(),
  nodeType: z.string().nullable(),
  /** false => unmapped; `raw` carries the ground truth so nothing is lost. */
  resolved: z.boolean(),
  raw: z.string(),
});
export type SystemFact = z.infer<typeof systemFactSchema>;

/** A node type used, with how we classified it. Raw type is ALWAYS present. */
export const nodeTypeFactSchema = z.object({
  type: z.string(),
  count: z.number().int(),
  category: z.enum(['trigger', 'action', 'unknown']),
  known: z.boolean(),
});
export type NodeTypeFact = z.infer<typeof nodeTypeFactSchema>;

/** A trigger the workflow uses. */
export const triggerFactSchema = z.object({
  type: z.string(),
  display: z.string().nullable(),
  source: z.enum(['manifest', 'heuristic', 'unknown']),
});
export type TriggerFact = z.infer<typeof triggerFactSchema>;

/** A data-table reference (n8n-nodes-base.dataTable). */
export const dataTableRefSchema = z.object({
  mode: z.string(),
  rawValue: z.string().nullable(),
  cachedName: z.string().nullable(),
  resolved: z.boolean(),
});
export type DataTableRef = z.infer<typeof dataTableRefSchema>;

/**
 * A webhook entry point (n8n-nodes-base.webhook / formTrigger). The `path` is what a
 * cross-workflow HTTP call matches against. Expression-valued paths are unmatchable
 * (never guessed — rule 5). Added in S5 for webhook↔HTTP edge detection.
 */
export const webhookEndpointSchema = z.object({
  nodeName: z.string().nullable(),
  /** The literal webhook path (n8n serves it at /webhook/<path>); null if none/expression. */
  path: z.string().nullable(),
  /** True when the path is an n8n expression → unmatchable, never an edge. */
  isExpression: z.boolean(),
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

/**
 * An outbound HTTP call site (n8n-nodes-base.httpRequest). We parse host + a webhook
 * path from the URL when it is a literal; expression URLs stay unmatchable. Added in
 * S5 for webhook↔HTTP and cross-instance edge detection.
 */
export const httpCallsiteSchema = z.object({
  nodeName: z.string().nullable(),
  rawUrl: z.string().nullable(),
  /** Parsed host (incl. port) when the URL is literal; null otherwise. */
  host: z.string().nullable(),
  /** The webhook path parsed from a /webhook/<path> URL; null when not a webhook-shaped URL. */
  webhookPath: z.string().nullable(),
  /** True when the URL is an n8n expression → unmatchable, never an edge. */
  isExpression: z.boolean(),
});
export type HttpCallsite = z.infer<typeof httpCallsiteSchema>;

/**
 * A credential binding on a node — the estate-unique credential id (S1b captured only
 * the credential TYPE). Drives the confirmed `binds_credential` edge and the
 * `shared_credential` SPOF association. Added in S5.
 */
export const credentialRefSchema = z.object({
  nodeName: z.string().nullable(),
  credentialType: z.string(),
  /** The credential id; null if n8n stored a binding without one. */
  credentialId: z.string().nullable(),
  credentialName: z.string().nullable(),
});
export type CredentialRef = z.infer<typeof credentialRefSchema>;

/** Inward-facing caller policy (who may call this workflow). Stored, not shown here (held for S5). */
export const callerPolicySchema = z.object({
  /** 'workflowsFromSameOwner' | 'workflowsFromAList' | 'any' | 'none' | null. */
  policy: z.string().nullable(),
  /** Parsed from settings.callerIds (comma-separated) — allow-listed caller workflow ids. */
  callerIds: z.array(z.string()),
});
export type CallerPolicy = z.infer<typeof callerPolicySchema>;

/** Why a workflow wasn't fully understood. */
export const coverageGapKindSchema = z.enum([
  'unknownNodeType',
  'dynamicRef',
  'unresolvedRef',
  'unknownCredential',
  'parseAnomaly',
]);
export type CoverageGapKind = z.infer<typeof coverageGapKindSchema>;

export const coverageGapSchema = z.object({
  kind: coverageGapKindSchema,
  detail: z.string(),
});
export type CoverageGap = z.infer<typeof coverageGapSchema>;

/** The full deterministic fact set for one workflow. */
export const workflowFactsSchema = z.object({
  /** Bump when the fact shape changes — forces recompute on next sync. */
  schemaVersion: z.literal(2),
  analyzedAt: z.string(),
  nodeCount: z.number().int(),
  nodeTypes: z.array(nodeTypeFactSchema),
  triggers: z.array(triggerFactSchema),
  /** Our count of trigger nodes. */
  triggerCountDetected: z.number().int(),
  /** n8n's own triggerCount, for a self-audit canary (null if absent). */
  triggerCountReported: z.number().int().nullable(),
  systems: z.array(systemFactSchema),
  credentialTypes: z.array(z.string()),
  dataTableRefs: z.array(dataTableRefSchema),
  mcpExposed: z.boolean(),
  directDeps: z.array(directDepSchema),
  /** Cross-workflow endpoint facts (S5): webhook entry points, HTTP call sites, credential bindings. */
  webhookEndpoints: z.array(webhookEndpointSchema),
  httpCallsites: z.array(httpCallsiteSchema),
  credentialRefs: z.array(credentialRefSchema),
  /** Inward-facing; captured now, displayed in S5 (not the outbound drawer). */
  callerPolicy: callerPolicySchema,
  coverage: z.object({
    understood: z.boolean(),
    unknownNodeTypes: z.array(z.string()),
    unresolvedRefs: z.number().int(),
    reasons: z.array(coverageGapSchema),
  }),
});
export type WorkflowFacts = z.infer<typeof workflowFactsSchema>;

/** Estate-wide (and per-instance) coverage roll-up — the trust number. */
export const coverageReportSchema = z.object({
  total: z.number().int(),
  understood: z.number().int(),
  understoodPct: z.number(),
  gapsByKind: z.record(coverageGapKindSchema, z.number().int()),
  /** Ranked long tail: which node types we don't recognize, and how common. */
  unknownNodeTypes: z.array(z.object({ type: z.string(), workflows: z.number().int() })),
  unresolvedRefTotal: z.number().int(),
  /** Reported for transparency; NOT counted against coverage. */
  dynamicRefTotal: z.number().int(),
  /** Certain-broken count (feeds the zero-false-broken trust assertion). */
  brokenRefTotal: z.number().int(),
  perInstance: z.array(
    z.object({
      instanceId: z.string(),
      instanceLabel: z.string(),
      total: z.number().int(),
      understood: z.number().int(),
      understoodPct: z.number(),
    }),
  ),
});
export type CoverageReport = z.infer<typeof coverageReportSchema>;
