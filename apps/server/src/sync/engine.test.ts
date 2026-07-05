import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { N8nWorkflowListItem, N8nProject } from '@argus/shared';
import { openDb } from '../db/index.js';
import { createConnection } from '../connections/repo.js';
import { listWorkflows } from '../workflows/repo.js';
import { createSyncEngine, type N8nReaderFactory } from './engine.js';
import { HttpError } from '../n8n/client.js';

const ACTOR = { name: 'Sam', email: 'sam@acme.example' };
const ENC = 'k';

function wf(partial: Partial<N8nWorkflowListItem> & { id: string; name: string }): N8nWorkflowListItem {
  return {
    active: false,
    isArchived: false,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    versionId: 'v1',
    shared: [{ role: 'workflow:owner', projectId: 'p1' }],
    ...partial,
  };
}

const PROJECTS: N8nProject[] = [{ id: 'p1', name: 'Revenue Ops', type: 'team' }];

describe('sync engine — reconciliation is the source of truth', () => {
  let db: Database.Database;
  // Mutable "live n8n" state the fake reader returns.
  let state: { workflows: N8nWorkflowListItem[]; projects: N8nProject[]; throw?: unknown };
  let factory: N8nReaderFactory;
  let connId: string;

  beforeEach(() => {
    db = openDb(':memory:');
    state = { workflows: [wf({ id: 'w1', name: 'Alpha', active: true })], projects: PROJECTS };
    factory = () => ({
      listProjects: async () => {
        if (state.throw) throw state.throw;
        return state.projects;
      },
      listWorkflows: async () => {
        if (state.throw) throw state.throw;
        return state.workflows;
      },
    });
    connId = createConnection(db, ACTOR, { label: 'prod', baseUrl: 'http://x', apiKey: 'k' }, ENC).id;
  });

  it('populates the cache and resolves the owning project name', async () => {
    const engine = createSyncEngine(db, ENC, 999_999, factory);
    await engine.syncNow(connId);
    const list = listWorkflows(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Alpha', active: true, project: 'Revenue Ops', instanceLabel: 'prod' });
    expect(engine.health(connId)).toMatchObject({ status: 'ok', workflowCount: 1 });
  });

  it('reflects an edit (rename + activate flip) on the next sync', async () => {
    const engine = createSyncEngine(db, ENC, 999_999, factory);
    await engine.syncNow(connId);
    state.workflows = [wf({ id: 'w1', name: 'Alpha renamed', active: false })];
    await engine.syncNow(connId);
    const list = listWorkflows(db);
    expect(list[0]).toMatchObject({ name: 'Alpha renamed', active: false });
  });

  it('reflects an archive transition (keeps the row, flips the flag)', async () => {
    const engine = createSyncEngine(db, ENC, 999_999, factory);
    await engine.syncNow(connId);
    state.workflows = [wf({ id: 'w1', name: 'Alpha', isArchived: true })];
    await engine.syncNow(connId);
    expect(listWorkflows(db)[0]).toMatchObject({ isArchived: true });
  });

  it('removes a workflow that vanished from n8n (deletion cascade)', async () => {
    state.workflows = [wf({ id: 'w1', name: 'Alpha' }), wf({ id: 'w2', name: 'Beta' })];
    const engine = createSyncEngine(db, ENC, 999_999, factory);
    await engine.syncNow(connId);
    expect(listWorkflows(db)).toHaveLength(2);
    state.workflows = [wf({ id: 'w1', name: 'Alpha' })];
    await engine.syncNow(connId);
    expect(listWorkflows(db).map((w) => w.id)).toEqual(['w1']);
  });

  it('records "couldn\'t resolve" project as null, never a guess', async () => {
    state.workflows = [wf({ id: 'w1', name: 'Orphan', shared: [{ role: 'workflow:owner', projectId: 'ghost' }] })];
    const engine = createSyncEngine(db, ENC, 999_999, factory);
    await engine.syncNow(connId);
    expect(listWorkflows(db)[0]?.project).toBeNull();
  });

  it('on an unreachable instance, keeps the last-known cache and reports honestly', async () => {
    const engine = createSyncEngine(db, ENC, 999_999, factory);
    await engine.syncNow(connId); // 1 workflow cached, ok
    state.throw = new Error('connect ECONNREFUSED');
    await engine.syncNow(connId);
    expect(listWorkflows(db)).toHaveLength(1); // stale, not wiped
    expect(engine.health(connId)).toMatchObject({ status: 'unreachable', workflowCount: 1 });
    expect(engine.health(connId).lastError).toContain('ECONNREFUSED');
  });

  it('classifies a rejected key as unauthorized', async () => {
    state.throw = new HttpError(401);
    const engine = createSyncEngine(db, ENC, 999_999, factory);
    await engine.syncNow(connId);
    expect(engine.health(connId).status).toBe('unauthorized');
  });

  it('self-heals after downtime: a fresh engine on the same db reconciles the estate', async () => {
    const engine1 = createSyncEngine(db, ENC, 999_999, factory);
    await engine1.syncNow(connId);
    // Argus was "down"; meanwhile n8n changed.
    state.workflows = [wf({ id: 'w2', name: 'Created while down' })];
    const engine2 = createSyncEngine(db, ENC, 999_999, factory);
    await engine2.syncNow(connId);
    expect(listWorkflows(db).map((w) => w.name)).toEqual(['Created while down']);
    expect(engine2.health(connId).status).toBe('ok');
  });
});
