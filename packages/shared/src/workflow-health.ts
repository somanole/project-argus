import { z } from 'zod';

/**
 * The S3 per-workflow health contract (server ↔ web). Health is computed by Argus
 * from n8n's execution history over the retention window, poll-fresh on the
 * reconciliation loop. Statuses are deterministic and honest (PLAN.md §Health):
 *
 *  - `failing`  — runs exist, failure rate > 50%.
 *  - `degraded` — runs exist, failure rate 10–50%.
 *  - `healthy`  — runs exist, failure rate < 10%.
 *  - `idle`     — 0 runs in the retention window ("no runs in the last ~14 days").
 *  - `unknown`  — executions couldn't be fetched (missing scope / error). Never green.
 */
export const workflowHealthStatusSchema = z.enum(['failing', 'degraded', 'healthy', 'idle', 'unknown']);
export type WorkflowHealthStatus = z.infer<typeof workflowHealthStatusSchema>;

/**
 * S6.3 Layer 2 — the DYNAMIC "silently failing" signal: runs n8n marked `success` in which a
 * node actually errored-and-continued (contracts/n8n-23). It is an ORTHOGONAL dimension, NOT a
 * status (a silent-failer's runs read `success`, so its status is `healthy`/`idle`). Computed by
 * fetching un-redacted execution detail for the can-mask-failures workflows and reading an
 * ALLOWLIST of node name + error type/code ONLY — never the message/stack/payload. Phrased
 * factually ("node X errored but the run was marked success, N times"), never a correctness claim.
 *
 * `null` means NOT inspected (the workflow isn't flagged can-mask, or its runs weren't fetched) —
 * honest: absence is "not observed silently failing", never "verified clean" (rule 5).
 */
export const silentFailuresSchema = z.object({
  /** Success runs in the window that had ≥1 swallowed node error (of those inspected). */
  runsAffected: z.number().int().min(0),
  /** How many success runs were actually fetched + inspected — the bounded denominator. */
  runsInspected: z.number().int().min(0),
  /** The offending node from the most recent affected run (allowlisted name), or null. */
  lastNode: z.string().nullable(),
  /** Redacted error class of that node, e.g. "NodeApiError" — never the message. */
  lastErrorType: z.string().nullable(),
  /** Redacted error code, e.g. "ECONNREFUSED" — never the message. */
  lastErrorCode: z.string().nullable(),
  /** Start time of the most recent affected run, or null. */
  lastSeenAt: z.string().datetime().nullable(),
});
export type SilentFailures = z.infer<typeof silentFailuresSchema>;

export const workflowHealthSchema = z.object({
  status: workflowHealthStatusSchema,
  /** failures / runs within the window; null when 0 runs (idle) or unknown. */
  failureRate: z.number().min(0).max(1).nullable(),
  runsInWindow: z.number().int().min(0),
  failuresInWindow: z.number().int().min(0),
  /** Most recent run start time in the window, or null. */
  lastRunAt: z.string().datetime().nullable(),
  /** Status of the most recent run (n8n status string), or null. */
  lastStatus: z.string().nullable(),
  /** Mean (stoppedAt − startedAt) over finished runs; null when unmeasurable (rule 5). */
  avgDurationMs: z.number().int().min(0).nullable(),
  /** The retention horizon this was computed against (n8n default 336h ≈ 14 days). */
  windowHours: z.number().int().positive(),
  /** When Argus last computed this; null only in transient pre-compute states. */
  computedAt: z.string().datetime().nullable(),
  /** For `unknown`: why executions couldn't be read (e.g. missing execution:list). */
  unavailableReason: z.string().nullable(),
  /** S6.3 Layer 2 — the silently-failing dimension; null when not inspected (rule 5). */
  silentFailures: silentFailuresSchema.nullable(),
});
export type WorkflowHealth = z.infer<typeof workflowHealthSchema>;
