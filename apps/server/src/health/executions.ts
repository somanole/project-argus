import type { N8nExecution, WorkflowRun, ExecutionFailure } from '@argus/shared';

/** The slice of the n8n client the drawer's on-demand debug needs — injectable for tests. */
export interface ExecutionDebugReader {
  recentExecutions(opts: { workflowId: string; limit?: number }): Promise<N8nExecution[]>;
  executionDebug(executionId: string): Promise<{ failedNode: string | null; errorType: string | null; errorCode: string | null } | null>;
}

const FAILURE_STATUSES = new Set(['error', 'crashed']);

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
    return { runs, failure, unavailable: false, unavailableReason: null };
  } catch (err) {
    const reason = opts.reasonForError ? opts.reasonForError(err) : (err as Error).message;
    return { runs: [], failure: null, unavailable: true, unavailableReason: reason };
  }
}
