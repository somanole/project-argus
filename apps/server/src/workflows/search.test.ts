import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { SessionActor } from '@argus/shared';
import { migrate } from '../db/migrate.js';
import { replaceInstanceWorkflows, listWorkflows, countWorkflows, type CacheWorkflow } from './repo.js';
import { assignOwner, replaceInferredOwners } from '../ownership/repo.js';

const ISO = '2026-07-06T00:00:00.000Z';
const ACTOR: SessionActor = { name: 'Ops Admin', email: 'ops@argus.io' };

function wf(id: string, name: string): CacheWorkflow {
  return { id, name, active: true, isArchived: false, projectId: null, projectName: null, updatedAt: ISO, versionId: 'v', facts: null, enrichmentInput: null, enrichmentInputHash: null };
}

/** Estate: 'a' assigned to Sam, 'b' inferred to Priya, 'c' unowned. */
function seed(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare('INSERT INTO connections (id,label,base_url,api_key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('prod', 'prod', 'http://localhost/prod', 'x', ISO, ISO);
  replaceInstanceWorkflows(db, 'prod', [wf('a', 'Billing Sync'), wf('b', 'Reconcile Ledger'), wf('c', 'Nightly ETL')], ISO);
  assignOwner(db, ACTOR, 'prod', 'a', { ownerEmail: 'sam@corp.io', ownerName: 'Sam Rivers' });
  replaceInferredOwners(db, 'prod', [
    { workflowId: 'b', ownerEmail: 'priya@n8n.io', ownerName: 'Priya Member', source: 'project-member', memberRole: 'project:admin', reason: null },
  ], ISO);
  return db;
}

/** The list and its count denominator must always agree for the same filter. */
function idsFor(db: Database.Database, q: string): string[] {
  const rows = listWorkflows(db, { q });
  expect(countWorkflows(db, { q })).toBe(rows.length); // list ⇔ count invariant
  return rows.map((r) => r.id).sort();
}

describe('catalog search matches the resolved owner (assigned or inferred)', () => {
  let db: Database.Database;
  beforeEach(() => { db = seed(); });

  it('still matches on the workflow name', () => {
    expect(idsFor(db, 'reconcile')).toEqual(['b']);
    expect(idsFor(db, 'sync')).toEqual(['a']);
  });

  it('matches an assigned owner by name and by email', () => {
    expect(idsFor(db, 'sam')).toEqual(['a']);
    expect(idsFor(db, 'rivers')).toEqual(['a']);
    expect(idsFor(db, 'sam@corp')).toEqual(['a']);
  });

  it('matches an inferred (advisory) owner by name and by email', () => {
    expect(idsFor(db, 'priya')).toEqual(['b']);
    expect(idsFor(db, 'priya@n8n')).toEqual(['b']);
  });

  it('an unowned workflow is only found by its name, never a fabricated owner', () => {
    expect(idsFor(db, 'nightly')).toEqual(['c']);
    expect(idsFor(db, 'nobody')).toEqual([]);
  });

  it('when a workflow is assigned, the assigned owner wins — a shadowed inferred name does not surface it', () => {
    // 'a' is assigned to Sam but ALSO carries an inferred hint for someone else; search shows the
    // displayed (assigned) owner only, so a result never contradicts the owner shown on the card.
    replaceInferredOwners(db, 'prod', [
      { workflowId: 'a', ownerEmail: 'ghost@n8n.io', ownerName: 'Ghost Inferred', source: 'project-member', memberRole: 'project:viewer', reason: null },
    ], ISO);
    expect(idsFor(db, 'sam')).toEqual(['a']);      // displayed owner still matches
    expect(idsFor(db, 'ghost')).toEqual([]);        // shadowed inferred name does not
  });
});
