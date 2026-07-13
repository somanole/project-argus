import type { N8nExecution, WorkflowRun, ExecutionFailure, SilentFailures } from '@argus/shared';
import { aggregateSilentFailures, type InspectedRun, type SwallowedError } from './silent.js';

/** The slice of the n8n client the drawer's on-demand debug needs — injectable for tests. */
export interface ExecutionDebugReader {
  recentExecutions(opts: { workflowId: string; limit?: number }): Promise<N8nExecution[]>;
  executionDebug(executionId: string): Promise<{ failedNode: string | null; errorType: string | null; errorCode: string | null } | null>;
  /** S6.3 Layer 2 — allowlisted swallowed-node errors for ONE execution (optional). */
  executionSilentFailures?(executionId: string): Promise<SwallowedError[] | null>;
}

const FAILURE_STATUSES = new Set(['error', 'crashed']);
const SUCCESS_STATUS = 'success';

/** n8n's per-execution UI deep link (contracts/n8n-18 / VIEWS.EXECUTION_PREVIEW). */
function runDeepLink(baseUrl: string, workflowId: string, executionId: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base ? `${base}/workflow/${workflowId}/executions/${executionId}` : '';
}

function durationMs(e: N8nExecution): number | null {
  if (!e.startedAt || !e.stoppedAt) return null;
  const ms = Date.parse(e.stoppedAt) - Date.parse(e.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export interface WorkflowExecutionsResult {
  runs: WorkflowRun[];
  failure: ExecutionFailure | null;
  /** S6.3 Layer 2 — live silently-failing signal for the fetched success runs (null when none). */
  silentFailures: SilentFailures | null;
  unavailable: boolean;
  unavailableReason: string | null;
}

/**
 * The drawer's on-demand debug view for one workflow: the recent runs (metadata +
 * per-run n8n deep link) and a REDACTED summary of the most recent failed run (failing
 * node + error type/code only — n8n strips the message/payload server-side). Never
 * throws; on a fetch failure it reports `unavailable` with a reason (rule 5), so the
 * drawer degrades honestly instead of showing an empty run list.
 */
export async function fetchWorkflowExecutions(
  reader: ExecutionDebugReader,
  opts: { baseUrl: string; workflowId: string; limit?: number; reasonForError?: (err: unknown) => string },
): Promise<WorkflowExecutionsResult> {
  try {
    const execs = await reader.recentExecutions({ workflowId: opts.workflowId, limit: opts.limit ?? 10 });
    const runs: WorkflowRun[] = execs.map((e) => ({
      executionId: e.id,
      status: e.status,
      startedAt: e.startedAt ?? null,
      stoppedAt: e.stoppedAt ?? null,
      mode: e.mode ?? null,
      durationMs: durationMs(e),
      deepLink: runDeepLink(opts.baseUrl, opts.workflowId, e.id),
    }));

    const failed = execs.find((e) => FAILURE_STATUSES.has(e.status));
    let failure: ExecutionFailure | null = null;
    if (failed) {
      const dbg = await reader.executionDebug(failed.id);
      failure = {
        executionId: failed.id,
        failedNode: dbg?.failedNode ?? null,
        errorType: dbg?.errorType ?? null,
        errorCode: dbg?.errorCode ?? null,
        deepLink: runDeepLink(opts.baseUrl, opts.workflowId, failed.id),
      };
    }

    // S6.3 Layer 2 (on-demand): inspect the fetched SUCCESS runs for a swallowed node error
    // (un-redacted, allowlisted in the client, never persisted). Live truth for any opened
    // workflow — including those outside the poll's can-mask scope. Best-effort: a detail
    // read that fails is simply not counted (rule 5), never a fabricated "clean".
    let silentFailures: SilentFailures | null = null;
    if (reader.executionSilentFailures) {
      const inspected: InspectedRun[] = [];
      for (const e of execs) {
        if (e.status !== SUCCESS_STATUS) continue;
        const swallowed = await reader.executionSilentFailures(e.id);
        if (swallowed === null) continue;
        inspected.push({ startedAt: e.startedAt ?? null, swallowed });
      }
      if (inspected.length > 0) {
        const agg = aggregateSilentFailures(inspected);
        if (agg.runsAffected > 0) silentFailures = agg;
      }
    }

    return { runs, failure, silentFailures, unavailable: false, unavailableReason: null };
  } catch (err) {
    const reason = opts.reasonForError ? opts.reasonForError(err) : (err as Error).message;
    return { runs: [], failure: null, silentFailures: null, unavailable: true, unavailableReason: reason };
  }
}
