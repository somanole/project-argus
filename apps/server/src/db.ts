import Database from 'better-sqlite3';

/**
 * M0 placeholder database. No schema beyond a liveness probe — the real
 * cache/native-table split arrives in M2. This exists only to prove the
 * better-sqlite3 native binding loads and answers a query on this machine,
 * which is the meaningful "dev environment runs end to end" signal for M0.
 *
 * In-memory by design here: M0 stores nothing. When persistence lands, the
 * sacred native tables (ownership, identity merges, audit log) live in a file
 * DB and are never touched by resync (PLAN.md, principle 3).
 */
export function openPlaceholderDb(): Database.Database {
  return new Database(':memory:');
}

/**
 * Returns `'ok'` when SQLite is reachable and answers a trivial query,
 * `'unavailable'` otherwise. Never guesses — an unreachable DB is reported
 * as unavailable, not silently coerced to ok (standing rule 5).
 */
export function probeDb(): 'ok' | 'unavailable' {
  try {
    const db = openPlaceholderDb();
    try {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      return row?.ok === 1 ? 'ok' : 'unavailable';
    } finally {
      db.close();
    }
  } catch {
    return 'unavailable';
  }
}
