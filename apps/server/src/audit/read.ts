import type Database from 'better-sqlite3';
import type { AuditTimelineEntry } from '@argus/shared';

/**
 * SELECT-only access to the sacred, append-only `audit_log` — the read side of the
 * unified governance timeline (Argus self-audit only in S4). Kept OUT of db/audit.ts
 * so the sacred WRITE module stays write-only. This module never mutates audit_log.
 */

export interface AuditFilters {
  /** Exact action OR an action-family prefix: 'ownership' also matches 'ownership.assign'. */
  action?: string | undefined;
  entityType?: string | undefined;
  actorEmail?: string | undefined;
  /** ISO lower/upper bounds on `ts` (inclusive). */
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

interface AuditRow {
  id: number;
  ts: string;
  actor_name: string;
  actor_email: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail_json: string | null;
}

function toEntry(r: AuditRow): AuditTimelineEntry {
  let detail: Record<string, unknown> | null = null;
  if (r.detail_json) {
    try {
      detail = JSON.parse(r.detail_json) as Record<string, unknown>;
    } catch {
      detail = null; // malformed detail is dropped, never guessed (rule 5)
    }
  }
  return {
    id: r.id,
    ts: r.ts,
    actorName: r.actor_name,
    actorEmail: r.actor_email,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    detail,
  };
}

/** The filtered timeline, newest first. */
export function listAudit(db: Database.Database, filters: AuditFilters = {}): AuditTimelineEntry[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.action) {
    where.push('(action = ? OR action LIKE ?)');
    params.push(filters.action, `${filters.action}.%`);
  }
  if (filters.entityType) {
    where.push('entity_type = ?');
    params.push(filters.entityType);
  }
  if (filters.actorEmail) {
    where.push('actor_email = ?');
    params.push(filters.actorEmail);
  }
  if (filters.from) {
    where.push('ts >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('ts <= ?');
    params.push(filters.to);
  }
  const limit = Math.min(Math.max(filters.limit ?? 500, 1), 5000);
  const sql = `SELECT id, ts, actor_name, actor_email, action, entity_type, entity_id, detail_json
                 FROM audit_log${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                ORDER BY id DESC LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...params) as AuditRow[];
  return rows.map(toEntry);
}

/** Distinct actions present in the log (for the filter dropdown), sorted. */
export function distinctAuditActions(db: Database.Database): string[] {
  const rows = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all() as { action: string }[];
  return rows.map((r) => r.action);
}

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Serialize timeline entries to CSV. Only known, secret-free columns are projected
 * (audit `detail` is already contractually secret-free); the raw JSON detail is
 * emitted as one compact column so before→after context survives the export.
 */
export function auditToCsv(entries: AuditTimelineEntry[]): string {
  const header = ['id', 'ts', 'actor_name', 'actor_email', 'action', 'entity_type', 'entity_id', 'detail'];
  const lines = [header.join(',')];
  for (const e of entries) {
    lines.push(
      [e.id, e.ts, e.actorName, e.actorEmail, e.action, e.entityType, e.entityId, e.detail ? JSON.stringify(e.detail) : '']
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
