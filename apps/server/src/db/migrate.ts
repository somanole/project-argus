import type Database from 'better-sqlite3';

/**
 * Ordered, idempotent schema migrations tracked by SQLite's `user_version`.
 * Each step runs once, in order; re-running is a no-op. Never edit a shipped
 * step — add a new one.
 *
 * The split (PLAN.md principle 3):
 *   - SACRED native tables — `connections`, `audit_log` — hold data that is not
 *     regenerable. Never bulk-deleted or rewritten; audit_log is append-only,
 *     enforced by triggers.
 *   - DISPOSABLE cache — `workflows` — is rebuilt from n8n by every sync;
 *     `instance_id` is a filter attribute, not a partition.
 */
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  // v1 — S1a: connections registry, audit log, workflow inventory cache.
  (db) => {
    db.exec(`
      CREATE TABLE connections (
        id             TEXT PRIMARY KEY,
        label          TEXT NOT NULL,
        base_url       TEXT NOT NULL,
        api_key_cipher TEXT NOT NULL,
        webhook_host   TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT NOT NULL,
        actor_name  TEXT NOT NULL,
        actor_email TEXT NOT NULL,
        action      TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id   TEXT,
        detail_json TEXT
      );

      -- The audit log is append-only: refuse UPDATE and DELETE at the DB layer,
      -- so no code path (or bug) can rewrite history (standing rule 6).
      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

      CREATE TABLE workflows (
        instance_id    TEXT NOT NULL,
        id             TEXT NOT NULL,
        name           TEXT NOT NULL,
        active         INTEGER NOT NULL,
        is_archived    INTEGER NOT NULL,
        project_id     TEXT,
        project_name   TEXT,
        updated_at     TEXT,
        version_id     TEXT,
        last_synced_at TEXT NOT NULL,
        PRIMARY KEY (instance_id, id),
        FOREIGN KEY (instance_id) REFERENCES connections(id) ON DELETE CASCADE
      );
      CREATE INDEX workflows_by_instance ON workflows(instance_id);
    `);
  },

  // v2 — S1b: catalog facts. The analyzer computes deterministic facts per workflow
  // at sync time; we store them on the (disposable) workflows row plus normalized
  // child tables for indexed, estate-wide filtering. All disposable cache — rebuilt
  // every sync, cascade on connection delete; no sacred data here.
  (db) => {
    db.exec(`
      ALTER TABLE workflows ADD COLUMN facts_json           TEXT;
      ALTER TABLE workflows ADD COLUMN facts_schema_version INTEGER;
      ALTER TABLE workflows ADD COLUMN mcp_exposed          INTEGER;
      ALTER TABLE workflows ADD COLUMN node_count           INTEGER;
      ALTER TABLE workflows ADD COLUMN understood           INTEGER;
      ALTER TABLE workflows ADD COLUMN broken_ref_count     INTEGER;

      -- One row per (workflow, external system) — the "touches Salesforce" filter.
      CREATE TABLE workflow_systems (
        instance_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        system      TEXT NOT NULL,
        PRIMARY KEY (instance_id, workflow_id, system),
        FOREIGN KEY (instance_id) REFERENCES connections(id) ON DELETE CASCADE
      );
      CREATE INDEX workflow_systems_by_system ON workflow_systems(system);

      -- One row per (workflow, trigger node type) — the trigger filter.
      CREATE TABLE workflow_triggers (
        instance_id  TEXT NOT NULL,
        workflow_id  TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        PRIMARY KEY (instance_id, workflow_id, trigger_type),
        FOREIGN KEY (instance_id) REFERENCES connections(id) ON DELETE CASCADE
      );
      CREATE INDEX workflow_triggers_by_type ON workflow_triggers(trigger_type);
    `);
  },

  // v3 — S2: LLM enrichment. Two new tables + one column.
  //  - workflow_enrichments is DURABLE (not disposable, not sacred): it is expensive to
  //    regenerate (LLM spend), so — unlike `workflows` — it must SURVIVE the ~30s cache
  //    rebuild. It has NO foreign key to `workflows`, so the sync's delete+reinsert of
  //    workflow rows never touches it; it cascades only on connection delete. The
  //    gating tuple (input_hash, provider, model, prompt_version, schema_version)
  //    decides freshness: any mismatch → re-enrich; all match → 0 API calls.
  //  - enrichment_input_hash rides on the (disposable) workflows row, recomputed each
  //    sync from the allowlist, so "stale" is a pure read-time SQL comparison.
  //  - llm_config holds the single active provider + its ENCRYPTED key (never returned),
  //    mutated through the audit DAO like connections.
  (db) => {
    db.exec(`
      -- The hash of the redacted allowlist, computed each sync (raw params/URLs are
      -- NEVER stored — only the safe allowlist is). The payload itself is added in v4.
      ALTER TABLE workflows ADD COLUMN enrichment_input_hash TEXT;

      CREATE TABLE workflow_enrichments (
        instance_id     TEXT NOT NULL,
        workflow_id     TEXT NOT NULL,
        input_hash      TEXT NOT NULL,
        provider        TEXT NOT NULL,
        model           TEXT NOT NULL,
        prompt_version  TEXT NOT NULL,
        schema_version  INTEGER NOT NULL,
        status          TEXT NOT NULL,          -- 'analyzed' | 'stub'
        enrichment_json TEXT NOT NULL,          -- the model output (null fields on stub)
        corrected_json  TEXT,                   -- owner label overrides, overlaid at read time
        enriched_at     TEXT NOT NULL,
        PRIMARY KEY (instance_id, workflow_id),
        FOREIGN KEY (instance_id) REFERENCES connections(id) ON DELETE CASCADE
      );
      CREATE INDEX workflow_enrichments_by_instance ON workflow_enrichments(instance_id);

      -- Single-row active-provider config. The CHECK pins exactly one row.
      CREATE TABLE llm_config (
        id             TEXT PRIMARY KEY CHECK (id = 'active'),
        provider       TEXT NOT NULL,
        model          TEXT NOT NULL,
        api_key_cipher TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
    `);
  },

  // v4 — S2 fix: the redacted, no-secrets allowlist payload column. Added as its OWN
  // step (never edit an applied step — v3 already shipped to running dev DBs with only
  // enrichment_input_hash, so adding this column to v3 would be silently skipped there).
  (db) => {
    db.exec('ALTER TABLE workflows ADD COLUMN enrichment_input_json TEXT;');
  },

  // v5 — S2: the user-facing enrichment kill switch, persisted. The ENRICHMENT_ENABLED
  // env var is a hard OPS override (force-off); this persisted flag is the in-app master
  // switch the owner toggles. Effective = env allows AND this flag is on.
  (db) => {
    db.exec(`
      CREATE TABLE app_settings (
        id                 TEXT PRIMARY KEY CHECK (id = 'app'),
        enrichment_enabled INTEGER NOT NULL
      );
      INSERT INTO app_settings (id, enrichment_enabled) VALUES ('app', 1);
    `);
  },

  // v6 — S3: per-workflow execution health (failing/degraded/healthy/idle/unknown),
  // computed by Argus from n8n's executions on each poll. A DISPOSABLE cache — fully
  // rebuildable from n8n, so no audit/sacred rules apply — but it is written on its OWN
  // cadence (health sync), NOT part of the ~30s workflows-cache rebuild, so it lives in
  // its own table and survives replaceInstanceWorkflows(). Cascades on connection delete.
  (db) => {
    db.exec(`
      CREATE TABLE workflow_health (
        instance_id        TEXT NOT NULL,
        workflow_id        TEXT NOT NULL,
        status             TEXT NOT NULL,     -- failing|degraded|healthy|idle|unknown
        runs_in_window     INTEGER NOT NULL,
        failures_in_window INTEGER NOT NULL,
        failure_rate       REAL,              -- null when 0 runs (idle) or unknown
        last_run_at        TEXT,
        last_status        TEXT,
        avg_duration_ms    INTEGER,
        window_hours       INTEGER NOT NULL,
        unavailable_reason TEXT,              -- set only for status='unknown'
        computed_at        TEXT NOT NULL,
        PRIMARY KEY (instance_id, workflow_id),
        FOREIGN KEY (instance_id) REFERENCES connections(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_workflow_health_status ON workflow_health (status);
    `);
  },

  // v7 — S4: ownership & accountability. Two tables, two provenances kept apart:
  //
  //  - workflow_ownership is DURABLE and holds EXPLICIT HUMAN ASSIGNMENTS. Like
  //    workflow_enrichments it has NO foreign key to `workflows`, so a full inventory
  //    resync (replaceInstanceWorkflows delete+reinsert) can NEVER touch it — that is
  //    guarantee (i): a resync does not wipe ownership. It cascades only on connection
  //    delete. Every mutation of this table goes through the sacred audit DAO
  //    (withAudit) — the mutation + its append-only audit_log entry commit together —
  //    which is guarantee (ii): no ownership change without an audit entry.
  //    owner_email is nullable (a backup-only row is legal mid-lifecycle).
  //
  //  - workflow_inferred_owner is a DISPOSABLE cache: the advisory owner Argus infers
  //    from n8n project membership, recomputed every sync (like workflow_health) and
  //    NEVER audited. owner_email NULL = "couldn't infer" (honest degradation, rule 5).
  //    An inference must never outlive the n8n state that justified it, so it is
  //    rebuilt, not preserved. It never overrides an assignment (read-path COALESCE).
  (db) => {
    db.exec(`
      CREATE TABLE workflow_ownership (
        instance_id        TEXT NOT NULL,
        workflow_id        TEXT NOT NULL,
        owner_email        TEXT,              -- nullable: a backup-only row is legal
        owner_name         TEXT,
        backup_owner_email TEXT,
        backup_owner_name  TEXT,
        reason             TEXT,
        assigned_by_name   TEXT NOT NULL,     -- who assigned (also in audit_log; denormalized for reads)
        assigned_by_email  TEXT NOT NULL,
        assigned_at        TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (instance_id, workflow_id),
        FOREIGN KEY (instance_id) REFERENCES connections(id) ON DELETE CASCADE
      );
      CREATE INDEX workflow_ownership_by_owner    ON workflow_ownership(owner_email);
      CREATE INDEX workflow_ownership_by_instance ON workflow_ownership(instance_id);

      CREATE TABLE workflow_inferred_owner (
        instance_id  TEXT NOT NULL,
        workflow_id  TEXT NOT NULL,
        owner_email  TEXT,                    -- NULL = couldn't infer (rule 5)
        owner_name   TEXT,
        source       TEXT NOT NULL,           -- 'personal-project' | 'project-member' | 'unavailable'
        member_role  TEXT,                    -- winning project role when source='project-member'
        reason       TEXT,                    -- honest reason when owner_email is NULL
        computed_at  TEXT NOT NULL,
        PRIMARY KEY (instance_id, workflow_id),
        FOREIGN KEY (instance_id) REFERENCES connections(id) ON DELETE CASCADE
      );
    `);
  },

  // v8 — S5: the cross-workflow / cross-instance dependency graph. One row per
  // directed edge (source depends on / calls / uses target). A DISPOSABLE cache:
  // the estate-wide edge pass wipes and rebuilds the WHOLE table each cycle (edges
  // span instances, so a per-instance FK would be wrong — the global rebuild after
  // every poll is the correctness mechanism, and a deleted connection's edges vanish
  // on the next pass). Nodes are workflows OR shared resources (credential/datatable);
  // resource labels are denormalized here because Argus stores no credentials table.
  //
  // THE TRUST SPINE (rule 5): `confidence` is 'confirmed' (n8n literally wired it) or
  // 'possible' (inferred). Impact queries filter to confirmed; `possible` is never
  // counted. That invariant is enforced in the impact query and asserted in verify.
  (db) => {
    db.exec(`
      CREATE TABLE workflow_edges (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        src_instance   TEXT NOT NULL,
        src_kind       TEXT NOT NULL,          -- workflow | credential | datatable
        src_id         TEXT NOT NULL,
        src_label      TEXT,
        dst_instance   TEXT NOT NULL,
        dst_kind       TEXT NOT NULL,
        dst_id         TEXT NOT NULL,
        dst_label      TEXT,
        type           TEXT NOT NULL,          -- EdgeType
        confidence     TEXT NOT NULL,          -- 'confirmed' | 'possible'
        cross_instance INTEGER NOT NULL,
        reason         TEXT NOT NULL,
        computed_at    TEXT NOT NULL
      );
      -- reverse traversal ("who depends on this target?") — the blast-radius direction.
      CREATE INDEX workflow_edges_by_dst ON workflow_edges(dst_kind, dst_instance, dst_id);
      -- forward traversal ("what does this reach?") — MCP exposure-reach.
      CREATE INDEX workflow_edges_by_src ON workflow_edges(src_kind, src_instance, src_id);
      CREATE INDEX workflow_edges_by_type ON workflow_edges(type, confidence);
    `);
  },

  // v9 — DECISION #30: the `openai_compatible` provider. The endpoint is user-supplied,
  // so we persist it alongside the CAPABILITY-PROBE result for the two wrapper seams —
  // an endpoint that can't emit tool calls disables chat explicitly rather than letting
  // it answer from nothing (rule 5). All columns are nullable: they are meaningless for
  // the two hosted providers, whose seams are known-good and contract-tested.
  //
  // `workflow_enrichments.base_url` joins the freshness gating tuple: two different
  // endpoints can serve the same model ID, so repointing the base URL must re-enrich
  // rather than silently keep summaries produced by a different model.
  (db) => {
    db.exec(`
      ALTER TABLE llm_config ADD COLUMN base_url TEXT;
      ALTER TABLE llm_config ADD COLUMN caps_structured_output INTEGER;
      ALTER TABLE llm_config ADD COLUMN caps_streaming_tool_calls INTEGER;
      ALTER TABLE llm_config ADD COLUMN caps_note TEXT;
      ALTER TABLE llm_config ADD COLUMN caps_probed_at TEXT;
      ALTER TABLE workflow_enrichments ADD COLUMN base_url TEXT;
    `);
  },

  // v10 — S6.3 silent-failure detection ("green but broken").
  //  - workflows.can_mask_failures: the denormalized Layer-1 config-risk flag (from facts),
  //    so the badge/filter/Layer-2 scope query read it without a facts_json parse.
  //  - workflow_health.silent_*: the Layer-2 dynamic signal, poll-computed for the
  //    can-mask-failures workflows only (an un-redacted, allowlisted, never-persisted-payload
  //    read — contracts/n8n-23). All nullable: NULL means "not inspected" (not flagged / not
  //    fetched), never "verified clean" (rule 5). Disposable cache, rebuilt each sync.
  (db) => {
    db.exec(`
      ALTER TABLE workflows ADD COLUMN can_mask_failures INTEGER;

      ALTER TABLE workflow_health ADD COLUMN silent_runs_affected  INTEGER;
      ALTER TABLE workflow_health ADD COLUMN silent_runs_inspected INTEGER;
      ALTER TABLE workflow_health ADD COLUMN silent_last_node      TEXT;
      ALTER TABLE workflow_health ADD COLUMN silent_last_error_type TEXT;
      ALTER TABLE workflow_health ADD COLUMN silent_last_error_code TEXT;
      ALTER TABLE workflow_health ADD COLUMN silent_last_seen_at   TEXT;
    `);
  },
];

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const step = MIGRATIONS[v];
    if (!step) continue;
    const run = db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${v + 1}`);
    });
    run();
  }
}
