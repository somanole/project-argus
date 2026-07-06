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
