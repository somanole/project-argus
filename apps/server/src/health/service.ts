import type Database from 'better-sqlite3';
import type { N8nExecution } from '@argus/shared';
import { computeHealth, emptyAggregate } from './compute.js';
import { aggregateExecutions } from './fetch.js';
import { replaceInstanceHealth, listInstanceWorkflowIds, markInstanceHealthUnknown, type HealthRow } from './repo.js';

/** The slice of the n8n client the health service needs — injectable for tests. */
export interface ExecutionReader {
  listExecutions(opts: { windowMs: number; now?: number }): Promise<N8nExecution[]>;
}

export interface SyncHealthOptions {
  windowHours: number;
  now?: number;
  /** Turn a fetch error into an honest, human reason (e.g. "missing execution:list"). */
  reasonForError?: (err: unknown) => string;
}

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
    replaceInstanceHealth(db, instanceId, rows, nowIso);
    return { available: true, reason: null };
  } catch (err) {
    const reason = opts.reasonForError ? opts.reasonForError(err) : (err as Error).message;
    markInstanceHealthUnknown(db, instanceId, windowHours, reason, nowIso);
    return { available: false, reason };
  }
}
