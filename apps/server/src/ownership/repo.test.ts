import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { SessionActor } from '@argus/shared';
import { migrate } from '../db/migrate.js';
import { replaceInstanceWorkflows, listWorkflows, type CacheWorkflow } from '../workflows/repo.js';
import {
  assignOwner,
  setBackupOwner,
  removeOwner,
  resolveOwner,
  replaceInferredOwners,
  listUnowned,
  singleOwnerCritical,
  personalSpaceCritical,
  noBackupOwner,
  ownershipRegister,
} from './repo.js';

const ISO = '2026-07-06T00:00:00.000Z';
const ACTOR: SessionActor = { name: 'Ops Admin', email: 'ops@argus.io' };

function wf(id: string, name: string): CacheWorkflow {
  return { id, name, active: true, isArchived: false, projectId: null, projectName: null, updatedAt: ISO, versionId: 'v', facts: null, enrichmentInput: null, enrichmentInputHash: null };
}

function enrich(db: Database.Database, instanceId: string, workflowId: string, criticality: string): void {
  db.prepare(
    `INSERT INTO workflow_enrichments
       (instance_id, workflow_id, input_hash, provider, model, prompt_version, schema_version, status, enrichment_json, corrected_json, enriched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(instanceId, workflowId, 'h', 'openai', 'gpt', 'p1', 1, 'analyzed', JSON.stringify({ criticality, criticalityReason: 'handles money' }), null, ISO);
}

function auditCount(db: Database.Database, prefix = 'ownership'): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE ?').get(`${prefix}%`) as { n: number }).n;
}

function seedDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  for (const [id, label] of [['prod', 'prod'], ['staging', 'staging']]) {
    db.prepare('INSERT INTO connections (id,label,base_url,api_key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, label, `http://localhost/${id}`, 'x', ISO, ISO);
  }
  return db;
}

describe('ownership mutations are audited (guarantee ii)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = seedDb();
    replaceInstanceWorkflows(db, 'prod', [wf('a', 'Billing'), wf('b', 'Reconcile')], ISO);
  });

  it('assign → workflow reads assigned + exactly one audit entry with before→after', () => {
    expect(auditCount(db)).toBe(0);
    const resolved = assignOwner(db, ACTOR, 'prod', 'a', { ownerEmail: 'sam@corp.io', ownerName: 'Sam Rivers', reason: 'owns billing' });
    expect(resolved.status).toBe('assigned');
    expect(resolved.owner).toEqual({ email: 'sam@corp.io', name: 'Sam Rivers' });
    expect(auditCount(db)).toBe(1);

    const entry = db.prepare("SELECT * FROM audit_log WHERE action = 'ownership.assign'").get() as {
      actor_email: string; entity_type: string; entity_id: string; detail_json: string;
    };
    expect(entry.actor_email).toBe('ops@argus.io');
    expect(entry.entity_type).toBe('workflow_ownership');
    expect(entry.entity_id).toBe('prod/a');
    const detail = JSON.parse(entry.detail_json);
    expect(detail.before.ownerEmail).toBeNull();
    expect(detail.after.ownerEmail).toBe('sam@corp.io');
  });

  it('reassign, backup, remove each write their own audit entry (mutation count == audit count)', () => {
    assignOwner(db, ACTOR, 'prod', 'a', { ownerEmail: 'sam@corp.io', ownerName: 'Sam' }); // 1: assign
    assignOwner(db, ACTOR, 'prod', 'a', { ownerEmail: 'dana@corp.io', ownerName: 'Dana' }); // 2: reassign
    setBackupOwner(db, ACTOR, 'prod', 'a', { backupOwnerEmail: 'rob@corp.io', backupOwnerName: 'Rob' }); // 3: backup
    removeOwner(db, ACTOR, 'prod', 'a', 'left the team'); // 4: remove

    expect(auditCount(db)).toBe(4);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='ownership.reassign'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='ownership.backup.set'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='ownership.remove'").get() as { n: number }).n).toBe(1);
    // After remove, the assignment is gone (falls back to unowned).
    expect(resolveOwner(db, 'prod', 'a').status).toBe('unowned');
  });

  it('removeOwner on an unowned workflow is a no-op and writes nothing', () => {
    expect(removeOwner(db, ACTOR, 'prod', 'b')).toBe(false);
    expect(auditCount(db)).toBe(0);
  });
});

