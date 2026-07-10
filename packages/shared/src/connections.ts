import { z } from 'zod';

/**
 * The connections registry contract (server ↔ web). A connection is one n8n
 * instance Argus watches. The registry is a **sacred** table: the stored API
 * key is encrypted at rest and NEVER leaves the server — none of the response
 * shapes below carry it.
 */

/** What the owner submits to register a connection. */
export const connectionInputSchema = z.object({
  /** Human label shown across the estate (e.g. "prod", "staging"). */
  label: z.string().trim().min(1, 'label is required'),
  /** Base URL of the n8n instance, e.g. http://localhost:5678 */
  baseUrl: z.string().trim().url('base URL must be a valid URL'),
  /** A read-only n8n public API key. Write-only: never returned by any route. */
  apiKey: z.string().trim().min(1, 'API key is required'),
  /**
   * Optional public webhook host (used by a later slice for cross-instance URL
   * matching; may differ from the API URL behind a load balancer).
   */
  webhookHost: z.string().trim().url('webhook host must be a valid URL').nullish(),
});
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

/** Live reachability of a connection — honest, never a guess (standing rule 5). */
export const connectionStatusSchema = z.enum(['ok', 'unauthorized', 'unreachable', 'pending']);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/**
 * Analyzer-freshness drift (S6.1). Advisory only — a **coverage nudge**, never a
 * correctness alarm (rule 5): a stale manifest makes the analyzer *incomplete, not
 * wrong*. Anchored on the one signal Argus can verify — node types in real workflows
 * the pinned manifest doesn't recognize — never on an n8n version (unreachable with a
 * read-only API key; see contracts/n8n-21). NEVER counts against any accountability metric.
 */
export const analyzerDriftStatusSchema = z.enum(['current', 'core-drift', 'community-only']);
export type AnalyzerDriftStatus = z.infer<typeof analyzerDriftStatusSchema>;

const driftBucketSchema = z.object({
  /** Distinct unrecognized node types in this bucket. */
  types: z.number().int().nonnegative(),
  /** Workflows on this connection that use ≥1 type in this bucket. */
  workflows: z.number().int().nonnegative(),
});

export const analyzerDriftSchema = z.object({
  /** The n8n version the vendored manifest was built for — the only version Argus knows for certain. */
  manifestN8nVersion: z.string(),
  /**
   * - `current` — no unrecognized node types on this instance.
   * - `core-drift` — ≥1 unrecognized CORE type (n8n-nodes-base.* / @n8n/n8n-nodes-langchain.*):
   *   the instance likely runs a newer n8n than the manifest → regenerate.
   * - `community-only` — unrecognized types exist but are ALL community/custom → a rebuild
   *   won't add them (not a regenerate case). `core-drift` wins when both are present.
   */
  status: analyzerDriftStatusSchema,
  /** Unrecognized CORE node types — the stale-manifest signal. */
  coreUnknown: driftBucketSchema,
  /** Unrecognized community/custom node types — a manifest rebuild won't add them. */
  communityUnknown: driftBucketSchema,
  /** The ACTUAL unrecognized CORE type names (capped for display; `coreUnknown.types` is the total). */
  coreExamples: z.array(z.string()),
  /** The ACTUAL unrecognized community/custom type names (capped; `communityUnknown.types` is the total). */
  communityExamples: z.array(z.string()),
});
export type AnalyzerDrift = z.infer<typeof analyzerDriftSchema>;

export const connectionHealthSchema = z.object({
  status: connectionStatusSchema,
  /** ISO time of the last successful sync, or null if it has never synced. */
  lastSyncedAt: z.string().datetime().nullable(),
  /** Plain-English reason when not ok, or null. */
  lastError: z.string().nullable(),
  /** Workflows currently cached for this connection. */
  workflowCount: z.number().int().nonnegative(),
  /** Analyzer-freshness drift (S6.1); null until the first successful sync. Advisory. */
  analyzerDrift: analyzerDriftSchema.nullable(),
});
export type ConnectionHealth = z.infer<typeof connectionHealthSchema>;

/** A connection as returned to the client — no API key, ever. */
export const connectionSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  webhookHost: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  health: connectionHealthSchema,
});
export type Connection = z.infer<typeof connectionSchema>;

export const connectionsResponseSchema = z.object({
  connections: z.array(connectionSchema),
});
export type ConnectionsResponse = z.infer<typeof connectionsResponseSchema>;

export const connectionResponseSchema = z.object({
  connection: connectionSchema,
});
export type ConnectionResponse = z.infer<typeof connectionResponseSchema>;
