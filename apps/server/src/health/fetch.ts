import type { N8nExecution } from '@argus/shared';
import { type HealthAggregate, emptyAggregate, FAILURE_STATUSES, TERMINAL_STATUSES } from './compute.js';

/**
 * Roll a flat list of executions (already window-bounded by the client) into a
 * per-workflow aggregate the health computer consumes. In-flight runs (running /
 * waiting / new) contribute only to `lastRunAt`/`lastStatus` recency, never to the
 * failure math. Durations use both timestamps or are skipped (never fabricated).
 */
export function aggregateExecutions(execs: N8nExecution[]): Map<string, HealthAggregate> {
  const byWf = new Map<string, HealthAggregate>();
  // Accumulate durations separately so avg is computed once at the end.
  const durations = new Map<string, number[]>();

  for (const e of execs) {
    let agg = byWf.get(e.workflowId);
    if (!agg) {
      agg = emptyAggregate();
      byWf.set(e.workflowId, agg);
      durations.set(e.workflowId, []);
    }

    if (TERMINAL_STATUSES.has(e.status)) {
      agg.runs += 1;
      if (FAILURE_STATUSES.has(e.status)) agg.failures += 1;
    }

    // Recency: keep the most-recent run's start + status (any status).
    const started = e.startedAt ?? null;
    if (started && (agg.lastRunAt === null || started > agg.lastRunAt)) {
      agg.lastRunAt = started;
      agg.lastStatus = e.status;
    }

    // Duration only when both timestamps exist and are sane.
    if (e.startedAt && e.stoppedAt) {
      const ms = Date.parse(e.stoppedAt) - Date.parse(e.startedAt);
      if (Number.isFinite(ms) && ms >= 0) durations.get(e.workflowId)!.push(ms);
    }
  }

  for (const [wfId, ds] of durations) {
    if (ds.length > 0) {
      const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
      byWf.get(wfId)!.avgDurationMs = Math.round(mean);
    }
  }
  return byWf;
}
