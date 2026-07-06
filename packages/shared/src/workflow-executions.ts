import { z } from 'zod';

/**
 * The S3 on-demand execution debug contract (server ↔ web). Fetched only when a user
 * opens a workflow's drawer — never on the health poll, never persisted. Recent runs
 * carry metadata Argus is already allowed to see (status/time/duration/mode) plus a
 * deep link to that exact run in n8n, where the full logs live. The failure summary is
 * the SERVER-SIDE-REDACTED classification of the most recent failed run: the failing
 * node's name + the error type/code only — never the error message or any payload
 * (contracts/n8n-18). Data-minimization stays intact: on-demand, redacted, allowlisted.
 */
export const workflowRunSchema = z.object({
  executionId: z.string(),
  status: z.string(),
  startedAt: z.string().datetime().nullable(),
  stoppedAt: z.string().datetime().nullable(),
  mode: z.string().nullable(),
  /** stoppedAt − startedAt in ms; null when unmeasurable (running/waiting). */
  durationMs: z.number().int().min(0).nullable(),
  /** Opens this exact run in n8n (/workflow/{id}/executions/{execId}). */
  deepLink: z.string(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const executionFailureSchema = z.object({
  executionId: z.string(),
  /** The node n8n reported as failing (lastNodeExecuted), or null. */
  failedNode: z.string().nullable(),
  /** Redacted error classification, e.g. "NodeApiError" — never the message. */
  errorType: z.string().nullable(),
  /** Redacted error code, e.g. "ECONNREFUSED" — never the message. */
  errorCode: z.string().nullable(),
  deepLink: z.string(),
});
export type ExecutionFailure = z.infer<typeof executionFailureSchema>;

export const workflowExecutionsResponseSchema = z.object({
  /** Most-recent runs first (metadata only, no payloads). */
  runs: z.array(workflowRunSchema),
  /** Redacted summary of the most recent FAILED run, or null when none recently. */
  failure: executionFailureSchema.nullable(),
  /** True when executions couldn't be read (missing scope / error) — honest, not empty. */
  unavailable: z.boolean(),
  /** Reason when unavailable. */
  unavailableReason: z.string().nullable(),
  generatedAt: z.string().datetime(),
});
export type WorkflowExecutionsResponse = z.infer<typeof workflowExecutionsResponseSchema>;
