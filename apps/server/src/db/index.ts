import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

/**
 * Opens the Argus database (better-sqlite3, WAL) and brings the schema up to
 * date. Pass `':memory:'` for tests. Foreign keys are ON so removing a
 * connection cascades to its cached workflows.
 */
export function openDb(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * Liveness probe for `GET /api/health`. Returns `'ok'` when the DB answers a
 * trivial query, `'unavailable'` otherwise — never a guess (standing rule 5).
 */
export function probeDb(db: Database.Database): 'ok' | 'unavailable' {
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1 ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
