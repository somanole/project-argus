#!/usr/bin/env node
// Contract + discovery probes against a REAL running n8n (E2E mode).
//
// Standing rule 1: never build against memory of n8n — hit the running instance,
// save the actual request/response in contracts/, and code against that.
//
// This captures the M0 probes the plan calls for:
//   00 n8n reachable
//   01 PATCH /rest/e2e/feature accepts a license-flag patch
//   02 public API rejects an unauthenticated request
//   03 projects response shape (live)
//   04 users response shape (live, includeRole)
//   05 workflow `shared` array shape (live)
//   06 folders in the public API — visibility (M0 discovery probe)
//   07 agents-v2 in the public API — visibility (M0 discovery probe)
//
// It resets the E2E instance to a known owner (nathan@n8n.io) to mint an API key,
// exactly as n8n's own test harness does. Secrets (API key, cookies, password)
// are redacted before anything is written to contracts/.
//
// Usage: node scripts/probe-n8n.mjs   (n8n must be running — see CLAUDE.md)

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.N8N_BASE_URL ?? 'http://localhost:5678';
const N8N_VERSION = '2.29.0';
const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts');

// Known E2E test credentials (from n8n's own playwright harness — not secrets).
// n8n's setupUserManagement always creates owner + admin + chat, so all three
// must be objects (passing null crashes the reset with a 500).
const OWNER = {
  email: 'nathan@n8n.io',
  password: 'PlaywrightTest123',
  firstName: 'Nathan',
  lastName: 'Owner',
};
const ADMIN = { email: 'admin@n8n.io', password: 'PlaywrightTest123', firstName: 'Admin', lastName: 'User' };
const CHAT = { email: 'chat@n8n.io', password: 'PlaywrightTest123', firstName: 'Chat', lastName: 'User' };

const API_KEY_SCOPES = [
  'user:read', 'user:list', 'user:create', 'user:delete',
  'workflow:create', 'workflow:read', 'workflow:update', 'workflow:delete', 'workflow:list',
  'execution:read', 'execution:list',
  'credential:create', 'credential:update', 'credential:delete',
  'tag:create', 'tag:read', 'tag:list',
  'project:create', 'project:update', 'project:delete', 'project:list',
  'folder:list', 'folder:read',
];

const results = [];
const now = () => new Date().toISOString();

