import type Database from 'better-sqlite3';
import type { WorkflowFacts } from '@argus/shared';
import { workflowFactsSchema } from '@argus/shared';
import type { BuiltEdge, GraphInstance, GraphWorkflow, NodeIdent } from './build.js';

/**
 * Persistence for the S5 dependency graph. The `workflow_edges` table is a disposable
 * cache: the estate pass wipes and rebuilds it whole every cycle, so reads always see
 * a consistent snapshot and a deleted connection's edges disappear on the next pass.
 */

/** A stored edge, hydrated back into the same shape the builder emits. */
export type StoredEdge = BuiltEdge;

/** Per-workflow metadata the graph/impact layer needs, joined from the cache. */
export interface GraphWorkflowMeta {
  instanceId: string;
  instanceLabel: string;
  id: string;
  name: string;
  active: boolean;
  archived: boolean;
  facts: WorkflowFacts | null;
  health: string | null;
  mcpExposed: boolean;
  brokenRef: boolean;
}

interface WfRow {
  instance_id: string;
  instance_label: string;
  id: string;
  name: string;
  active: number;
  is_archived: number;
  facts_json: string | null;
  mcp_exposed: number | null;
  broken_ref_count: number | null;
  health_status: string | null;
}

const WF_SELECT = `
  SELECT w.instance_id, c.label AS instance_label, w.id, w.name, w.active, w.is_archived,
         w.facts_json, w.mcp_exposed, w.broken_ref_count, h.status AS health_status
  FROM workflows w
  JOIN connections c ON c.id = w.instance_id
  LEFT JOIN workflow_health h ON h.instance_id = w.instance_id AND h.workflow_id = w.id
`;

/** Parse a stored facts_json honestly — a shape drift yields null, never a crash (rule 5). */
function parseFacts(json: string | null): WorkflowFacts | null {
  if (!json) return null;
  try {
    const parsed = workflowFactsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function mapMeta(r: WfRow): GraphWorkflowMeta {
  return {
    instanceId: r.instance_id,
    instanceLabel: r.instance_label,
    id: r.id,
    name: r.name,
    active: r.active === 1,
    archived: r.is_archived === 1,
    facts: parseFacts(r.facts_json),
    health: r.health_status,
    mcpExposed: r.mcp_exposed === 1,
    brokenRef: (r.broken_ref_count ?? 0) > 0,
  };
}

/** Every workflow across the estate, with facts + display metadata. */
export function readGraphWorkflows(db: Database.Database): GraphWorkflowMeta[] {
  return (db.prepare(WF_SELECT).all() as WfRow[]).map(mapMeta);
}

/** The builder's leaner view (facts + identity only). */
export function readBuildWorkflows(db: Database.Database): GraphWorkflow[] {
  return readGraphWorkflows(db).map((w) => ({
    instanceId: w.instanceId,
    id: w.id,
    name: w.name,
    active: w.active,
    archived: w.archived,
    facts: w.facts,
  }));
}

/** Connection identity + public webhook host — for cross-instance matching. */
export function readGraphInstances(db: Database.Database): GraphInstance[] {
  const rows = db.prepare('SELECT id, label, webhook_host FROM connections').all() as Array<{
    id: string;
    label: string;
    webhook_host: string | null;
  }>;
  return rows.map((r) => ({ instanceId: r.id, label: r.label, webhookHost: r.webhook_host }));
}

interface EdgeRow {
  src_instance: string;
  src_kind: string;
  src_id: string;
  src_label: string | null;
  dst_instance: string;
  dst_kind: string;
  dst_id: string;
  dst_label: string | null;
  type: string;
  confidence: string;
  cross_instance: number;
  reason: string;
}

function identFrom(instance: string, kind: string, id: string, label: string | null): NodeIdent {
  return { kind: kind as NodeIdent['kind'], instanceId: instance, id, label: label ?? id };
}

function mapEdge(r: EdgeRow): StoredEdge {
  return {
    src: identFrom(r.src_instance, r.src_kind, r.src_id, r.src_label),
    dst: identFrom(r.dst_instance, r.dst_kind, r.dst_id, r.dst_label),
    type: r.type as StoredEdge['type'],
    confidence: r.confidence as StoredEdge['confidence'],
    crossInstance: r.cross_instance === 1,
    reason: r.reason,
  };
}

/** Load every stored edge (the graph/impact layer works in memory at fleet scale). */
export function readAllEdges(db: Database.Database): StoredEdge[] {
  return (db.prepare('SELECT * FROM workflow_edges').all() as EdgeRow[]).map(mapEdge);
}

export function countEdges(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM workflow_edges').get() as { n: number }).n;
}

/**
 * Atomically replace the WHOLE edge set (disposable cache — global wipe + rebuild).
 * Runs in one transaction so a reader never sees a half-built graph.
 */
export function replaceAllEdges(db: Database.Database, edges: BuiltEdge[], computedAt: string): void {
  const del = db.prepare('DELETE FROM workflow_edges');
  const ins = db.prepare(`
    INSERT INTO workflow_edges
      (src_instance, src_kind, src_id, src_label, dst_instance, dst_kind, dst_id, dst_label,
       type, confidence, cross_instance, reason, computed_at)
    VALUES
      (@src_instance, @src_kind, @src_id, @src_label, @dst_instance, @dst_kind, @dst_id, @dst_label,
       @type, @confidence, @cross_instance, @reason, @computed_at)
  `);
  const run = db.transaction((rows: BuiltEdge[]) => {
    del.run();
    for (const e of rows) {
      ins.run({
        src_instance: e.src.instanceId,
        src_kind: e.src.kind,
        src_id: e.src.id,
        src_label: e.src.label,
        dst_instance: e.dst.instanceId,
        dst_kind: e.dst.kind,
        dst_id: e.dst.id,
        dst_label: e.dst.label,
        type: e.type,
        confidence: e.confidence,
        cross_instance: e.crossInstance ? 1 : 0,
        reason: e.reason,
        computed_at: computedAt,
      });
    }
  });
  run(edges);
}
