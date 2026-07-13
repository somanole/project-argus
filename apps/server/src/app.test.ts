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
    listProjects: async () => [{ id: 'p1', name: 'Revenue Ops', type: 'team', creatorId: 'u1' }],
    // One success + one error for w1 → a computable (degraded) health.
    listExecutions: async () => [
      { id: '2', status: 'error', workflowId: 'w1', startedAt: '2026-07-04T01:00:00.000Z', stoppedAt: '2026-07-04T01:00:01.000Z', finished: false },
      { id: '1', status: 'success', workflowId: 'w1', startedAt: '2026-07-04T00:00:00.000Z', stoppedAt: '2026-07-04T00:00:01.000Z', finished: true },
    ],
    // S4 ownership-inference source: p1's most-privileged member is Nathan (admin).
    listProjectMembers: async () => [
      { id: 'u1', email: 'nathan@n8n.io', firstName: 'Nathan', lastName: 'Owner', role: 'project:admin' },
    ],
    listUsers: async () => [
      { id: 'u1', email: 'nathan@n8n.io', firstName: 'Nathan', lastName: 'Owner', role: 'global:owner' },
    ],
  }),
  statusForError: () => 'unreachable',
  reason: (e: unknown) => (e instanceof Error ? e.message : 'err'),
  HttpError: class extends Error {},
  DEFAULT_HEALTH_WINDOW_HOURS: 336,
}));

const { createApp } = await import('./app.js');
const { openDb } = await import('./db/index.js');
const { createSyncEngine } = await import('./sync/engine.js');
const { createEnrichmentWorker } = await import('./enrichment/index.js');

const config = { adminPassword: 'pw', sessionSecret: 's', encryptionKey: 'e', enrichmentEnabled: true, chatEgressEmails: false };
const SECRET_KEY = 'my-real-n8n-api-key';

