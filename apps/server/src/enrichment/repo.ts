import type Database from 'better-sqlite3';
import type { SessionActor, EnrichmentCorrection, EnrichmentProgress } from '@argus/shared';
import { withAudit } from '../db/audit.js';

/**
 * Data access for the DURABLE `workflow_enrichments` table (survives the ~30s cache
 * rebuild). The gating tuple (input_hash + provider + model + prompt_version +
 * schema_version) decides freshness. Owner corrections are audited mutations and are
 * PRESERVED across automatic re-enrichment (a human judgment isn't silently wiped).
 */

/** The current active gating tuple — supplied by the enrichment service. */
export interface GatingTuple {
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: number;
}

export interface UpsertEnrichmentParams extends GatingTuple {
  instanceId: string;
  workflowId: string;
  inputHash: string;
  status: 'analyzed' | 'stub';
  enrichmentJson: string;
}

/** A workflow that needs (re-)enrichment: never enriched, or stale by any tuple dimension. */
export interface EnrichmentCandidate {
  instanceId: string;
  workflowId: string;
  inputHash: string;
  inputJson: string;
}

export function upsertEnrichment(db: Database.Database, p: UpsertEnrichmentParams): void {
  // Preserve corrected_json on conflict — an owner correction outlives an auto re-run.
  db.prepare(
    `INSERT INTO workflow_enrichments
       (instance_id, workflow_id, input_hash, provider, model, prompt_version, schema_version,
        status, enrichment_json, corrected_json, enriched_at)
     VALUES (@instanceId, @workflowId, @inputHash, @provider, @model, @promptVersion, @schemaVersion,
        @status, @enrichmentJson, NULL, @enrichedAt)
     ON CONFLICT(instance_id, workflow_id) DO UPDATE SET
        input_hash=@inputHash, provider=@provider, model=@model, prompt_version=@promptVersion,
        schema_version=@schemaVersion, status=@status, enrichment_json=@enrichmentJson, enriched_at=@enrichedAt`,
  ).run({ ...p, enrichedAt: new Date().toISOString() });
}

/** The miss queue for one instance, prioritized (active + recently-updated first). */
export function listEnrichmentCandidates(db: Database.Database, instanceId: string, tuple: GatingTuple): EnrichmentCandidate[] {
  const rows = db
    .prepare(
      `SELECT w.instance_id AS instanceId, w.id AS workflowId,
              w.enrichment_input_hash AS inputHash, w.enrichment_input_json AS inputJson
         FROM workflows w
         LEFT JOIN workflow_enrichments e ON e.instance_id = w.instance_id AND e.workflow_id = w.id
        WHERE w.instance_id = @instanceId
          AND w.enrichment_input_json IS NOT NULL
          AND (
            e.workflow_id IS NULL
            OR e.input_hash <> w.enrichment_input_hash
            OR e.provider <> @provider OR e.model <> @model
            OR e.prompt_version <> @promptVersion OR e.schema_version <> @schemaVersion
          )
        ORDER BY w.active DESC, w.updated_at DESC`,
    )
    .all({ instanceId, ...tuple }) as EnrichmentCandidate[];
  return rows;
}

/** Drop enrichment rows whose workflow no longer exists in this instance's cache. */
export function pruneOrphans(db: Database.Database, instanceId: string): number {
  const info = db
    .prepare(
      `DELETE FROM workflow_enrichments
        WHERE instance_id = ?
          AND NOT EXISTS (SELECT 1 FROM workflows w WHERE w.instance_id = workflow_enrichments.instance_id AND w.id = workflow_enrichments.workflow_id)`,
    )
    .run(instanceId);
  return info.changes;
}

/** One-click label correction — an audited mutation (DECISION #6). False if not enriched. */
export function correctLabel(
  db: Database.Database,
  actor: SessionActor,
  instanceId: string,
  workflowId: string,
  correction: EnrichmentCorrection,
): boolean {
  const existing = db
    .prepare('SELECT corrected_json FROM workflow_enrichments WHERE instance_id = ? AND workflow_id = ?')
    .get(instanceId, workflowId) as { corrected_json: string | null } | undefined;
  if (!existing) return false;

  const prior = existing.corrected_json ? (JSON.parse(existing.corrected_json) as Record<string, unknown>) : {};
  const merged = {
    ...prior,
    ...(correction.category !== undefined ? { category: correction.category } : {}),
    ...(correction.criticality !== undefined ? { criticality: correction.criticality } : {}),
  };
  return withAudit(
    db,
    actor,
    {
      action: 'enrichment.correct',
      entityType: 'workflow_enrichment',
      entityId: `${instanceId}/${workflowId}`,
      detail: { instanceId, workflowId, category: correction.category, criticality: correction.criticality, note: correction.note },
    },
    () => {
      db.prepare('UPDATE workflow_enrichments SET corrected_json = ? WHERE instance_id = ? AND workflow_id = ?').run(
        JSON.stringify(merged),
        instanceId,
        workflowId,
      );
      return true;
    },
  );
}

/** MAX(enriched_at) across the estate — "enrichment last ran at". Null if never. */
export function lastEnrichedAt(db: Database.Database): string | null {
  const row = db.prepare('SELECT MAX(enriched_at) AS t FROM workflow_enrichments').get() as { t: string | null };
  return row?.t ?? null;
}

/** Estate-wide progress for the "enriched X/Y" indicator. `enabled` is set by the caller. */
export function enrichmentCounts(db: Database.Database, tuple: GatingTuple): Omit<EnrichmentProgress, 'enabled' | 'lastEnrichedAt'> {
  const fresh = `e.workflow_id IS NOT NULL AND e.input_hash = w.enrichment_input_hash
     AND e.provider = @provider AND e.model = @model AND e.prompt_version = @promptVersion AND e.schema_version = @schemaVersion`;
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN ${fresh} AND e.status = 'analyzed' THEN 1 ELSE 0 END) AS analyzed,
         SUM(CASE WHEN ${fresh} AND e.status = 'stub' THEN 1 ELSE 0 END) AS stub,
         SUM(CASE WHEN e.workflow_id IS NOT NULL AND NOT (${fresh}) THEN 1 ELSE 0 END) AS stale,
         SUM(CASE WHEN e.workflow_id IS NULL THEN 1 ELSE 0 END) AS pending
       FROM workflows w
       LEFT JOIN workflow_enrichments e ON e.instance_id = w.instance_id AND e.workflow_id = w.id
       WHERE w.enrichment_input_json IS NOT NULL`,
    )
    .get(tuple) as { total: number; analyzed: number | null; stub: number | null; stale: number | null; pending: number | null };
  return {
    total: row.total,
    analyzed: row.analyzed ?? 0,
    stub: row.stub ?? 0,
    stale: row.stale ?? 0,
    pending: row.pending ?? 0,
  };
}
