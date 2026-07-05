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
