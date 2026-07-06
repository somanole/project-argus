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
});
export type WorkflowHealth = z.infer<typeof workflowHealthSchema>;
