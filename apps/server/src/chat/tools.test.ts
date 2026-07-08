import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { replaceInstanceWorkflows, type CacheWorkflow } from '../workflows/repo.js';
import { buildChatTools } from './tools.js';

/**
 * Cross-instance workflow resolution (user-reported bug): two workflows sharing a name on
 * different instances must resolve when the user names the instance — by its id OR its
 * label ("prod"/"staging"), or via a "(prod)" suffix on the name — instead of looping on
 * the disambiguation prompt forever.
 */
const ISO = '2026-07-07T00:00:00.000Z';
const PROD = '9675a3b9-b0eb-45d4-9dea-c83d8f1621e5';
const STAGING = '450cd901-817d-4c10-8252-d5860bd9690b';

function wf(id: string, name: string): CacheWorkflow {
  return { id, name, active: true, isArchived: false, projectId: null, projectName: null, updatedAt: ISO, versionId: 'v', facts: null, enrichmentInput: null, enrichmentInputHash: null };
}
function seed(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare('INSERT INTO connections (id,label,base_url,api_key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(PROD, 'Production', 'http://localhost/prod', 'x', ISO, ISO);
  db.prepare('INSERT INTO connections (id,label,base_url,api_key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(STAGING, 'staging', 'http://localhost/staging', 'x', ISO, ISO);
  replaceInstanceWorkflows(db, PROD, [wf('ra-prod', 'Route Asset #32')], ISO);
  replaceInstanceWorkflows(db, STAGING, [wf('ra-stg', 'Route Asset #32')], ISO);
  return db;
}
const detailTool = (db: Database.Database) => buildChatTools(db, () => {}).find((t) => t.name === 'get_workflow_detail')!;
type Detail = { found: boolean; ambiguous?: boolean; candidates?: unknown[]; workflow?: { instanceId: string; id: string; instance: string } };
const get = (db: Database.Database, input: { name: string; instanceId: string; id: string }) => detailTool(db).execute(input) as Promise<Detail>;

describe('get_workflow_detail — cross-instance disambiguation', () => {
  it('returns candidates when a name matches two instances and no instance is given', async () => {
    const r = await get(seed(), { name: 'Route Asset #32', instanceId: '', id: '' });
    expect(r.found).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toHaveLength(2);
  });

  it('resolves to one when the instance is given by LABEL ("prod" matches "Production")', async () => {
    const r = await get(seed(), { name: 'Route Asset #32', instanceId: 'prod', id: '' });
    expect(r.found).toBe(true);
    expect(r.workflow!.instanceId).toBe(PROD);
  });

  it('resolves when the instance is given by its exact label ("staging")', async () => {
    const r = await get(seed(), { name: 'Route Asset #32', instanceId: 'staging', id: '' });
    expect(r.found).toBe(true);
    expect(r.workflow!.instanceId).toBe(STAGING);
  });

  it('resolves when the instance is given by its real id (UUID), even without a workflow id', async () => {
    const r = await get(seed(), { name: 'Route Asset #32', instanceId: PROD, id: '' });
    expect(r.found).toBe(true);
    expect(r.workflow!.instanceId).toBe(PROD);
  });

  it('resolves a "(staging)" suffix on the name as an instance hint', async () => {
    const r = await get(seed(), { name: 'Route Asset #32 (staging)', instanceId: '', id: '' });
    expect(r.found).toBe(true);
    expect(r.workflow!.instanceId).toBe(STAGING);
  });

  it('resolves precisely with instanceId (UUID) + workflow id', async () => {
    const r = await get(seed(), { name: '', instanceId: PROD, id: 'ra-prod' });
    expect(r.found).toBe(true);
    expect(r.workflow!.id).toBe('ra-prod');
  });
});
