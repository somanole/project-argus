import type Database from 'better-sqlite3';
import type { WorkflowListItem } from '@argus/shared';

/**
 * Data access for the disposable `workflows` cache. This is rebuildable from
 * n8n at any time, so no audit trail and no sacred-table rules apply here.
 */

/** A normalized workflow ready to be written to the cache for one instance. */
export interface CacheWorkflow {
  id: string;
  name: string;
  active: boolean;
  isArchived: boolean;
  projectId: string | null;
  projectName: string | null;
  updatedAt: string | null;
  versionId: string | null;
}

interface WorkflowRow {
  instance_id: string;
  instance_label: string;
  id: string;
  name: string;
  active: number;
  is_archived: number;
  project_name: string | null;
  updated_at: string | null;
}

/**
 * Replace one instance's cached workflows with exactly `workflows`, in a single
 * transaction. This IS the reconciliation: rows for workflows that vanished are
 * removed, changed rows are overwritten, new rows are inserted — so a full
 * re-list every cycle converges the cache on n8n's truth (handles edit, delete,
 * archive/active flips, and self-heal after downtime).
 */
export function replaceInstanceWorkflows(
  db: Database.Database,
  instanceId: string,
  workflows: CacheWorkflow[],
  syncedAt: string,
): void {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM workflows WHERE instance_id = ?').run(instanceId);
    const insert = db.prepare(
      `INSERT INTO workflows
         (instance_id, id, name, active, is_archived, project_id, project_name, updated_at, version_id, last_synced_at)
       VALUES (@instance_id, @id, @name, @active, @is_archived, @project_id, @project_name, @updated_at, @version_id, @last_synced_at)`,
    );
    for (const w of workflows) {
      insert.run({
        instance_id: instanceId,
        id: w.id,
        name: w.name,
        active: w.active ? 1 : 0,
        is_archived: w.isArchived ? 1 : 0,
        project_id: w.projectId,
        project_name: w.projectName,
        updated_at: w.updatedAt,
        version_id: w.versionId,
        last_synced_at: syncedAt,
      });
    }
  });
  run();
}

export function countByInstance(db: Database.Database, instanceId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM workflows WHERE instance_id = ?').get(instanceId) as { n: number };
  return row.n;
}

/**
 * The estate-wide inventory, joined to connection labels. Optionally filtered to
 * one instance — `instanceId` is a filter, the list is one estate.
 */
export function listWorkflows(db: Database.Database, instanceId?: string): WorkflowListItem[] {
  const base =
    `SELECT w.instance_id, c.label AS instance_label, w.id, w.name, w.active, w.is_archived, w.project_name, w.updated_at
       FROM workflows w
       JOIN connections c ON c.id = w.instance_id`;
  const rows = (
    instanceId
      ? db.prepare(`${base} WHERE w.instance_id = ? ORDER BY c.label, w.name`).all(instanceId)
      : db.prepare(`${base} ORDER BY c.label, w.name`).all()
  ) as WorkflowRow[];
  return rows.map((r) => ({
    instanceId: r.instance_id,
    instanceLabel: r.instance_label,
    id: r.id,
    name: r.name,
    active: r.active === 1,
    isArchived: r.is_archived === 1,
    project: r.project_name,
    updatedAt: r.updated_at,
  }));
}
