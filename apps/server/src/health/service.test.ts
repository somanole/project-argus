import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { N8nExecution } from '@argus/shared';
import { migrate } from '../db/migrate.js';
import { replaceInstanceWorkflows, listWorkflows, type CacheWorkflow } from '../workflows/repo.js';
import { syncHealth } from './service.js';
import { healthEstate } from './repo.js';

const NOW = Date.parse('2026-07-06T12:00:00.000Z');
const ISO = '2026-07-06T00:00:00.000Z';

function wf(id: string, name: string): CacheWorkflow {
  return { id, name, active: true, isArchived: false, projectId: null, projectName: null, updatedAt: ISO, versionId: 'v', facts: null, enrichmentInput: null, enrichmentInputHash: null };
}
const ex = (workflowId: string, status: string): N8nExecution => ({ id: `${workflowId}-${status}-${Math.random()}`, status, workflowId, startedAt: ISO, stoppedAt: ISO });

function seedDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare('INSERT INTO connections (id,label,base_url,api_key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('prod', 'prod', 'http://localhost:5678', 'x', ISO, ISO);
  replaceInstanceWorkflows(db, 'prod', [wf('fail', 'Stripe'), wf('mix', 'Zendesk'), wf('ok', 'Order Intake'), wf('idle', 'Slack Alert')], ISO);
  return db;
}

describe('syncHealth over a seeded instance', () => {
  let db: Database.Database;
  beforeEach(() => { db = seedDb(); });

  it('classifies each workflow and marks the run-less one idle', async () => {
    const reader = {
      listExecutions: async (): Promise<N8nExecution[]> => [
        ex('fail', 'error'), ex('fail', 'error'), ex('fail', 'error'), ex('fail', 'error'),
        ex('mix', 'success'), ex('mix', 'error'), ex('mix', 'success'), ex('mix', 'error'),
        ex('ok', 'success'), ex('ok', 'success'),
        // 'idle' gets no executions
      ],
    };
    const res = await syncHealth(db, 'prod', reader, { windowHours: 336, now: NOW });
    expect(res.available).toBe(true);

    const byName = new Map(listWorkflows(db).map((w) => [w.name, w.health]));
    expect(byName.get('Stripe')?.status).toBe('failing');
    expect(byName.get('Zendesk')?.status).toBe('degraded');
    expect(byName.get('Order Intake')?.status).toBe('healthy');
    expect(byName.get('Slack Alert')?.status).toBe('idle');
    expect(byName.get('Slack Alert')?.windowHours).toBe(336);
  });

  it('marks the whole instance unknown (never healthy) when executions can\'t be read', async () => {
    const reader = {
      listExecutions: async (): Promise<N8nExecution[]> => { throw new Error('HTTP 403'); },
    };
    const res = await syncHealth(db, 'prod', reader, {
      windowHours: 336, now: NOW, reasonForError: () => 'executions unavailable — missing execution:list',
    });
    expect(res.available).toBe(false);
    const all = listWorkflows(db);
    expect(all.every((w) => w.health?.status === 'unknown')).toBe(true);
    expect(all[0]?.health?.unavailableReason).toContain('execution:list');
  });
});

describe('healthEstate feed', () => {
  it('lists failing then degraded, with summary counts and a per-instance window', async () => {
    const db = seedDb();
    const reader = {
      listExecutions: async (): Promise<N8nExecution[]> => [
        ex('fail', 'error'), ex('fail', 'error'),
        ex('mix', 'success'), ex('mix', 'error'),
        ex('ok', 'success'),
      ],
    };
    await syncHealth(db, 'prod', reader, { windowHours: 336, now: NOW });
    const estate = healthEstate(db);
    expect(estate.failing.map((w) => w.name)).toContain('Stripe');
    expect(estate.degraded.map((w) => w.name)).toContain('Zendesk');
    expect(estate.summary.failing).toBe(1);
    expect(estate.summary.degraded).toBe(1);
    expect(estate.summary.healthy).toBe(1);
    expect(estate.summary.idle).toBe(1);
    expect(estate.windows[0]?.windowHours).toBe(336);
    expect(estate.windows[0]?.available).toBe(true);
  });
});