describe('ownership survives a full resync (guarantee i)', () => {
  it('an assignment is not wiped by replaceInstanceWorkflows', () => {
    const db = seedDb();
    replaceInstanceWorkflows(db, 'prod', [wf('a', 'Billing')], ISO);
    assignOwner(db, ACTOR, 'prod', 'a', { ownerEmail: 'sam@corp.io', ownerName: 'Sam' });
    expect(resolveOwner(db, 'prod', 'a').status).toBe('assigned');

    // Full inventory resync (delete + reinsert the workflow rows).
    replaceInstanceWorkflows(db, 'prod', [wf('a', 'Billing (renamed)'), wf('c', 'New WF')], '2026-07-07T00:00:00.000Z');

    const resolved = resolveOwner(db, 'prod', 'a');
    expect(resolved.status).toBe('assigned');
    expect(resolved.owner?.email).toBe('sam@corp.io');
    // And it rides on the list item too.
    const item = listWorkflows(db, { instanceId: 'prod' }).find((w) => w.id === 'a');
    expect(item?.owner?.status).toBe('assigned');
  });
});

describe('resolved owner: assigned overrides inferred; honest degradation', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = seedDb();
    replaceInstanceWorkflows(db, 'prod', [wf('a', 'Billing'), wf('b', 'Report')], ISO);
  });

  it('inferred shows as advisory, then assignment overrides it', () => {
    replaceInferredOwners(db, 'prod', [
      { workflowId: 'a', ownerEmail: 'priya@n8n.io', ownerName: 'Priya Member', source: 'project-member', memberRole: 'project:admin', reason: null },
    ], ISO);
    let item = listWorkflows(db, { instanceId: 'prod' }).find((w) => w.id === 'a');
    expect(item?.owner?.status).toBe('inferred');
    expect(item?.owner?.owner?.email).toBe('priya@n8n.io');
    expect(item?.owner?.memberRole).toBe('project:admin');

    assignOwner(db, ACTOR, 'prod', 'a', { ownerEmail: 'sam@corp.io', ownerName: 'Sam' });
    item = listWorkflows(db, { instanceId: 'prod' }).find((w) => w.id === 'a');
    expect(item?.owner?.status).toBe('assigned');
    expect(item?.owner?.owner?.email).toBe('sam@corp.io');
  });

  it('an unavailable inference reads unowned with a reason, never a fabricated name', () => {
    replaceInferredOwners(db, 'prod', [
      { workflowId: 'b', ownerEmail: null, ownerName: null, source: 'unavailable', memberRole: null, reason: "couldn't infer — key may lack user:list" },
    ], ISO);
    const item = listWorkflows(db, { instanceId: 'prod' }).find((w) => w.id === 'b');
    expect(item?.owner?.status).toBe('unowned');
    expect(item?.owner?.owner).toBeNull();
    expect(item?.owner?.reason).toContain('user:list');
  });
});

