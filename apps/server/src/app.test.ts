import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

// Mock the n8n client so route tests are hermetic (no live n8n). The fake
// instance validates OK and returns one workflow in one project.
vi.mock('./n8n/client.js', () => ({
  createN8nClient: () => ({
    testConnection: async () => ({ status: 'ok', error: null }),
    listWorkflows: async () => [
      {
        id: 'w1', name: 'Alpha', active: true, isArchived: false,
        createdAt: '2026-07-04T00:00:00.000Z', updatedAt: '2026-07-04T00:00:00.000Z',
        versionId: 'v1', shared: [{ role: 'workflow:owner', projectId: 'p1' }],
      },
    ],
    listProjects: async () => [{ id: 'p1', name: 'Revenue Ops', type: 'team' }],
  }),
  statusForError: () => 'unreachable',
  reason: (e: unknown) => (e instanceof Error ? e.message : 'err'),
  HttpError: class extends Error {},
}));

const { createApp } = await import('./app.js');
const { openDb } = await import('./db/index.js');
const { createSyncEngine } = await import('./sync/engine.js');

const config = { adminPassword: 'pw', sessionSecret: 's', encryptionKey: 'e' };
const SECRET_KEY = 'my-real-n8n-api-key';

function build() {
  const db = openDb(':memory:');
  const engine = createSyncEngine(db, config.encryptionKey, 999_999);
  return createApp({ db, engine, config });
}

describe('Argus API', () => {
  let app: ReturnType<typeof build>;
  beforeEach(() => {
    app = build();
  });

  it('GET /api/health is public and reports the DB', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ service: 'argus-server', status: 'ok', db: 'ok' });
  });

  it('requires a session for everything else', async () => {
    expect((await request(app).get('/api/workflows')).status).toBe(401);
    expect((await request(app).get('/api/connections')).status).toBe(401);
  });

  it('rejects a wrong password without revealing why', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'nope', name: 'Sam', email: 'sam@acme.example' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid credentials');
  });

  it('logs in with the admin password + asserted identity', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'pw', name: 'Sam Rivers', email: 'sam@acme.example' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true, actor: { name: 'Sam Rivers', email: 'sam@acme.example' } });
    expect(res.headers['set-cookie']?.[0]).toMatch(/argus_session=/);
  });

  it('registers a connection, syncs it, and never returns the API key', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam', email: 'sam@acme.example' });

    const reg = await agent.post('/api/connections').send({ label: 'prod', baseUrl: 'http://localhost:5678', apiKey: SECRET_KEY });
    expect(reg.status).toBe(201);
    expect(reg.body.connection.health).toMatchObject({ status: 'ok', workflowCount: 1 });
    expect(JSON.stringify(reg.body)).not.toContain(SECRET_KEY);

    const list = await agent.get('/api/connections');
    expect(JSON.stringify(list.body)).not.toContain(SECRET_KEY);

    const wfs = await agent.get('/api/workflows');
    expect(wfs.body.workflows).toHaveLength(1);
    expect(wfs.body.workflows[0]).toMatchObject({ name: 'Alpha', project: 'Revenue Ops', instanceLabel: 'prod' });
  });

  it('filters the estate by instance', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam', email: 'sam@acme.example' });
    const reg = await agent.post('/api/connections').send({ label: 'prod', baseUrl: 'http://localhost:5678', apiKey: SECRET_KEY });
    const id = reg.body.connection.id as string;

    expect((await agent.get(`/api/workflows?instanceId=${id}`)).body.workflows).toHaveLength(1);
    expect((await agent.get('/api/workflows?instanceId=does-not-exist')).body.workflows).toHaveLength(0);
  });

  it('removes a connection and drops its cached workflows', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam', email: 'sam@acme.example' });
    const reg = await agent.post('/api/connections').send({ label: 'prod', baseUrl: 'http://localhost:5678', apiKey: SECRET_KEY });
    const id = reg.body.connection.id as string;

    expect((await agent.delete(`/api/connections/${id}`)).status).toBe(204);
    expect((await agent.get('/api/workflows')).body.workflows).toHaveLength(0);
    expect((await agent.get('/api/connections')).body.connections).toHaveLength(0);
  });
});
