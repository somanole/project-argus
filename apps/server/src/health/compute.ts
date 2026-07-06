import type { WorkflowHealthStatus } from '@argus/shared';

/**
 * Argus's OWN health thresholds (standing: owned + unit-tested, PLAN §Health).
 * Failure rate = failed terminal runs / all terminal runs within the retention window.
 *  - > 50%  → failing
 *  - 10–50% → degraded
 *  - < 10%  → healthy
 * Boundaries chosen so the seed lands right: Stripe 100% → failing; the two `mixed`
 * 50% → degraded; all-success → healthy.
 */
export const DEGRADED_RATE = 0.1;
export const FAILING_RATE = 0.5;

/** n8n statuses that count as a *failure* (vs a completed run). */
const FAILURE_STATUSES = new Set(['error', 'crashed']);
/** n8n statuses that count as a completed run (the failure-rate denominator). */
const TERMINAL_STATUSES = new Set(['success', 'error', 'crashed', 'canceled']);
/** In-flight statuses excluded from the math entirely (a waiting run is not a failure). */
const IN_FLIGHT_STATUSES = new Set(['running', 'new', 'waiting', 'unknown']);

export { FAILURE_STATUSES, TERMINAL_STATUSES, IN_FLIGHT_STATUSES };

/** Per-workflow rollup of the executions in the window (from fetch.ts). */
export interface HealthAggregate {
  /** Completed (terminal) runs in the window. */
  runs: number;
  /** Failed runs in the window (error/crashed). */
  failures: number;
  /** Most-recent run start time (any status), or null. */
  lastRunAt: string | null;
  /** Status of the most-recent run, or null. */
  lastStatus: string | null;
  /** Mean duration (ms) over runs with both timestamps; null when none measurable. */
  avgDurationMs: number | null;
}

export function emptyAggregate(): HealthAggregate {
  return { runs: 0, failures: 0, lastRunAt: null, lastStatus: null, avgDurationMs: null };
}

export interface ComputedHealth {
  status: WorkflowHealthStatus;
  failureRate: number | null;
  runsInWindow: number;
  failuresInWindow: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  avgDurationMs: number | null;
  windowHours: number;
}

/**
 * Deterministic per-workflow health from its aggregate. `idle` when there were no
 * completed runs in the window (phrased against the horizon by the UI); never a
 * guess. `unknown` is NOT produced here — it's set by the service when executions
 * couldn't be fetched at all.
 */
export function computeHealth(agg: HealthAggregate, opts: { windowHours: number }): ComputedHealth {
  const base = {
    runsInWindow: agg.runs,
    failuresInWindow: agg.failures,
    lastRunAt: agg.lastRunAt,
    lastStatus: agg.lastStatus,
    avgDurationMs: agg.avgDurationMs,
    windowHours: opts.windowHours,
  };
  if (agg.runs === 0) {
    return { ...base, status: 'idle', failureRate: null };
  }
  const failureRate = agg.failures / agg.runs;
  const status: WorkflowHealthStatus =
    failureRate > FAILING_RATE ? 'failing' : failureRate >= DEGRADED_RATE ? 'degraded' : 'healthy';
  return { ...base, status, failureRate };
}
