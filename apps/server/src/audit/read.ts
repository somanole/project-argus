import type Database from 'better-sqlite3';
import type { AuditTimelineEntry } from '@argus/shared';
import { isDemoMode } from '../config.js';

/**
 * SELECT-only access to the sacred, append-only `audit_log` — the read side of the
 * unified governance timeline (Argus self-audit only in S4). Kept OUT of db/audit.ts
 * so the sacred WRITE module stays write-only. This module never mutates audit_log.
 */

export interface AuditFilters {
  /** Exact action OR an action-family prefix: 'ownership' also matches 'ownership.assign'. */
  action?: string | undefined;
  entityType?: string | undefined;
  /** Case-insensitive SUBSTRING match on the actor's name OR email ('sor' matches 'Sorin' or 'sorin@x.io'). */
  actor?: string | undefined;
  /** ISO lower/upper bounds on `ts` (inclusive). */
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  /** Rows to skip before the page (pagination). */
  offset?: number | undefined;
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

/**
 * Public-demo redaction (see `isDemoMode`). Applied to every audit READ so the
 * timeline, the CSV export and the overview changelog are all covered by one rule —
 * the DB row keeps the real actor, only what leaves the server is masked.
 */
export const DEMO_ACTOR_NAME = 'Demo visitor';
export const DEMO_ACTOR_EMAIL = 'hidden in demo mode';

function redactActor(e: AuditTimelineEntry): AuditTimelineEntry {
  return { ...e, actorName: DEMO_ACTOR_NAME, actorEmail: DEMO_ACTOR_EMAIL };
}

/**
 * In demo mode the actor filter is dropped: matching on a name/email substring would
 * confirm whether a given person has used the demo, which is the very thing the
 * redaction hides.
 */
function effectiveFilters(filters: AuditFilters): AuditFilters {
  return isDemoMode() ? { ...filters, actor: undefined } : filters;
}

/** Escape the LIKE metacharacters in a user substring so it matches literally (used with ESCAPE '\'). */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Build the shared WHERE clause + params so `listAudit` and `countAudit` filter identically. */
function buildWhere(filters: AuditFilters): { clause: string; params: unknown[] } {
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
  if (filters.actor) {
    // Partial, case-insensitive (SQLite LIKE is ASCII-case-insensitive) substring match on
    // either the actor's name or email — one box finds a person whichever they went by.
    where.push("(actor_name LIKE ? ESCAPE '\\' OR actor_email LIKE ? ESCAPE '\\')");
    const like = likeContains(filters.actor);
    params.push(like, like);
  }
  if (filters.from) {
    where.push('ts >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('ts <= ?');
    params.push(filters.to);
  }
  return { clause: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

/** The filtered timeline page, newest first (LIMIT/OFFSET). */
export function listAudit(db: Database.Database, filters: AuditFilters = {}): AuditTimelineEntry[] {
  const { clause, params } = buildWhere(effectiveFilters(filters));
  const limit = Math.min(Math.max(filters.limit ?? 500, 1), 5000);
  const offset = Math.max(filters.offset ?? 0, 0);
  const sql = `SELECT id, ts, actor_name, actor_email, action, entity_type, entity_id, detail_json
                 FROM audit_log${clause}
                ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`;
  const rows = db.prepare(sql).all(...params) as AuditRow[];
  const entries = rows.map(toEntry);
  return isDemoMode() ? entries.map(redactActor) : entries;
}

/** Total rows matching the filters (ignores limit/offset) — the pagination denominator. */
export function countAudit(db: Database.Database, filters: AuditFilters = {}): number {
  const { clause, params } = buildWhere(effectiveFilters(filters));
  const row = db.prepare(`SELECT COUNT(*) AS n FROM audit_log${clause}`).get(...params) as { n: number };
  return row.n;
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
