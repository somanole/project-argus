import type Database from 'better-sqlite3';
import type { SessionActor } from '@argus/shared';

/**
 * The single write path for the sacred tables. Every mutation of a sacred table
 * (connections today) MUST go through `withAudit`, which wraps the mutation and
 * its audit-log insert in ONE transaction — they commit together or not at all
 * (standing rule 6).
 */
export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string | null;
  /** Non-secret context only — never put an API key or password here. */
  detail?: Record<string, unknown>;
}

export function appendAudit(db: Database.Database, actor: SessionActor, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log (ts, actor_name, actor_email, action, entity_type, entity_id, detail_json)
     VALUES (@ts, @actorName, @actorEmail, @action, @entityType, @entityId, @detailJson)`,
  ).run({
    ts: new Date().toISOString(),
    actorName: actor.name,
    actorEmail: actor.email,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    detailJson: entry.detail ? JSON.stringify(entry.detail) : null,
  });
}

/**
 * Run `mutate` and record `entry` in the same transaction. Returns whatever
 * `mutate` returns. If either the mutation or the audit insert throws, the whole
 * thing rolls back — there is no mutation without its audit entry.
 */
export function withAudit<T>(
  db: Database.Database,
  actor: SessionActor,
  entry: AuditEntry,
  mutate: () => T,
): T {
  const run = db.transaction(() => {
    const result = mutate();
    appendAudit(db, actor, entry);
    return result;
  });
  return run();
}
