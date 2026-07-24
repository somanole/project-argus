import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { demoReadOnly, DEMO_READONLY_MESSAGE } from './demo-readonly.js';

/**
 * Read-only enforcement for a public demo. The guard is a whitelist, so this test
 * asserts the whole shape of that decision: every mutating route Argus exposes is
 * refused, the two POSTs a visitor genuinely needs still work, and reads are untouched.
 */

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', demoReadOnly());
  // Stand-ins for the real routers — reached only if the guard lets the request through.
  a.all(/.*/, (_req, res) => { res.json({ reached: true }); });
  return a;
}

// Every mutating route in the server, by method + path (see routes/*.ts).
const MUTATING: [string, string][] = [
  ['post', '/api/connections'],
  ['post', '/api/connections/abc/sync'],
  ['delete', '/api/connections/abc'],
  ['put', '/api/ownership/i1/w1/owner'],
  ['put', '/api/ownership/i1/w1/backup'],
  ['delete', '/api/ownership/i1/w1/owner'],
  ['put', '/api/settings/llm'],
  ['put', '/api/settings/enrichment'],
  ['post', '/api/settings/enrichment/run'],
  ['put', '/api/workflows/i1/w1/enrichment/correction'],
];

describe('demo mode — read-only guard', () => {
  it.each(MUTATING)('refuses %s %s', async (method, path) => {
    const res = await (request(app()) as never as Record<string, (p: string) => request.Test>)[method](path).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(DEMO_READONLY_MESSAGE);
  });

  it('allows reads', async () => {
    for (const p of ['/api/workflows', '/api/governance/overview', '/api/ownership/audit']) {
      const res = await request(app()).get(p);
      expect(res.status).toBe(200);
      expect(res.body.reached).toBe(true);
    }
  });

  it('allows sign-in and sign-out, or the demo could not be opened at all', async () => {
    for (const p of ['/api/auth/login', '/api/auth/logout']) {
      const res = await request(app()).post(p).send({});
      expect(res.status).toBe(200);
    }
  });

  it('allows chat — its tools only read', async () => {
    const res = await request(app()).post('/api/chat').send({ message: 'hi' });
    expect(res.status).toBe(200);
  });

  it('blocks an unknown future mutating route by default (whitelist, not blacklist)', async () => {
    const res = await request(app()).post('/api/something/new/that/writes').send({});
    expect(res.status).toBe(403);
  });
});

describe('demo login pre-fill — the published credential is opt-in', () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; });

  it('is null unless demo mode is on', async () => {
    const { demoLoginPassword } = await import('./config.js');
    process.env.ARGUS_DEMO_MODE = 'false';
    process.env.ARGUS_DEMO_PASSWORD = 'super-secret';
    expect(demoLoginPassword()).toBeNull();
  });

  it('is null in demo mode when the operator has not opted in', async () => {
    const { demoLoginPassword } = await import('./config.js');
    process.env.ARGUS_DEMO_MODE = 'true';
    delete process.env.ARGUS_DEMO_PASSWORD;
    expect(demoLoginPassword()).toBeNull();
  });

  it('never falls back to ARGUS_ADMIN_PASSWORD — enabling demo mode must not publish it', async () => {
    const { demoLoginPassword } = await import('./config.js');
    process.env.ARGUS_DEMO_MODE = 'true';
    process.env.ARGUS_ADMIN_PASSWORD = 'the-real-admin-password';
    delete process.env.ARGUS_DEMO_PASSWORD;
    expect(demoLoginPassword()).toBeNull();
  });

  it('returns the explicitly published demo login', async () => {
    const { demoLoginPassword } = await import('./config.js');
    process.env.ARGUS_DEMO_MODE = 'true';
    process.env.ARGUS_DEMO_PASSWORD = 'argus-demo-x';
    expect(demoLoginPassword()).toBe('argus-demo-x');
  });
});