async function save(name, obj) {
  await writeFile(join(CONTRACTS_DIR, name), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function redactBody(body) {
  if (!body || typeof body !== 'object') return body;
  const clone = structuredClone(body);
  for (const k of ['password', 'rawApiKey', 'apiKey']) if (k in clone) clone[k] = '«redacted»';
  return clone;
}

// ---- HTTP helper: returns { status, ok, json, text, setCookies } ----
async function http(method, path, { headers = {}, body, cookie } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json, text, setCookies: res.headers.getSetCookie?.() ?? [] };
}

function record(id, description, pass, detail) {
  results.push({ id, description, pass, detail });
  const mark = pass ? '✔' : '✘';
  console.log(`${mark} ${id}  ${description} — ${detail}`);
}

async function main() {
  await mkdir(CONTRACTS_DIR, { recursive: true });
  console.log(`Probing n8n at ${BASE}\n`);

  // 00 — reachable
  try {
    const r = await http('GET', '/healthz');
    await save('n8n-00-reachable.json', {
      $probe: 'n8n instance is reachable and healthy',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path: '/healthz' },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
    });
    record('00', 'n8n reachable', r.status === 200, `GET /healthz → ${r.status}`);
  } catch (e) {
    record('00', 'n8n reachable', false, `error: ${e.message}`);
    console.error('\nn8n is not reachable — start it first (see CLAUDE.md). Aborting.');
    await finish();
    process.exit(1);
  }

  // 02 — public API rejects unauthenticated request (capture before we hold a key)
  {
    const r = await http('GET', '/api/v1/workflows');
    await save('n8n-02-public-api-unauth-rejected.json', {
      $probe: 'public API rejects a request with no X-N8N-API-KEY',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path: '/api/v1/workflows', headers: '(none)' },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
    });
    record('02', 'public API rejects unauth', r.status === 401, `GET /api/v1/workflows (no key) → ${r.status}`);
  }

  // Reset E2E instance to a known owner so we can mint an API key.
  {
    const r = await http('POST', '/rest/e2e/reset', {
      body: { owner: OWNER, members: [], admin: ADMIN, chat: CHAT },
    });
    record('--', 'E2E reset to known owner', r.ok || r.status === 200, `POST /rest/e2e/reset → ${r.status}`);
  }

  // 01 — PATCH /rest/e2e/feature accepts a license-flag patch (+ apply the flags
  // the shape probes need; projects/users/folders are license-gated).
  const featureFlags = [
    'feat:sharing', 'feat:folders', 'feat:advancedPermissions',
    'feat:projectRole:admin', 'feat:projectRole:editor', 'feat:projectRole:viewer',
    'feat:logStreaming', 'feat:variables', 'feat:insights:viewDashboard',
  ];
  {
    // Capture the first one as the representative contract.
    const first = featureFlags[0];
    const r = await http('PATCH', '/rest/e2e/feature', { body: { feature: first, enabled: true } });
    await save('n8n-01-e2e-feature-patch.json', {
      $probe: 'PATCH /rest/e2e/feature accepts a license-flag patch (E2E unlock)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'PATCH', path: '/rest/e2e/feature', body: { feature: first, enabled: true } },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text ?? '(empty)' },
      note: 'skipAuth endpoint; body shape { feature: BooleanLicenseFeature, enabled: boolean }',
    });
    record('01', 'e2e feature patch accepted', r.status >= 200 && r.status < 300, `PATCH /rest/e2e/feature {${first}} → ${r.status}`);
    // apply the rest (unlock)
    for (const f of featureFlags.slice(1)) {
      await http('PATCH', '/rest/e2e/feature', { body: { feature: f, enabled: true } });
    }
    await http('PATCH', '/rest/e2e/quota', { body: { feature: 'quota:maxTeamProjects', value: -1 } });
  }

  // Login (cookie auth) to mint an API key via internal REST.
  let cookie = '';
  {
    const r = await http('POST', '/rest/login', {
      body: { emailOrLdapLoginId: OWNER.email, password: OWNER.password },
    });
    cookie = r.setCookies.map((c) => c.split(';')[0]).join('; ');
    record('--', 'owner login', r.ok && cookie.length > 0, `POST /rest/login → ${r.status}, cookie ${cookie ? 'set' : 'MISSING'}`);
  }

  // Mint an API key.
  let apiKey = '';
  {
    const r = await http('POST', '/rest/api-keys', {
      cookie,
      body: { label: 'argus-m0-probe', scopes: API_KEY_SCOPES, expiresAt: null },
    });
    apiKey = r.json?.data?.rawApiKey ?? r.json?.rawApiKey ?? '';
    record('--', 'mint API key', apiKey.length > 0, `POST /rest/api-keys → ${r.status}, key ${apiKey ? 'minted' : 'MISSING'}`);
    if (!apiKey) {
      console.error('Could not mint an API key; skipping the shape probes.');
      await finish();
      return;
    }
  }
  const keyHeader = { 'X-N8N-API-KEY': apiKey };

  // 03 — projects shape
  let firstProjectId = '';
  {
    const r = await http('GET', '/api/v1/projects', { headers: keyHeader });
    firstProjectId = r.json?.data?.[0]?.id ?? '';
    await save('n8n-03-projects-shape.json', {
      $probe: 'GET /api/v1/projects — live response shape (project id, name, type, role)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path: '/api/v1/projects', headers: { 'X-N8N-API-KEY': '«redacted»' } },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
    });
    record('03', 'projects shape captured', r.status === 200, `GET /api/v1/projects → ${r.status}, ${r.json?.data?.length ?? 0} project(s)`);
  }

  // 04 — users shape (includeRole)
  {
    const r = await http('GET', '/api/v1/users?includeRole=true', { headers: keyHeader });
    await save('n8n-04-users-shape.json', {
      $probe: 'GET /api/v1/users?includeRole=true — live response shape (id, email, role)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path: '/api/v1/users?includeRole=true', headers: { 'X-N8N-API-KEY': '«redacted»' } },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
    });
    record('04', 'users shape captured', r.status === 200, `GET /api/v1/users → ${r.status}, ${r.json?.data?.length ?? 0} user(s)`);
  }

  // 05 — workflow `shared` shape: create one probe workflow, then GET it.
  {
    const wf = {
      name: 'Argus M0 probe workflow',
      nodes: [
        {
          parameters: {},
          id: '11111111-1111-4111-8111-111111111111',
          name: 'When clicking Test',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
        },
      ],
      connections: {},
      settings: {},
    };
    const created = await http('POST', '/api/v1/workflows', { headers: keyHeader, body: wf });
    const id = created.json?.id ?? created.json?.data?.id ?? '';
    let getResp = created;
    if (id) getResp = await http('GET', `/api/v1/workflows/${id}`, { headers: keyHeader });
    await save('n8n-05-workflow-shared-shape.json', {
      $probe: 'GET /api/v1/workflows/{id} — live shape incl. the `shared` array (workflow→project+role)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: {
        create: { method: 'POST', path: '/api/v1/workflows', body: redactBody(wf) },
        fetch: { method: 'GET', path: `/api/v1/workflows/${id || '{id}'}` },
        headers: { 'X-N8N-API-KEY': '«redacted»' },
      },
      response: { status: getResp.status, ok: getResp.ok, body: getResp.json ?? getResp.text },
      note: 'The `shared` array is the ownership-inference input (PLAN.md Pillar 2). Verify it is present and carries projectId + role.',
    });
    const hasShared = !!(getResp.json && 'shared' in getResp.json);
    record('05', 'workflow `shared` shape captured', getResp.status === 200, `GET workflow → ${getResp.status}, shared array ${hasShared ? 'PRESENT' : 'ABSENT'}`);
  }

  // 06 — folders in the public API (discovery). Route: GET /projects/{id}/folders
  {
    const path = firstProjectId ? `/api/v1/projects/${firstProjectId}/folders` : '/api/v1/projects/unknown/folders';
    const r = await http('GET', path, { headers: keyHeader });
    // 200 => folders exposed; 404 with "not found" for a real project id => route absent.
    const exposed = r.status === 200;
    await save('n8n-06-folders-visibility.json', {
      $probe: 'M0 discovery: are folders exposed via the public API?',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path, headers: { 'X-N8N-API-KEY': '«redacted»' } },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
      finding: exposed
        ? 'EXPOSED — folders are queryable via GET /api/v1/projects/{projectId}/folders (license: feat:folders).'
        : `Route returned ${r.status}. If 404 for a valid project id, folders are not exposed via the public API.`,
      sourceCorroboration: 'n8n source has a public-api folders handler group (openapi.yml: /projects/{projectId}/folders).',
    });
    record('06', 'folders public-API visibility', true, exposed ? 'EXPOSED (200)' : `status ${r.status}`);
  }

  // 07 — agents-v2 in the public API (discovery). No handler group in source → expect 404.
  {
    const candidates = ['/api/v1/agents', '/api/v1/agents/v2'];
    const probes = [];
    for (const p of candidates) {
      const r = await http('GET', p, { headers: keyHeader });
      probes.push({ path: p, status: r.status, body: r.json ?? r.text });
    }
    // 404 on all candidates => not exposed (a real public route would be 200/400/403, not 404).
    const notExposed = probes.every((p) => p.status === 404);
    await save('n8n-07-agents-v2-visibility.json', {
      $probe: 'M0 discovery: are agents-v2 entities exposed via the public API?',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      requestHeaders: { 'X-N8N-API-KEY': '«redacted»' },
      probes,
      finding: notExposed
        ? 'NOT EXPOSED — no public API route for agents-v2 (all candidate paths 404). Matches PLAN.md boundary: workflow-based agents only; agents-v2 is internal-REST-only.'
        : 'Unexpected: a candidate agents route did not 404 — investigate before relying on the boundary.',
      sourceCorroboration: 'n8n source has NO public-api agents handler group (only internal REST under /rest/projects/:id/agents/v2/*).',
    });
    record('07', 'agents-v2 public-API visibility', true, notExposed ? 'NOT EXPOSED (404)' : 'unexpected — see contract');
  }

  await finish();
}

async function finish() {
  const summary = {
    capturedAt: now(),
    n8nBaseUrl: BASE,
    n8nVersion: N8N_VERSION,
    results,
  };
  await save('n8n-probe-summary.json', summary);
  const passed = results.filter((r) => r.pass).length;
  console.log(`\nProbes recorded: ${passed}/${results.length} passed. Contracts written to contracts/.`);
}

await main();
