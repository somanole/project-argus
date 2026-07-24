import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { SessionActor } from '@argus/shared';
import { migrate } from '../db/migrate.js';
import { appendAudit } from '../db/audit.js';
import { listAudit, countAudit, DEMO_ACTOR_NAME, DEMO_ACTOR_EMAIL } from './read.js';

/**
 * Public-demo redaction (`ARGUS_DEMO_MODE=true`).
 *
 * Argus stamps the asserted identity of whoever signs in onto every audit entry, so on
 * a public demo one visitor's name/email would be visible to the next. Demo mode masks
 * the actor on every audit READ — server-side, because a public API that returned the
 * real values would leak them to anyone calling it directly — while the DB row keeps
 * the real actor so the append-only record stays complete.
 */

const VISITOR: SessionActor = { name: 'Jane Visitor', email: 'jane@realcompany.com' };

function seed(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  appendAudit(db, VISITOR, { action: 'ownership.assign', entityType: 'workflow', entityId: 'w1', detail: null });
  appendAudit(db, { name: 'Ops', email: 'ops@argus.io' }, { action: 'auth.login', entityType: 'session', entityId: null, detail: null });
  return db;
}

afterEach(() => { delete process.env.ARGUS_DEMO_MODE; });

describe('audit reads — public-demo redaction', () => {
  beforeEach(() => { delete process.env.ARGUS_DEMO_MODE; });

  it('returns the real actor when demo mode is off', () => {
    const db = seed();
    const entries = listAudit(db);
    expect(entries.map((e) => e.actorEmail)).toContain('jane@realcompany.com');
    db.close();
  });

  it('masks every actor name and email when demo mode is on', () => {
    process.env.ARGUS_DEMO_MODE = 'true';
    const db = seed();
    const entries = listAudit(db);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.actorName).toBe(DEMO_ACTOR_NAME);
      expect(e.actorEmail).toBe(DEMO_ACTOR_EMAIL);
    }
    // No visitor identity survives anywhere in the serialised payload.
    const json = JSON.stringify(entries);
    expect(json).not.toContain('jane@realcompany.com');
    expect(json).not.toContain('Jane Visitor');
    db.close();
  });

  it('keeps the real actor in the database — redaction is read-side only', () => {
    process.env.ARGUS_DEMO_MODE = 'true';
    const db = seed();
    listAudit(db);
    const row = db.prepare('SELECT actor_email FROM audit_log ORDER BY id').get() as { actor_email: string };
    expect(row.actor_email).toBe('jane@realcompany.com');
    db.close();
  });

  it('ignores the actor filter in demo mode, so it cannot be used to probe for a person', () => {
    const db = seed();
    // Off: the filter works and narrows the result.
    expect(listAudit(db, { actor: 'jane' })).toHaveLength(1);
    expect(countAudit(db, { actor: 'jane' })).toBe(1);

    process.env.ARGUS_DEMO_MODE = 'true';
    // On: the filter is dropped, so a hit cannot confirm that person was here.
    expect(listAudit(db, { actor: 'jane' })).toHaveLength(2);
    expect(countAudit(db, { actor: 'jane' })).toBe(2);
    expect(countAudit(db, { actor: 'nobody-by-this-name' })).toBe(2);
    db.close();
  });

  it('still filters by action in demo mode (only the actor filter is suppressed)', () => {
    process.env.ARGUS_DEMO_MODE = 'true';
    const db = seed();
    expect(listAudit(db, { action: 'auth.login' })).toHaveLength(1);
    expect(countAudit(db, { action: 'ownership' })).toBe(1);
    db.close();
  });
});
