import type Database from 'better-sqlite3';
import type { WorkflowListItem, Criticality } from '@argus/shared';
import { listWorkflows } from '../workflows/repo.js';
import { DEFAULT_HEALTH_WINDOW_HOURS } from '../n8n/client.js';
import type { ComputedHealth } from './compute.js';

/**
 * Data access for the disposable `workflow_health` cache (S3). Rebuilt from n8n on
 * each health sync — no audit/sacred rules. Kept separate from the ~30s workflows
 * rebuild so a workflow's health survives inventory resyncs.
 */

/** One computed health row to persist (ComputedHealth + its workflow id + reason). */
export interface HealthRow extends ComputedHealth {
  workflowId: string;
  /** Set only for status='unknown' (executions couldn't be read). */
  unavailableReason?: string | null;
}

/** Replace one instance's health rows atomically (the health equivalent of resync). */
export function replaceInstanceHealth(
  db: Database.Database,
  instanceId: string,
  rows: HealthRow[],
  computedAt: string,
): void {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM workflow_health WHERE instance_id = ?').run(instanceId);
    const ins = db.prepare(
      `INSERT INTO workflow_health
         (instance_id, workflow_id, status, runs_in_window, failures_in_window, failure_rate,
          last_run_at, last_status, avg_duration_ms, window_hours, unavailable_reason, computed_at)
       VALUES (@instance_id, @workflow_id, @status, @runs_in_window, @failures_in_window, @failure_rate,
          @last_run_at, @last_status, @avg_duration_ms, @window_hours, @unavailable_reason, @computed_at)`,
    );
    for (const r of rows) {
      ins.run({
        instance_id: instanceId,
        workflow_id: r.workflowId,
        status: r.status,
        runs_in_window: r.runsInWindow,
        failures_in_window: r.failuresInWindow,
        failure_rate: r.failureRate,
        last_run_at: r.lastRunAt,
        last_status: r.lastStatus,
        avg_duration_ms: r.avgDurationMs,
        window_hours: r.windowHours,
        unavailable_reason: r.unavailableReason ?? null,
        computed_at: computedAt,
      });
    }
  });
  run();
}

/** Every workflow id currently cached for an instance (health covers all of them). */
export function listInstanceWorkflowIds(db: Database.Database, instanceId: string): string[] {
  const rows = db.prepare('SELECT id FROM workflows WHERE instance_id = ?').all(instanceId) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Mark every workflow in an instance `unknown` with a reason — used when executions
 * couldn't be fetched at all (missing scope / n8n error). Honest, never a green poll
 * (rule 5). Inventory sync is unaffected; only health degrades.
 */
export function markInstanceHealthUnknown(
  db: Database.Database,
  instanceId: string,
  windowHours: number,
  reason: string,
  computedAt: string,
): void {
  const rows: HealthRow[] = listInstanceWorkflowIds(db, instanceId).map((id) => ({
    workflowId: id,
    status: 'unknown',
    failureRate: null,
    runsInWindow: 0,
    failuresInWindow: 0,
    lastRunAt: null,
    lastStatus: null,
    avgDurationMs: null,
    windowHours,
    unavailableReason: reason,
  }));
  replaceInstanceHealth(db, instanceId, rows, computedAt);
}

export interface HealthWindow {
  instanceId: string;
  instanceLabel: string;
  windowHours: number;
  available: boolean;
}

export interface HealthEstate {
  failing: WorkflowListItem[];
  degraded: WorkflowListItem[];
  summary: { failing: number; degraded: number; healthy: number; idle: number; unknown: number };
  windows: HealthWindow[];
}

const CRIT_ORDER: Record<Criticality, number> = { critical: 0, high: 1, medium: 2, low: 3 };
function critRank(w: WorkflowListItem): number {
  const c = w.enrichment?.criticality;
  return c ? CRIT_ORDER[c] : 4; // unlabeled sorts after every labeled level
}

/** Failing/degraded workflows sorted most-critical then most-failing then name. */
function triage(items: WorkflowListItem[]): WorkflowListItem[] {
  return [...items].sort((a, b) => {
    const c = critRank(a) - critRank(b);
    if (c !== 0) return c;
    const fa = a.health?.failureRate ?? 0;
    const fb = b.health?.failureRate ?? 0;
    if (fb !== fa) return fb - fa;
    return a.name.localeCompare(b.name);
  });
}

/** The "what's failing right now" feed: failing then degraded, with summary + windows. */
export function healthEstate(db: Database.Database): HealthEstate {
  const failing = triage(listWorkflows(db, { health: ['failing'] }));
  const degraded = triage(listWorkflows(db, { health: ['degraded'] }));

  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM workflow_health GROUP BY status')
    .all() as { status: string; n: number }[];
  const summary = { failing: 0, degraded: 0, healthy: 0, idle: 0, unknown: 0 };
  for (const c of counts) {
    if (c.status in summary) summary[c.status as keyof typeof summary] = c.n;
  }

  const windowRows = db
    .prepare(
      `SELECT c.id AS instanceId, c.label AS instanceLabel,
              COALESCE(MAX(h.window_hours), ?) AS windowHours,
              COUNT(h.workflow_id) AS total,
              SUM(CASE WHEN h.status = 'unknown' THEN 1 ELSE 0 END) AS unknownCount
         FROM connections c
         LEFT JOIN workflow_health h ON h.instance_id = c.id
         GROUP BY c.id, c.label
         ORDER BY c.label`,
    )
    .all(DEFAULT_HEALTH_WINDOW_HOURS) as {
    instanceId: string;
    instanceLabel: string;
    windowHours: number;
    total: number;
    unknownCount: number;
  }[];
  const windows: HealthWindow[] = windowRows.map((r) => ({
    instanceId: r.instanceId,
    instanceLabel: r.instanceLabel,
    windowHours: r.windowHours,
    // Unavailable only when every computed row is unknown (executions unreadable).
    available: !(r.total > 0 && r.unknownCount === r.total),
  }));

  return { failing, degraded, summary, windows };
}
