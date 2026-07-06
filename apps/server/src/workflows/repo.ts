import type Database from 'better-sqlite3';
import type { WorkflowListItem, WorkflowFacts } from '@argus/shared';
import type { CoverageEntry } from '../analyzer/index.js';

/**
 * Data access for the disposable `workflows` cache + its S1b facts (facts_json and
 * the normalized workflow_systems / workflow_triggers child tables). All rebuildable
 * from n8n at any time, so no audit trail and no sacred-table rules apply here.
 */

/** A normalized workflow + its computed catalog facts, ready to write to the cache. */
export interface CacheWorkflow {
  id: string;
  name: string;
  active: boolean;
  isArchived: boolean;
  projectId: string | null;
  projectName: string | null;
  updatedAt: string | null;
  versionId: string | null;
  /** S1b: deterministic facts (null when the workflow couldn't be analyzed). */
  facts: WorkflowFacts | null;
}

/** Filters for the estate list — every one is a WHERE, never a partition. */
export interface WorkflowFilters {
  instanceId?: string | undefined;
  active?: boolean | undefined;
  archived?: boolean | undefined;
  mcp?: boolean | undefined;
  /** OR within the facet: touches ANY of these systems. */
  systems?: string[] | undefined;
  /** OR within the facet: uses ANY of these trigger types. */
  triggers?: string[] | undefined;
  q?: string | undefined;
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
  mcp_exposed: number | null;
  node_count: number | null;
  understood: number | null;
  broken_ref_count: number | null;
  systems: string | null; // group_concat, unit-separated
  triggers: string | null;
}

// group_concat separator unlikely to appear in a system/type string.
const SEP = String.fromCharCode(31); // ASCII unit separator — matches char(31) in the SQL below
const splitAgg = (s: string | null): string[] => (s ? s.split(SEP) : []);

/** Distinct, non-null external systems a workflow touches (for the child table + column). */
function workflowSystems(facts: WorkflowFacts): string[] {
  return [...new Set(facts.systems.map((s) => s.system).filter((s): s is string => s != null))];
}
/** Distinct trigger node types (for the child table). */
function workflowTriggerTypes(facts: WorkflowFacts): string[] {
  return [...new Set(facts.triggers.map((t) => t.type))];
}
function brokenRefCount(facts: WorkflowFacts): number {
  return facts.directDeps.filter((d) => d.resolution === 'broken').length;
}

/**
 * Replace one instance's cached workflows — AND their facts + child rows — with
 * exactly `workflows`, in a single transaction. This IS the reconciliation: rows
 * for workflows that vanished are removed, changed rows are overwritten, new rows
 * inserted. facts_json + child tables are derived from the same facts object so they
 * can never drift.
 */
export function replaceInstanceWorkflows(
  db: Database.Database,
  instanceId: string,
  workflows: CacheWorkflow[],
  syncedAt: string,
): void {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM workflows WHERE instance_id = ?').run(instanceId);
    db.prepare('DELETE FROM workflow_systems WHERE instance_id = ?').run(instanceId);
    db.prepare('DELETE FROM workflow_triggers WHERE instance_id = ?').run(instanceId);

    const insertWf = db.prepare(
      `INSERT INTO workflows
         (instance_id, id, name, active, is_archived, project_id, project_name, updated_at, version_id,
          last_synced_at, facts_json, facts_schema_version, mcp_exposed, node_count, understood, broken_ref_count)
       VALUES (@instance_id, @id, @name, @active, @is_archived, @project_id, @project_name, @updated_at, @version_id,
          @last_synced_at, @facts_json, @facts_schema_version, @mcp_exposed, @node_count, @understood, @broken_ref_count)`,
    );
    const insertSystem = db.prepare(
      'INSERT OR IGNORE INTO workflow_systems (instance_id, workflow_id, system) VALUES (?, ?, ?)',
    );
    const insertTrigger = db.prepare(
      'INSERT OR IGNORE INTO workflow_triggers (instance_id, workflow_id, trigger_type) VALUES (?, ?, ?)',
    );

    for (const w of workflows) {
      const f = w.facts;
      insertWf.run({
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
        facts_json: f ? JSON.stringify(f) : null,
        facts_schema_version: f ? f.schemaVersion : null,
        mcp_exposed: f?.mcpExposed ? 1 : 0,
        node_count: f ? f.nodeCount : null,
        understood: f ? (f.coverage.understood ? 1 : 0) : null,
        broken_ref_count: f ? brokenRefCount(f) : 0,
      });
      if (f) {
        for (const system of workflowSystems(f)) insertSystem.run(instanceId, w.id, system);
        for (const type of workflowTriggerTypes(f)) insertTrigger.run(instanceId, w.id, type);
      }
    }
  });
  run();
}

export function countByInstance(db: Database.Database, instanceId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM workflows WHERE instance_id = ?').get(instanceId) as { n: number };
  return row.n;
}

function toListItem(r: WorkflowRow): WorkflowListItem {
  return {
    instanceId: r.instance_id,
    instanceLabel: r.instance_label,
    id: r.id,
    name: r.name,
    active: r.active === 1,
    isArchived: r.is_archived === 1,
    project: r.project_name,
    updatedAt: r.updated_at,
    systems: splitAgg(r.systems),
    triggers: splitAgg(r.triggers),
    mcpExposed: r.mcp_exposed === 1,
    nodeCount: r.node_count,
    understood: r.understood == null ? null : r.understood === 1,
    brokenRefCount: r.broken_ref_count ?? 0,
  };
}

