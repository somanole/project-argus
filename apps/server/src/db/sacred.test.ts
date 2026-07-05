import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from './index.js';
import { withAudit } from './audit.js';
import {
  createConnection,
  deleteConnection,
  getConnectionRow,
  listConnectionRows,
  decryptApiKey,
} from '../connections/repo.js';
import { replaceInstanceWorkflows, countByInstance } from '../workflows/repo.js';

const ACTOR = { name: 'Sam Rivers', email: 'sam@acme.example' };
const ENC = 'test-encryption-key';

function auditRows(db: Database.Database) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id').all() as Array<Record<string, unknown>>;
}

describe('sacred tables (rule 6)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('migrates the schema (connections, audit_log, workflows)', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['connections', 'audit_log', 'workflows']));
  });

  it('writes the mutation and its audit entry in one transaction', () => {
    const row = createConnection(db, ACTOR, { label: 'prod', baseUrl: 'http://localhost:5678', apiKey: 'secret-key' }, ENC);
    expect(listConnectionRows(db)).toHaveLength(1);
    const audit = auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'connection.register', entity_type: 'connection', entity_id: row.id, actor_email: ACTOR.email });
  });

  it('rolls back BOTH the mutation and the audit entry if the mutation throws', () => {
    expect(() =>
      withAudit(db, ACTOR, { action: 'x', entityType: 'connection', entityId: null }, () => {
        db.prepare('INSERT INTO connections (id,label,base_url,api_key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?)')
          .run('id1', 'l', 'u', 'c', 't', 't');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(listConnectionRows(db)).toHaveLength(0);
    expect(auditRows(db)).toHaveLength(0);
  });

  it('never bulk-deletes or rewrites the audit log (append-only trigger)', () => {
    createConnection(db, ACTOR, { label: 'prod', baseUrl: 'http://x', apiKey: 'k' }, ENC);
    expect(() => db.prepare('UPDATE audit_log SET actor_name = ?').run('hacker')).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });

  it('stores the API key encrypted, decryptable in-process, never in clear text', () => {
    const row = createConnection(db, ACTOR, { label: 'prod', baseUrl: 'http://x', apiKey: 'super-secret-key' }, ENC);
    const stored = getConnectionRow(db, row.id)!;
    expect(stored.api_key_cipher).not.toContain('super-secret-key');
    expect(decryptApiKey(stored, ENC)).toBe('super-secret-key');
    // The audit detail must not carry the key either.
    expect(JSON.stringify(auditRows(db))).not.toContain('super-secret-key');
  });

  it('removing a connection cascades its cached workflows and audits the removal', () => {
    const row = createConnection(db, ACTOR, { label: 'prod', baseUrl: 'http://x', apiKey: 'k' }, ENC);
    replaceInstanceWorkflows(db, row.id, [
      { id: 'w1', name: 'A', active: true, isArchived: false, projectId: null, projectName: null, updatedAt: null, versionId: null },
    ], new Date().toISOString());
    expect(countByInstance(db, row.id)).toBe(1);

    expect(deleteConnection(db, ACTOR, row.id)).toBe(true);
    expect(countByInstance(db, row.id)).toBe(0);
    expect(auditRows(db).map((a) => a.action)).toEqual(['connection.register', 'connection.remove']);
  });

  it('reports removing a missing connection as false, with no audit entry', () => {
    expect(deleteConnection(db, ACTOR, 'nope')).toBe(false);
    expect(auditRows(db)).toHaveLength(0);
  });
});