describe('governance gaps', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = seedDb();
    // prod: two criticals owned by Sam; staging: one more critical owned by the SAME email.
    replaceInstanceWorkflows(db, 'prod', [wf('p1', 'Stripe Recon'), wf('p2', 'Invoice Dispatch'), wf('p3', 'Newsletter')], ISO);
    replaceInstanceWorkflows(db, 'staging', [wf('s1', 'Refund Processor'), wf('s2', 'Personal Ops Hack')], ISO);
    enrich(db, 'prod', 'p1', 'critical');
    enrich(db, 'prod', 'p2', 'critical');
    enrich(db, 'prod', 'p3', 'low');
    enrich(db, 'staging', 's1', 'critical');
    enrich(db, 'staging', 's2', 'critical');
  });

  it('single-owner-critical groups by email ACROSS instances (exact-email, cross-instance flagged)', () => {
    assignOwner(db, ACTOR, 'prod', 'p1', { ownerEmail: 'sam@corp.io', ownerName: 'Sam Rivers' });
    assignOwner(db, ACTOR, 'prod', 'p2', { ownerEmail: 'sam@corp.io', ownerName: 'Sam Rivers' });
    assignOwner(db, ACTOR, 'staging', 's1', { ownerEmail: 'sam@corp.io', ownerName: 'Sam Rivers' });

    const gaps = singleOwnerCritical(db);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.owner.email).toBe('sam@corp.io');
    expect(gaps[0]?.workflows).toHaveLength(3);
    expect(gaps[0]?.crossInstance).toBe(true);
  });

  it('a person owning a single critical is NOT a single-owner-critical gap', () => {
    assignOwner(db, ACTOR, 'prod', 'p1', { ownerEmail: 'solo@corp.io', ownerName: 'Solo' });
    expect(singleOwnerCritical(db)).toHaveLength(0);
  });

  it('personal-space-critical surfaces a critical workflow inferred to a personal project', () => {
    replaceInferredOwners(db, 'staging', [
      { workflowId: 's2', ownerEmail: 'diana@n8n.io', ownerName: 'Diana', source: 'personal-project', memberRole: null, reason: null },
    ], ISO);
    const gaps = personalSpaceCritical(db);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.workflowId).toBe('s2');
    expect(gaps[0]?.person?.email).toBe('diana@n8n.io');
  });

  it('ownershipRegister composes owner + backup + risk flags with an honest posture summary (rule 12)', () => {
    assignOwner(db, ACTOR, 'prod', 'p1', { ownerEmail: 'sam@corp.io', ownerName: 'Sam' }); // confirmed critical, no backup
    // p2/p3/s1/s2 left with no assigned + no inferred → status 'unowned'.
    const reg = ownershipRegister(db, {});
    expect(reg.summary.total).toBe(5);
    expect(reg.summary.confirmed).toBe(1); // only the explicit assignment is factual (rule 12)
    expect(reg.summary.unowned).toBe(4);
    expect(reg.summary.noBackup).toBe(1); // p1: assigned + critical + no backup
    expect(reg.summary.criticalAtRisk).toBe(4); // p1 (no backup) + p2/s1/s2 (unowned criticals)

    const byId = new Map(reg.rows.map((r) => [r.id, r]));
    expect(byId.get('p1')?.risks).toContain('no-backup');
    expect(byId.get('p1')?.risks).not.toContain('no-confirmed-owner'); // it IS assigned
    expect(byId.get('p2')?.risks).toContain('no-confirmed-owner');

    // Filter: needs-owner excludes the confirmed one; risk=no-backup returns exactly p1.
    const needs = ownershipRegister(db, { state: 'needs-owner' });
    expect(needs.total).toBe(4);
    expect(needs.rows.every((r) => r.owner?.status !== 'assigned')).toBe(true);
    expect(ownershipRegister(db, { risk: 'no-backup' }).rows.map((r) => r.id)).toEqual(['p1']);

    // Pagination: limit slices, total is the FILTERED count.
    const page = ownershipRegister(db, { state: 'all', limit: 2, offset: 0 });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it('ownershipRegister search matches the owner — assigned or inferred (search flows by owner)', () => {
    assignOwner(db, ACTOR, 'prod', 'p1', { ownerEmail: 'sam@corp.io', ownerName: 'Sam Rivers' });
    replaceInferredOwners(db, 'staging', [
      { workflowId: 's1', ownerEmail: 'priya@n8n.io', ownerName: 'Priya Member', source: 'project-member', memberRole: 'project:admin', reason: null },
    ], ISO);

    expect(ownershipRegister(db, { q: 'sam' }).rows.map((r) => r.id)).toEqual(['p1']);        // assigned, by name
    expect(ownershipRegister(db, { q: 'sam@corp' }).rows.map((r) => r.id)).toEqual(['p1']);   // assigned, by email
    expect(ownershipRegister(db, { q: 'priya' }).rows.map((r) => r.id)).toEqual(['s1']);      // inferred (advisory)
    expect(ownershipRegister(db, { q: 'invoice' }).rows.map((r) => r.id)).toEqual(['p2']);    // still matches name

    const r = ownershipRegister(db, { q: 'sam' });
    expect(r.total).toBe(r.rows.length); // total tracks the filtered rows
  });

  it('no-backup-owner surfaces an assigned critical with no backup; adding a backup clears it', () => {
    assignOwner(db, ACTOR, 'prod', 'p1', { ownerEmail: 'sam@corp.io', ownerName: 'Sam' });
    expect(noBackupOwner(db).some((g) => g.workflowId === 'p1')).toBe(true);
    setBackupOwner(db, ACTOR, 'prod', 'p1', { backupOwnerEmail: 'rob@corp.io', backupOwnerName: 'Rob' });
    expect(noBackupOwner(db).some((g) => g.workflowId === 'p1')).toBe(false);
  });

  it('listUnowned surfaces unassigned workflows with criticality, critical-first', () => {
    assignOwner(db, ACTOR, 'prod', 'p1', { ownerEmail: 'sam@corp.io', ownerName: 'Sam' });
    const unowned = listUnowned(db);
    const ids = unowned.map((u) => u.workflowId);
    expect(ids).not.toContain('p1'); // assigned → excluded
    expect(ids).toContain('p2');
    // Critical-first: the first unowned item is a critical one.
    expect(unowned[0]?.criticality).toBe('critical');
  });
});