const LIST_SELECT = `
  SELECT w.instance_id, c.label AS instance_label, w.id, w.name, w.active, w.is_archived,
         w.project_name, w.updated_at, w.mcp_exposed, w.node_count, w.understood, w.broken_ref_count,
         (SELECT group_concat(ws.system, char(31)) FROM workflow_systems ws
            WHERE ws.instance_id = w.instance_id AND ws.workflow_id = w.id) AS systems,
         (SELECT group_concat(wt.trigger_type, char(31)) FROM workflow_triggers wt
            WHERE wt.instance_id = w.instance_id AND wt.workflow_id = w.id) AS triggers
    FROM workflows w
    JOIN connections c ON c.id = w.instance_id`;

/**
 * The estate-wide inventory with S1b facts, filtered server-side. `instanceId` is a
 * filter, the list is one estate. Multiple systems/triggers are OR within the facet;
 * different facets AND together (standard faceted search).
 */
export function listWorkflows(db: Database.Database, filters: WorkflowFilters = {}): WorkflowListItem[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.instanceId) {
    where.push('w.instance_id = ?');
    params.push(filters.instanceId);
  }
  if (filters.active !== undefined) {
    where.push('w.active = ?');
    params.push(filters.active ? 1 : 0);
  }
  if (filters.archived !== undefined) {
    where.push('w.is_archived = ?');
    params.push(filters.archived ? 1 : 0);
  }
  if (filters.mcp) {
    where.push('w.mcp_exposed = 1');
  }
  if (filters.systems && filters.systems.length > 0) {
    const placeholders = filters.systems.map(() => '?').join(', ');
    where.push(
      `EXISTS (SELECT 1 FROM workflow_systems ws WHERE ws.instance_id = w.instance_id AND ws.workflow_id = w.id AND ws.system IN (${placeholders}))`,
    );
    params.push(...filters.systems);
  }
  if (filters.triggers && filters.triggers.length > 0) {
    const placeholders = filters.triggers.map(() => '?').join(', ');
    where.push(
      `EXISTS (SELECT 1 FROM workflow_triggers wt WHERE wt.instance_id = w.instance_id AND wt.workflow_id = w.id AND wt.trigger_type IN (${placeholders}))`,
    );
    params.push(...filters.triggers);
  }
  if (filters.q) {
    where.push('w.name LIKE ? ESCAPE \'\\\'');
    params.push(`%${filters.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }

  const sql = `${LIST_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY c.label, w.name`;
  const rows = db.prepare(sql).all(...params) as WorkflowRow[];
  return rows.map(toListItem);
}

/** One workflow's full facts + connection base URL, for the detail drawer. */
export interface WorkflowDetailRow {
  item: WorkflowListItem;
  facts: WorkflowFacts | null;
  baseUrl: string;
}
export function getWorkflowDetail(db: Database.Database, instanceId: string, id: string): WorkflowDetailRow | null {
  const sql = `${LIST_SELECT} WHERE w.instance_id = ? AND w.id = ?`;
  const row = db.prepare(sql).get(instanceId, id) as WorkflowRow | undefined;
  if (!row) return null;
  const factsJson = db
    .prepare('SELECT facts_json FROM workflows WHERE instance_id = ? AND id = ?')
    .get(instanceId, id) as { facts_json: string | null } | undefined;
  const base = db.prepare('SELECT base_url FROM connections WHERE id = ?').get(instanceId) as { base_url: string } | undefined;
  return {
    item: toListItem(row),
    facts: factsJson?.facts_json ? (JSON.parse(factsJson.facts_json) as WorkflowFacts) : null,
    baseUrl: base?.base_url ?? '',
  };
}

/** Estate-wide facets (unfiltered) so the UI's chips stay stable while filtering. */
export interface RawFacets {
  systems: { value: string; count: number }[];
  triggers: { value: string; count: number }[];
  instances: { id: string; label: string; count: number }[];
}
export function facets(db: Database.Database): RawFacets {
  const systems = db
    .prepare('SELECT system AS value, COUNT(*) AS count FROM workflow_systems GROUP BY system ORDER BY count DESC, system')
    .all() as { value: string; count: number }[];
  const triggers = db
    .prepare('SELECT trigger_type AS value, COUNT(*) AS count FROM workflow_triggers GROUP BY trigger_type ORDER BY count DESC, trigger_type')
    .all() as { value: string; count: number }[];
  const instances = db
    .prepare(
      `SELECT w.instance_id AS id, c.label AS label, COUNT(*) AS count
         FROM workflows w JOIN connections c ON c.id = w.instance_id
         GROUP BY w.instance_id, c.label ORDER BY c.label`,
    )
    .all() as { id: string; label: string; count: number }[];
  return { systems, triggers, instances };
}

/** Every workflow's facts (parsed) + its instance label — the coverage-report input. */
export function listCoverageEntries(db: Database.Database): CoverageEntry[] {
  const rows = db
    .prepare(
      `SELECT w.instance_id AS instanceId, c.label AS instanceLabel, w.facts_json AS factsJson
         FROM workflows w JOIN connections c ON c.id = w.instance_id`,
    )
    .all() as { instanceId: string; instanceLabel: string; factsJson: string | null }[];
  return rows.map((r) => ({
    instanceId: r.instanceId,
    instanceLabel: r.instanceLabel,
    facts: r.factsJson ? (JSON.parse(r.factsJson) as WorkflowFacts) : null,
  }));
}