function build() {
  const db = openDb(':memory:');
  const worker = createEnrichmentWorker({ db, encryptionKey: config.encryptionKey, envAllowed: true, concurrency: 3, spendCapTokens: 0 });
  const engine = createSyncEngine(db, config.encryptionKey, 999_999, undefined, (id) => worker.enqueue(id));
  return createApp({ db, engine, worker, config });
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

  it('audits every login and logout (but not a rejected login) in the self-audit timeline', async () => {
    const agent = request.agent(app);
    // A rejected login must NOT be audited — there is no authenticated actor to attribute.
    await agent.post('/api/auth/login').send({ password: 'wrong', name: 'Mallory', email: 'mallory@x.example' });
    // A successful login, then logout, then log back in so we can read the timeline.
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam Rivers', email: 'sam@acme.example' });
    await agent.post('/api/auth/logout');
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam Rivers', email: 'sam@acme.example' });

    const audit = await agent.get('/api/ownership/audit?action=auth');
    expect(audit.status).toBe(200);
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('auth.login');
    expect(actions).toContain('auth.logout');
    // The rejected attempt left no trace — no entry attributed to Mallory.
    expect(audit.body.entries.some((e: { actorEmail: string }) => e.actorEmail === 'mallory@x.example')).toBe(false);
    // The login entry carries the asserted actor + a `session` entity.
    expect(audit.body.entries.find((e: { action: string }) => e.action === 'auth.login')).toMatchObject({
      actorName: 'Sam Rivers', actorEmail: 'sam@acme.example', entityType: 'session',
    });
    // `auth.login` / `auth.logout` are offered as filter options in the timeline.
    expect(audit.body.actions).toEqual(expect.arrayContaining(['auth.login', 'auth.logout']));
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

  it('LLM settings: stores the key encrypted and NEVER returns it', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam', email: 'sam@acme.example' });

    const before = await agent.get('/api/settings/llm');
    expect(before.body.config).toMatchObject({ provider: null, configured: false });

    const put = await agent.put('/api/settings/llm').send({ provider: 'openai', apiKey: 'sk-super-secret-key-value' });
    expect(put.status).toBe(200);
    expect(put.body.config).toMatchObject({ provider: 'openai', model: 'gpt-5-mini', configured: true, enabled: true });
    expect(JSON.stringify(put.body)).not.toContain('sk-super-secret-key-value');

    const after = await agent.get('/api/settings/llm');
    expect(JSON.stringify(after.body)).not.toContain('sk-super-secret-key-value');
  });

  it('LLM settings: the master switch toggles enrichment on/off (audited)', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam', email: 'sam@acme.example' });

    // Default on.
    expect((await agent.get('/api/settings/llm')).body.config).toMatchObject({ enabled: true, envLocked: false });
    // Turn it off.
    const off = await agent.put('/api/settings/enrichment').send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.config.enabled).toBe(false);
    // Turn it back on.
    const on = await agent.put('/api/settings/enrichment').send({ enabled: true });
    expect(on.body.config.enabled).toBe(true);
  });

  it('exposes enrichment progress (off until a provider is set) with a last-ran field', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam', email: 'sam@acme.example' });
    const res = await agent.get('/api/workflows/enrichment-progress');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, lastEnrichedAt: null });
  });

  it('"Enrich now" accepts the trigger and returns progress', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam', email: 'sam@acme.example' });
    const res = await agent.post('/api/settings/enrichment/run');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ lastEnrichedAt: null });
  });

  it('rejects a correction for a workflow with no enrichment (nothing to correct)', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam', email: 'sam@acme.example' });
    const reg = await agent.post('/api/connections').send({ label: 'prod', baseUrl: 'http://localhost:5678', apiKey: SECRET_KEY });
    const id = reg.body.connection.id as string;
    const res = await agent.put(`/api/workflows/${id}/w1/enrichment/correction`).send({ criticality: 'critical' });
    expect(res.status).toBe(404);
  });

  it('S4: inference rides on the catalog; assign overrides it and lands in the audit timeline', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam Rivers', email: 'sam@acme.example' });
    const reg = await agent.post('/api/connections').send({ label: 'prod', baseUrl: 'http://localhost:5678', apiKey: SECRET_KEY });
    const id = reg.body.connection.id as string;

    // The workflow's advisory owner is inferred from project membership (Nathan, admin).
    const before = await agent.get('/api/workflows');
    expect(before.body.workflows[0].owner).toMatchObject({ status: 'inferred', owner: { email: 'nathan@n8n.io' }, memberRole: 'project:admin' });

    // The picker offers the instance's known n8n users.
    const users = await agent.get(`/api/ownership/${id}/assignable-users`);
    expect(users.body).toMatchObject({ available: true });
    expect(users.body.users[0]).toMatchObject({ email: 'nathan@n8n.io' });

    // Assign an explicit owner — it overrides inference.
    const assign = await agent.put(`/api/ownership/${id}/w1/owner`).send({ ownerEmail: 'sam@acme.example', ownerName: 'Sam Rivers', reason: 'owns billing' });
    expect(assign.status).toBe(200);
    expect(assign.body).toMatchObject({ status: 'assigned', owner: { email: 'sam@acme.example' } });

    const after = await agent.get('/api/workflows');
    expect(after.body.workflows[0].owner).toMatchObject({ status: 'assigned', owner: { email: 'sam@acme.example' } });

    // The assignment is on the self-audit timeline with who + before→after, and the
    // payload carries pagination info (total across pages + echoed limit/offset).
    const audit = await agent.get('/api/ownership/audit');
    const entry = audit.body.entries.find((e: { action: string }) => e.action === 'ownership.assign');
    expect(entry).toBeTruthy();
    expect(entry).toMatchObject({ actorEmail: 'sam@acme.example', entityId: `${id}/w1` });
    expect(entry.detail.after.ownerEmail).toBe('sam@acme.example');
    expect(audit.body).toMatchObject({ limit: 50, offset: 0 });
    expect(audit.body.total).toBeGreaterThanOrEqual(2); // ≥ connection.register + ownership.assign

    // Pagination: one row per page, and the total is unchanged by the page window.
    const page1 = await agent.get('/api/ownership/audit?limit=1&offset=0');
    const page2 = await agent.get('/api/ownership/audit?limit=1&offset=1');
    expect(page1.body.entries).toHaveLength(1);
    expect(page2.body.entries).toHaveLength(1);
    expect(page1.body.entries[0].id).not.toBe(page2.body.entries[0].id); // distinct pages
    expect(page1.body.total).toBe(audit.body.total);

    // Partial, case-insensitive actor match on EMAIL: a substring finds the actor…
    const byEmail = await agent.get('/api/ownership/audit?actor=SAM');
    expect(byEmail.body.entries.length).toBeGreaterThan(0);
    expect(byEmail.body.entries.every((e: { actorEmail: string }) => e.actorEmail.includes('sam'))).toBe(true);
    // …and on NAME too — "Rivers" is in the name "Sam Rivers" but NOT in sam@acme.example.
    const byName = await agent.get('/api/ownership/audit?actor=Rivers');
    expect(byName.body.entries.length).toBeGreaterThan(0);
    expect(byName.body.entries.every((e: { actorName: string }) => e.actorName.toLowerCase().includes('rivers'))).toBe(true);
    // …and a substring in neither name nor email returns nothing (honest empty, not everything).
    const none = await agent.get('/api/ownership/audit?actor=nobody-xyz');
    expect(none.body.entries).toHaveLength(0);
    expect(none.body.total).toBe(0);

    // CSV export is attachment + contains the entry (and exports every page, not just one).
    const csv = await agent.get('/api/ownership/audit/export.csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('attachment');
    expect(csv.text).toContain('ownership.assign');
  });

  it('S4: governance gaps endpoint returns the four gap groups', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'pw', name: 'Sam', email: 'sam@acme.example' });
    await agent.post('/api/connections').send({ label: 'prod', baseUrl: 'http://localhost:5678', apiKey: SECRET_KEY });
    const gaps = await agent.get('/api/ownership/gaps');
    expect(gaps.status).toBe(200);
    expect(gaps.body).toMatchObject({
      unowned: expect.any(Array),
      singleOwnerCritical: expect.any(Array),
      personalSpaceCritical: expect.any(Array),
      noBackupOwner: expect.any(Array),
    });
  });
});
