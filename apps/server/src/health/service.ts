import type Database from 'better-sqlite3';
import type { N8nExecution } from '@argus/shared';
import { computeHealth, emptyAggregate } from './compute.js';
import { aggregateExecutions } from './fetch.js';
import { replaceInstanceHealth, listInstanceWorkflowIds, listCanMaskWorkflowIds, markInstanceHealthUnknown, type HealthRow } from './repo.js';
import { aggregateSilentFailures, type InspectedRun, type SwallowedError } from './silent.js';

/** The slice of the n8n client the health service needs — injectable for tests. */
export interface ExecutionReader {
  listExecutions(opts: { windowMs: number; now?: number }): Promise<N8nExecution[]>;
  /**
   * S6.3 Layer 2 — allowlisted swallowed-node errors for ONE execution (un-redacted read,
   * allowlisted in the client). Optional so status-only health tests need not provide it;
   * when absent, silent-failure detection is skipped (rows keep silentFailures = null).
   */
  executionSilentFailures?(executionId: string): Promise<SwallowedError[] | null>;
}

export interface SyncHealthOptions {
  windowHours: number;
  now?: number;
  /** Turn a fetch error into an honest, human reason (e.g. "missing execution:list"). */
  reasonForError?: (err: unknown) => string;
  /** Max SUCCESS runs to inspect per can-mask workflow (bounds the un-redacted fetch cost). */
  silentInspectLimit?: number;
}

/** Default cap on success-run detail fetches per can-mask workflow (Layer 2 bound). */
const SILENT_INSPECT_LIMIT = 10;
const SUCCESS_STATUS = 'success';

/**
 * Recompute + persist one instance's per-workflow health from its executions. Runs
 * on the reconciliation tick AFTER the workflow cache is refreshed, so every current
 * workflow gets a row (idle when it had no runs). On any fetch failure it marks the
 * whole instance `unknown` with a reason and returns `available:false` — it NEVER
 * throws, so inventory sync is unaffected (rule 5, PLAN §Health).
 */
export async function syncHealth(
  db: Database.Database,
  instanceId: string,
  reader: ExecutionReader,
  opts: SyncHealthOptions,
): Promise<{ available: boolean; reason: string | null }> {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const { windowHours } = opts;
  const windowMs = windowHours * 3600_000;

  try {
    const execs = await reader.listExecutions({ windowMs, now });
    const aggs = aggregateExecutions(execs);
    const rows: HealthRow[] = listInstanceWorkflowIds(db, instanceId).map((id) => ({
      workflowId: id,
      ...computeHealth(aggs.get(id) ?? emptyAggregate(), { windowHours }),
    }));

    // S6.3 Layer 2 — silent-failure detection, scoped to the can-mask-failures workflows
    // (the necessary precondition). Uses the executions we already fetched to find each
    // one's SUCCESS runs, then reads their un-redacted detail (allowlisted in the client).
    // Best-effort: any failure leaves that workflow's silentFailures null (never breaks the
    // freshness loop — rule 5). Skipped entirely when the reader can't read detail.
    if (reader.executionSilentFailures) {
      const limit = opts.silentInspectLimit ?? SILENT_INSPECT_LIMIT;
      const canMask = new Set(listCanMaskWorkflowIds(db, instanceId));
      if (canMask.size > 0) {
        // Group each can-mask workflow's SUCCESS runs (newest-first), capped.
        const successRuns = new Map<string, N8nExecution[]>();
        for (const e of execs) {
          if (e.status !== SUCCESS_STATUS || !e.workflowId || !canMask.has(e.workflowId)) continue;
          const list = successRuns.get(e.workflowId) ?? [];
          if (list.length < limit) list.push(e);
          successRuns.set(e.workflowId, list);
        }
        const byId = new Map(rows.map((r) => [r.workflowId, r]));
        for (const [wfId, runs] of successRuns) {
          const row = byId.get(wfId);
          if (!row) continue;
          try {
            const inspected: InspectedRun[] = [];
            for (const run of runs) {
              const swallowed = await reader.executionSilentFailures(run.id);
              if (swallowed === null) continue; // detail unreadable → don't count as inspected
              inspected.push({ startedAt: run.startedAt ?? null, swallowed });
            }
            if (inspected.length > 0) row.silentFailures = aggregateSilentFailures(inspected);
          } catch {
            row.silentFailures = null; // honest: not inspected, never "clean"
          }
        }
      }
    }

    replaceInstanceHealth(db, instanceId, rows, nowIso);
    return { available: true, reason: null };
  } catch (err) {
    const reason = opts.reasonForError ? opts.reasonForError(err) : (err as Error).message;
    markInstanceHealthUnknown(db, instanceId, windowHours, reason, nowIso);
    return { available: false, reason };
  }
}
