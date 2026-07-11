import type Database from 'better-sqlite3';
import type {
  WorkflowListItem,
  WorkflowFacts,
  WorkflowEnrichment,
  WorkflowHealth,
  WorkflowHealthStatus,
  WorkflowOwner,
  EnrichmentOutput,
  EnrichmentCategory,
  Criticality,
} from '@argus/shared';
import type { CoverageEntry } from '../analyzer/index.js';
import type { EnrichmentInput } from '../enrichment/allowlist.js';
import { buildResolvedOwner } from '../ownership/repo.js';

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
  /** S2: the redacted, no-secrets enrichment allowlist + its hash (null when not analyzed). */
  enrichmentInput: EnrichmentInput | null;
  enrichmentInputHash: string | null;
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
  /** OR within the facet: effective criticality is ANY of these (critical/high/medium/low). */
  criticality?: string[] | undefined;
  /** OR within the facet: health status is ANY of these (failing/degraded/healthy/idle/unknown). */
  health?: string[] | undefined;
  /** Only workflows with at least one certain-broken reference. */
  broken?: boolean | undefined;
  /** Only workflows whose stored analysis is stale (enrichment exists but its input hash drifted). */
  stale?: boolean | undefined;
  q?: string | undefined;
  /** Page size — when set, the list is LIMIT/OFFSET paginated (else the full filtered set). */
  limit?: number | undefined;
  /** Rows to skip before the page (pagination). */
  offset?: number | undefined;
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
  // S2 enrichment (LEFT JOIN workflow_enrichments; all null when not enriched):
  enrichment_status: string | null; // 'analyzed' | 'stub'
  enrichment_json: string | null;
  corrected_json: string | null;
  enrichment_provider: string | null;
  enrichment_model: string | null;
  enriched_at: string | null;
  /** 1 when the stored enrichment matches the workflow's current input hash. */
  enrichment_fresh: number | null;
  // S3 health (LEFT JOIN workflow_health; all null when not yet computed):
  health_status: string | null; // failing|degraded|healthy|idle|unknown
  health_runs: number | null;
  health_failures: number | null;
  health_failure_rate: number | null;
  health_last_run_at: string | null;
  health_last_status: string | null;
  health_avg_duration_ms: number | null;
  health_window_hours: number | null;
  health_unavailable_reason: string | null;
  health_computed_at: string | null;
  // S4 ownership (LEFT JOIN workflow_ownership o; all null when unassigned):
  own_owner_email: string | null;
  own_owner_name: string | null;
  own_backup_email: string | null;
  own_backup_name: string | null;
  own_reason: string | null;
  own_assigned_by_name: string | null;
  own_assigned_by_email: string | null;
  own_assigned_at: string | null;
  // S4 inferred owner (LEFT JOIN workflow_inferred_owner io; all null before inference runs):
  inf_owner_email: string | null;
  inf_owner_name: string | null;
  inf_source: string | null;
  inf_member_role: string | null;
  inf_reason: string | null;
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
          last_synced_at, facts_json, facts_schema_version, mcp_exposed, node_count, understood, broken_ref_count,
          enrichment_input_json, enrichment_input_hash)
       VALUES (@instance_id, @id, @name, @active, @is_archived, @project_id, @project_name, @updated_at, @version_id,
          @last_synced_at, @facts_json, @facts_schema_version, @mcp_exposed, @node_count, @understood, @broken_ref_count,
          @enrichment_input_json, @enrichment_input_hash)`,
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
        enrichment_input_json: w.enrichmentInput ? JSON.stringify(w.enrichmentInput) : null,
        enrichment_input_hash: w.enrichmentInputHash ?? null,
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
    enrichment: mapEnrichment(r),
    health: mapHealth(r),
    owner: mapOwner(r),
  };
}

/** Resolve the served owner from the joined row (assigned over inferred over unowned). */
function mapOwner(r: WorkflowRow): WorkflowOwner {
  const a =
    r.own_assigned_at != null
      ? {
          owner_email: r.own_owner_email,
          owner_name: r.own_owner_name,
          backup_owner_email: r.own_backup_email,
          backup_owner_name: r.own_backup_name,
          reason: r.own_reason,
          assigned_by_name: r.own_assigned_by_name,
          assigned_by_email: r.own_assigned_by_email,
          assigned_at: r.own_assigned_at,
        }
      : null;
  const i =
    r.inf_source != null
      ? {
          owner_email: r.inf_owner_email,
          owner_name: r.inf_owner_name,
          source: r.inf_source,
          member_role: r.inf_member_role,
          reason: r.inf_reason,
        }
      : null;
  return buildResolvedOwner(a, i);
}

/** Build the served health from the joined row; null when never computed. */
function mapHealth(r: WorkflowRow): WorkflowHealth | null {
  if (!r.health_status) return null;
  return {
    status: r.health_status as WorkflowHealthStatus,
    failureRate: r.health_failure_rate,
    runsInWindow: r.health_runs ?? 0,
    failuresInWindow: r.health_failures ?? 0,
    lastRunAt: r.health_last_run_at,
    lastStatus: r.health_last_status,
    avgDurationMs: r.health_avg_duration_ms,
    windowHours: r.health_window_hours ?? 336,
    computedAt: r.health_computed_at,
    unavailableReason: r.health_unavailable_reason,
  };
}

/**
 * Build the served enrichment from the joined row. Honest states (rule 5):
 *  - no enrichment row → null (pending / off / not yet run)
 *  - stored input hash ≠ current → 'stale' (last-known shown, flagged)
 *  - status 'stub' → "couldn't analyze": semantic fields stay null, never fabricated
 *  - owner corrections (corrected_json) overlay category/criticality at read time
 */
function mapEnrichment(r: WorkflowRow): WorkflowEnrichment | null {
  if (!r.enrichment_status) return null;
  const fresh = r.enrichment_fresh === 1;
  const provider = r.enrichment_provider ?? '';
  const model = r.enrichment_model ?? '';
  const enrichedAt = r.enriched_at ?? '';

  if (r.enrichment_status === 'stub') {
    return {
      status: fresh ? 'stub' : 'stale',
      provider, model, enrichedAt, corrected: false,
      summary: null, description: null, category: null, criticality: null,
      criticalityReason: null, riskFlags: [], suggestedOwnerRationale: null, businessContext: null,
    };
  }

  const output = r.enrichment_json ? (JSON.parse(r.enrichment_json) as EnrichmentOutput) : null;
  if (!output) return null;
  const corrected = r.corrected_json
    ? (JSON.parse(r.corrected_json) as { category?: EnrichmentCategory; criticality?: Criticality })
    : null;
  return {
    status: fresh ? 'analyzed' : 'stale',
    provider, model, enrichedAt,
    corrected: corrected != null,
    summary: output.summary,
    description: output.description,
    category: corrected?.category ?? output.category,
    criticality: corrected?.criticality ?? output.criticality,
    criticalityReason: output.criticalityReason,
    riskFlags: output.riskFlags,
    suggestedOwnerRationale: output.suggestedOwnerRationale,
    businessContext: output.businessContext,
  };
}

const LIST_SELECT = `
  SELECT w.instance_id, c.label AS instance_label, w.id, w.name, w.active, w.is_archived,
         w.project_name, w.updated_at, w.mcp_exposed, w.node_count, w.understood, w.broken_ref_count,
         (SELECT group_concat(ws.system, char(31)) FROM workflow_systems ws
            WHERE ws.instance_id = w.instance_id AND ws.workflow_id = w.id) AS systems,
         (SELECT group_concat(wt.trigger_type, char(31)) FROM workflow_triggers wt
            WHERE wt.instance_id = w.instance_id AND wt.workflow_id = w.id) AS triggers,
         e.status AS enrichment_status, e.enrichment_json, e.corrected_json,
         e.provider AS enrichment_provider, e.model AS enrichment_model, e.enriched_at,
         CASE WHEN e.input_hash IS NOT NULL AND e.input_hash = w.enrichment_input_hash THEN 1 ELSE 0 END AS enrichment_fresh,
         h.status AS health_status, h.runs_in_window AS health_runs, h.failures_in_window AS health_failures,
         h.failure_rate AS health_failure_rate, h.last_run_at AS health_last_run_at, h.last_status AS health_last_status,
         h.avg_duration_ms AS health_avg_duration_ms, h.window_hours AS health_window_hours,
         h.unavailable_reason AS health_unavailable_reason, h.computed_at AS health_computed_at,
         o.owner_email AS own_owner_email, o.owner_name AS own_owner_name,
         o.backup_owner_email AS own_backup_email, o.backup_owner_name AS own_backup_name,
         o.reason AS own_reason, o.assigned_by_name AS own_assigned_by_name,
         o.assigned_by_email AS own_assigned_by_email, o.assigned_at AS own_assigned_at,
         io.owner_email AS inf_owner_email, io.owner_name AS inf_owner_name,
         io.source AS inf_source, io.member_role AS inf_member_role, io.reason AS inf_reason
    FROM workflows w
    JOIN connections c ON c.id = w.instance_id
    LEFT JOIN workflow_enrichments e ON e.instance_id = w.instance_id AND e.workflow_id = w.id
    LEFT JOIN workflow_health h ON h.instance_id = w.instance_id AND h.workflow_id = w.id
    LEFT JOIN workflow_ownership o ON o.instance_id = w.instance_id AND o.workflow_id = w.id
    LEFT JOIN workflow_inferred_owner io ON io.instance_id = w.instance_id AND io.workflow_id = w.id`;

/** Build the shared WHERE clause + params so `listWorkflows` and `countWorkflows` filter identically. */
function buildWorkflowWhere(filters: WorkflowFilters): { clause: string; params: unknown[] } {
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
  if (filters.broken) {
    where.push('w.broken_ref_count > 0');
  }
  if (filters.stale) {
    // Stale = a stored enrichment whose input hash no longer matches the workflow's current
    // hash (mirrors the served enrichment.status === 'stale'). `IS NOT` handles NULL hashes.
    where.push('e.input_hash IS NOT NULL AND e.input_hash IS NOT w.enrichment_input_hash');
  }
  if (filters.criticality && filters.criticality.length > 0) {
    const placeholders = filters.criticality.map(() => '?').join(', ');
    // Match the EFFECTIVE criticality: an owner correction overrides the model's label.
    where.push(
      `COALESCE(json_extract(e.corrected_json, '$.criticality'), json_extract(e.enrichment_json, '$.criticality')) IN (${placeholders})`,
    );
    params.push(...filters.criticality);
  }
  if (filters.health && filters.health.length > 0) {
    const placeholders = filters.health.map(() => '?').join(', ');
    where.push(`h.status IN (${placeholders})`);
    params.push(...filters.health);
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

  return { clause: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * The estate-wide inventory with S1b facts, filtered server-side, ORDER BY instance+name,
 * and LIMIT/OFFSET paginated (an estate can have thousands). `instanceId` is a filter, the
 * list is one estate. Multiple systems/triggers are OR within the facet; different facets
 * AND together (standard faceted search).
 */
export function listWorkflows(db: Database.Database, filters: WorkflowFilters = {}): WorkflowListItem[] {
  const { clause, params } = buildWorkflowWhere(filters);
  let sql = `${LIST_SELECT}${clause} ORDER BY c.label, w.name`;
  if (filters.limit !== undefined) {
    const limit = Math.min(Math.max(filters.limit, 1), 5000);
    const offset = Math.max(filters.offset ?? 0, 0);
    sql += ` LIMIT ${limit} OFFSET ${offset}`;
  }
  const rows = db.prepare(sql).all(...params) as WorkflowRow[];
  return rows.map(toListItem);
}

/** Total workflows matching the filters (ignores limit/offset) — the pagination denominator. */
export function countWorkflows(db: Database.Database, filters: WorkflowFilters = {}): number {
  const { clause, params } = buildWorkflowWhere(filters);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM workflows w JOIN connections c ON c.id = w.instance_id
    LEFT JOIN workflow_enrichments e ON e.instance_id = w.instance_id AND e.workflow_id = w.id
    LEFT JOIN workflow_health h ON h.instance_id = w.instance_id AND h.workflow_id = w.id${clause}`).get(...params) as { n: number };
  return row.n;
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
