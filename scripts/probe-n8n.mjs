#!/usr/bin/env node
// Contract + discovery probes against a REAL running n8n (E2E mode).
//
// Standing rule 1: never build against memory of n8n — hit the running instance,
// save the actual request/response in contracts/, and code against that.
//
// M0 probes (00–07): reachability, E2E unlock, public-API auth, and the
// projects/users/workflow shapes the analyzer reads.
// S1a probe (15): the workflow LIST item shape the live inventory syncs from.
// S3 probe (17): the public executions LIST shape the health service reads.
// S3 probe (18): the REDACTED single-execution detail the drawer reads on-demand.
// M1 seeder probes (08–14): the *creation* + *execution* surface the seeder needs
//   08 workflow manual run (/rest/workflows/:id/run) → an execution that FAILS
//   09 production webhook hit → an execution from an active webhook workflow
//   10 create a team project
//   11 add a member to a project
//   12 create a credential inside a project
//   13 create a workflow inside a project (shared→project link)
//   14 activate a workflow
//
// It resets the E2E instance to a known owner (nathan@n8n.io) + one member to mint
// an API key and exercise ownership, exactly as n8n's own test harness does.
// Secrets (API key, cookies, password, credential data) are redacted before write.
//
// Usage: node scripts/probe-n8n.mjs   (n8n must be running — see CLAUDE.md)

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createN8nClient, redactBody, FEATURE_FLAGS } from './lib/n8n-client.mjs';

const BASE = process.env.N8N_BASE_URL ?? 'http://localhost:5678';
const N8N_VERSION = '2.29.0';
const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts');

// A real member so ownership/project-membership probes have someone to work with.
const MEMBER = { email: 'priya@n8n.io', password: 'PlaywrightTest123', firstName: 'Priya', lastName: 'Member' };

const client = createN8nClient(BASE);
const results = [];
const now = () => new Date().toISOString();

async function save(name, obj) {
  await writeFile(join(CONTRACTS_DIR, name), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function record(id, description, pass, detail) {
  results.push({ id, description, pass, detail });
  console.log(`${pass ? '✔' : '✘'} ${id}  ${description} — ${detail}`);
}

// Poll an execution to a terminal state so we can capture its real status.
async function waitForExecution(id, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const r = await client.http('GET', `/rest/executions/${id}`);
    const status = r.json?.data?.status ?? r.json?.status;
    const finished = r.json?.data?.finished ?? r.json?.finished;
    if (status && status !== 'running' && status !== 'new' && status !== 'waiting') return { status, finished, resp: r };
    if (finished) return { status, finished, resp: r };
    await sleep(200);
  }
  const r = await client.http('GET', `/rest/executions/${id}`);
  return { status: r.json?.data?.status ?? r.json?.status ?? 'unknown', finished: false, resp: r };
}

async function main() {
  await mkdir(CONTRACTS_DIR, { recursive: true });
  console.log(`Probing n8n at ${BASE}\n`);

  // 00 — reachable
  try {
    const r = await client.http('GET', '/healthz', { key: false });
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
    const r = await client.http('GET', '/api/v1/workflows', { key: false });
    await save('n8n-02-public-api-unauth-rejected.json', {
      $probe: 'public API rejects a request with no X-N8N-API-KEY',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path: '/api/v1/workflows', headers: '(none)' },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
    });
    record('02', 'public API rejects unauth', r.status === 401, `GET /api/v1/workflows (no key) → ${r.status}`);
  }

  // Reset E2E instance to a known owner + one member so we can mint a key and
  // exercise ownership. (owner+admin+chat must all be objects — DISCOVERY.md.)
  {
    const r = await client.reset({ members: [MEMBER] });
    record('--', 'E2E reset to known owner + member', r.ok || r.status === 200, `POST /rest/e2e/reset → ${r.status}`);
  }

  // 01 — PATCH /rest/e2e/feature accepts a license-flag patch (+ apply all flags).
  {
    const first = FEATURE_FLAGS[0];
    const r = await client.http('PATCH', '/rest/e2e/feature', { key: false, body: { feature: first, enabled: true } });
    await save('n8n-01-e2e-feature-patch.json', {
      $probe: 'PATCH /rest/e2e/feature accepts a license-flag patch (E2E unlock)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'PATCH', path: '/rest/e2e/feature', body: { feature: first, enabled: true } },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text ?? '(empty)' },
      note: 'skipAuth endpoint; body shape { feature: BooleanLicenseFeature, enabled: boolean }. Reset wipes flags — re-apply after every reset.',
    });
    record('01', 'e2e feature patch accepted', r.status >= 200 && r.status < 300, `PATCH /rest/e2e/feature {${first}} → ${r.status}`);
    await client.unlock();
  }

  // Login (cookie auth) then mint an API key via internal REST.
  {
    const r = await client.login();
    record('--', 'owner login', r.ok && client.cookie.length > 0, `POST /rest/login → ${r.status}, cookie ${client.cookie ? 'set' : 'MISSING'}`);
  }
  {
    const r = await client.mintApiKey('argus-probe');
    record('--', 'mint API key', client.apiKey.length > 0, `POST /rest/api-keys → ${r.status}, key ${client.apiKey ? 'minted' : 'MISSING'}`);
    if (!client.apiKey) {
      console.error('Could not mint an API key; skipping the shape probes.');
      await finish();
      return;
    }
  }

  // 03 — projects shape
  {
    const r = await client.api('GET', '/projects');
    await save('n8n-03-projects-shape.json', {
      $probe: 'GET /api/v1/projects — live response shape (project id, name, type, role)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path: '/api/v1/projects', headers: { 'X-N8N-API-KEY': '«redacted»' } },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
    });
    record('03', 'projects shape captured', r.status === 200, `GET /api/v1/projects → ${r.status}, ${r.json?.data?.length ?? 0} project(s)`);
  }

  // 04 — users shape (includeRole). Capture the member id for later probes.
  let memberId = '';
  {
    const r = await client.api('GET', '/users?includeRole=true');
    memberId = (r.json?.data ?? []).find((u) => u.email === MEMBER.email)?.id ?? '';
    await save('n8n-04-users-shape.json', {
      $probe: 'GET /api/v1/users?includeRole=true — live response shape (id, email, role)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path: '/api/v1/users?includeRole=true', headers: { 'X-N8N-API-KEY': '«redacted»' } },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
    });
    record('04', 'users shape captured', r.status === 200, `GET /api/v1/users → ${r.status}, ${r.json?.data?.length ?? 0} user(s), member ${memberId ? 'present' : 'MISSING'}`);
  }

  // 05 — workflow `shared` shape: create one probe workflow, then GET it.
  {
    const wf = {
      name: 'Argus probe workflow',
      nodes: [{
        parameters: {}, id: '11111111-1111-4111-8111-111111111111', name: 'When clicking Test',
        type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0],
      }],
      connections: {}, settings: {},
    };
    const created = await client.api('POST', '/workflows', wf);
    const id = created.json?.id ?? created.json?.data?.id ?? '';
    const getResp = id ? await client.api('GET', `/workflows/${id}`) : created;
    await save('n8n-05-workflow-shared-shape.json', {
      $probe: 'GET /api/v1/workflows/{id} — live shape incl. the `shared` array (workflow→project+role)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: {
        create: { method: 'POST', path: '/api/v1/workflows', body: redactBody(wf) },
        fetch: { method: 'GET', path: `/api/v1/workflows/${id || '{id}'}` },
      },
      response: { status: getResp.status, ok: getResp.ok, body: getResp.json ?? getResp.text },
      note: 'The `shared` array is the ownership-inference input (PLAN.md Pillar 2).',
    });
    const hasShared = !!(getResp.json && 'shared' in getResp.json);
    record('05', 'workflow `shared` shape captured', getResp.status === 200, `GET workflow → ${getResp.status}, shared array ${hasShared ? 'PRESENT' : 'ABSENT'}`);
  }

  // 15 — workflow LIST shape: the fields Argus's live inventory reads (S1a).
  // The list is the sync source of truth; confirm it carries name/active/
  // isArchived/updatedAt/versionId and the `shared` owner link. Note: unlike the
  // single-workflow GET, list items DO NOT embed the nested `project` object — so
  // the project *name* must be resolved separately via GET /api/v1/projects.
  {
    const r = await client.api('GET', '/workflows?limit=3');
    const items = r.json?.data ?? [];
    const first = items[0] ?? {};
    // Heavy graph fields exist on every item but aren't part of the inventory
    // contract; summarize them so the captured shape stays readable + faithful.
    const summarize = (w) => {
      const { nodes, connections: _connections, staticData, pinData, meta, ...rest } = w;
      return {
        ...rest,
        nodes: `«${Array.isArray(nodes) ? nodes.length : 0} nodes»`,
        connections: '«connections object»',
        staticData: staticData === null ? null : '«staticData»',
        pinData: pinData === null ? null : '«pinData»',
        meta: meta === null ? null : '«meta»',
      };
    };
    const ownerShare = (first.shared ?? []).find((s) => s.role === 'workflow:owner');
    const inventoryFields = ['id', 'name', 'active', 'isArchived', 'updatedAt', 'versionId'];
    const missing = inventoryFields.filter((f) => !(f in first));
    await save('n8n-15-workflow-list-shape.json', {
      $probe: 'GET /api/v1/workflows?limit=N — live LIST item shape (Argus live inventory source, S1a)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path: '/api/v1/workflows?limit=3', headers: { 'X-N8N-API-KEY': '«redacted»' } },
      response: {
        status: r.status, ok: r.ok,
        count: items.length,
        nextCursor: r.json?.nextCursor ?? null,
        itemKeys: Object.keys(first).sort(),
        sampleItem: summarize(first),
      },
      finding: [
        `inventory fields ${missing.length === 0 ? 'ALL PRESENT' : `MISSING: ${missing.join(', ')}`} on list items.`,
        `list items carry \`shared\` (owner link → projectId=${ownerShare?.projectId ?? '?'}) but NOT the nested \`project\` object;`,
        'resolve the owning project name via GET /api/v1/projects.',
      ].join(' '),
    });
    record('15', 'workflow list shape captured', r.status === 200 && missing.length === 0,
      `GET /api/v1/workflows → ${r.status}, ${items.length} item(s), inventory fields ${missing.length === 0 ? 'present' : `MISSING ${missing.join(',')}`}`);
  }

  // 06 — folders in the public API (discovery)
  let firstProjectId = '';
  {
    const projects = await client.api('GET', '/projects');
    firstProjectId = projects.json?.data?.[0]?.id ?? '';
    const path = firstProjectId ? `/api/v1/projects/${firstProjectId}/folders` : '/api/v1/projects/unknown/folders';
    const r = await client.http('GET', path);
    const exposed = r.status === 200;
    await save('n8n-06-folders-visibility.json', {
      $probe: 'M0 discovery: are folders exposed via the public API?',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path, headers: { 'X-N8N-API-KEY': '«redacted»' } },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
      finding: exposed ? 'EXPOSED — GET /api/v1/projects/{projectId}/folders (license feat:folders).' : `Route returned ${r.status}.`,
    });
    record('06', 'folders public-API visibility', true, exposed ? 'EXPOSED (200)' : `status ${r.status}`);
  }

  // 07 — agents-v2 in the public API (discovery)
  {
    const candidates = ['/api/v1/agents', '/api/v1/agents/v2'];
    const probes = [];
    for (const p of candidates) {
      const r = await client.http('GET', p);
      probes.push({ path: p, status: r.status, body: r.json ?? r.text });
    }
    const notExposed = probes.every((p) => p.status === 404);
    await save('n8n-07-agents-v2-visibility.json', {
      $probe: 'M0 discovery: are agents-v2 entities exposed via the public API?',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      requestHeaders: { 'X-N8N-API-KEY': '«redacted»' }, probes,
      finding: notExposed ? 'NOT EXPOSED — no public API route for agents-v2 (all 404).' : 'Unexpected — investigate.',
    });
    record('07', 'agents-v2 public-API visibility', true, notExposed ? 'NOT EXPOSED (404)' : 'unexpected — see contract');
  }

  // ===== M1 seeder probes (08–14) =====

  // 10 — create a team project (needed by 11/12/13). Capture the create shape.
  let projectId = '';
  {
    const body = { name: 'Argus Probe — Revenue Ops' };
    const r = await client.api('POST', '/projects', body);
    projectId = r.json?.id ?? r.json?.data?.id ?? '';
    await save('n8n-10-project-create.json', {
      $probe: 'POST /api/v1/projects — create a team project (does an owner key create type:team?)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'POST', path: '/api/v1/projects', body },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
      finding: r.json?.type ? `created type="${r.json.type}"` : 'type not in response — inspect body',
    });
    record('10', 'create team project', !!projectId, `POST /api/v1/projects → ${r.status}, id ${projectId ? 'present' : 'MISSING'}, type=${r.json?.type ?? '?'}`);
  }

  // 11 — add the member to that project as editor.
  {
    const body = { relations: [{ userId: memberId, role: 'project:editor' }] };
    const r = memberId && projectId
      ? await client.api('POST', `/projects/${projectId}/users`, body)
      : { status: 0, ok: false, json: 'skipped — missing member or project' };
    await save('n8n-11-project-add-users.json', {
      $probe: 'POST /api/v1/projects/{id}/users — add a member (relations:[{userId, role}])',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'POST', path: `/api/v1/projects/${projectId || '{id}'}/users`, body: { relations: [{ userId: memberId ? '«memberId»' : '(missing)', role: 'project:editor' }] } },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text ?? '(empty)' },
      note: 'assignableProjectRole = project:admin | project:editor | project:viewer.',
    });
    record('11', 'add member to project', r.status >= 200 && r.status < 300, `POST /projects/{id}/users → ${r.status}`);
  }

  // 12 — create a credential inside the project.
  {
    const body = { name: 'Probe Slack', type: 'slackApi', data: { accessToken: 'xoxb-probe-not-real' }, projectId };
    const r = await client.api('POST', '/credentials', body);
    const credId = r.json?.id ?? r.json?.data?.id ?? '';
    await save('n8n-12-credential-create.json', {
      $probe: 'POST /api/v1/credentials — create a credential inside a project (projectId honored?)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'POST', path: '/api/v1/credentials', body: redactBody(body) },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
      finding: 'Check response for the credential id + whether it reports the target project.',
    });
    record('12', 'create credential in project', !!credId, `POST /api/v1/credentials → ${r.status}, id ${credId ? 'present' : 'MISSING'}`);
  }

  // 13 — create a workflow inside the project; confirm shared→project link.
  let webhookWfId = '';
  {
    const body = {
      name: 'Argus Probe — Webhook WF',
      nodes: [
        { parameters: { path: 'argus-probe-hook', httpMethod: 'POST', responseMode: 'onReceived' }, id: '22222222-2222-4222-8222-222222222222', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
        { parameters: {}, id: '33333333-3333-4333-8333-333333333333', name: 'NoOp', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [220, 0] },
      ],
      connections: { Webhook: { main: [[{ node: 'NoOp', type: 'main', index: 0 }]] } },
      settings: {}, projectId,
    };
    const r = await client.api('POST', '/workflows', body);
    webhookWfId = r.json?.id ?? r.json?.data?.id ?? '';
    const getResp = webhookWfId ? await client.api('GET', `/workflows/${webhookWfId}`) : r;
    const homeProject = (getResp.json?.shared ?? []).find((s) => s.role === 'workflow:owner')?.projectId;
    await save('n8n-13-workflow-create-in-project.json', {
      $probe: 'POST /api/v1/workflows with projectId — does the workflow land in the target project?',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'POST', path: '/api/v1/workflows', body: redactBody(body) },
      response: { status: getResp.status, ok: getResp.ok, body: getResp.json ?? getResp.text },
      finding: homeProject === projectId ? `LANDED in target project (${homeProject})` : `home project=${homeProject}, target=${projectId} — MISMATCH, inspect`,
    });
    record('13', 'create workflow in project', homeProject === projectId, `owner project ${homeProject === projectId ? 'matches target' : 'MISMATCH'}`);
  }

  // 14 — activate the webhook workflow.
  {
    const r = webhookWfId ? await client.api('POST', `/workflows/${webhookWfId}/activate`) : { status: 0, ok: false, json: 'skipped' };
    await save('n8n-14-workflow-activate.json', {
      $probe: 'POST /api/v1/workflows/{id}/activate — activate a workflow (registers its production webhook)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'POST', path: `/api/v1/workflows/${webhookWfId || '{id}'}/activate` },
      response: { status: r.status, ok: r.ok, body: r.json ?? r.text },
    });
    record('14', 'activate workflow', r.json?.active === true || r.status === 200, `POST /workflows/{id}/activate → ${r.status}, active=${r.json?.active ?? '?'}`);
  }

  // 09 — production webhook hit → a real execution from the active webhook workflow.
  {
    const hookUrl = `${BASE}/webhook/argus-probe-hook`;
    let resp;
    try {
      const res = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ probe: true }) });
      const text = await res.text();
      resp = { status: res.status, ok: res.ok, body: (() => { try { return JSON.parse(text); } catch { return text; } })() };
    } catch (e) {
      resp = { status: 0, ok: false, body: `error: ${e.message}` };
    }
    // Confirm an execution was recorded for the webhook workflow.
    await sleep(500);
    const execs = webhookWfId ? await client.http('GET', `/rest/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId: webhookWfId }))}`) : { json: {} };
    const execCount = execs.json?.data?.results?.length ?? execs.json?.data?.length ?? 0;
    await save('n8n-09-webhook-exec.json', {
      $probe: 'Production webhook hit generates an execution (POST /webhook/{path} on an active workflow)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'POST', path: '/webhook/argus-probe-hook', note: 'production webhook base = <baseUrl>/webhook/<path>' },
      response: resp,
      executionsAfter: execCount,
    });
    record('09', 'webhook execution generated', resp.status >= 200 && resp.status < 300, `POST /webhook/argus-probe-hook → ${resp.status}, execs=${execCount}`);
  }

  // 08 — manual run of a deliberately-failing workflow → an ERROR execution.
  {
    const wf = {
      name: 'Argus Probe — Always Fails',
      nodes: [
        { parameters: {}, id: '44444444-4444-4444-8444-444444444444', name: 'When clicking Test', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
        { parameters: { url: 'http://127.0.0.1:1/never', options: {} }, id: '55555555-5555-4555-8555-555555555555', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [220, 0] },
      ],
      connections: { 'When clicking Test': { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
      settings: {}, projectId,
    };
    const created = await client.api('POST', '/workflows', wf);
    const wfId = created.json?.id ?? created.json?.data?.id ?? '';
    const runBody = { triggerToStartFrom: { name: 'When clicking Test' } };
    const run = wfId ? await client.http('POST', `/rest/workflows/${wfId}/run`, { body: runBody }) : { json: {} };
    const executionId = run.json?.data?.executionId ?? run.json?.executionId ?? '';
    const waited = executionId ? await waitForExecution(executionId) : { status: 'no-execution' };
    await save('n8n-08-workflow-run.json', {
      $probe: 'POST /rest/workflows/{id}/run — manual run; a bad HTTP node yields an ERROR execution',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'POST', path: `/rest/workflows/${wfId || '{id}'}/run`, body: runBody, note: 'cookie-auth; body = FullManualExecutionFromKnownTrigger { triggerToStartFrom: { name } }' },
      runResponse: { status: run.status, body: run.json ?? run.text },
      executionId, finalStatus: waited.status,
      finding: `manual run returns { executionId }; poll GET /rest/executions/{id} for status. This run ended "${waited.status}".`,
    });
    record('08', 'manual run → error execution', !!executionId, `run → executionId ${executionId ? 'present' : 'MISSING'}, status=${waited.status}`);
  }

  // 17 — PUBLIC executions LIST shape (S3 health source). By now probes 08/09 have
  // created a couple of executions, so the list is non-empty. Argus's health service
  // reads this endpoint — without `includeData`, with `redactExecutionData=true` — so
  // capture the real item shape (status, startedAt, stoppedAt, workflowId) + the
  // status-filter + pagination behaviour it relies on.
  {
    const listPath = '/executions?limit=5&includeData=false';
    const r = await client.api('GET', listPath);
    const items = r.json?.data ?? [];
    const first = items[0] ?? {};
    // Confirm the status filter the fetch may use, and redactExecutionData passes through.
    const errPath = '/executions?limit=5&status=error&includeData=false&redactExecutionData=true';
    const rErr = await client.api('GET', errPath);
    const healthFields = ['id', 'status', 'startedAt', 'stoppedAt', 'workflowId', 'finished', 'mode'];
    const missing = healthFields.filter((f) => !(f in first));
    await save('n8n-17-executions-list.json', {
      $probe: 'GET /api/v1/executions — public executions LIST shape (Argus health source, S3)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path: `/api/v1${listPath}`, headers: { 'X-N8N-API-KEY': '«redacted»' } },
      response: {
        status: r.status, ok: r.ok,
        count: items.length,
        nextCursor: r.json?.nextCursor ?? null,
        itemKeys: Object.keys(first).sort(),
        sampleItem: first,
      },
      statusFilter: {
        request: { method: 'GET', path: `/api/v1${errPath}` },
        status: rErr.status,
        count: (rErr.json?.data ?? []).length,
        statuses: [...new Set((rErr.json?.data ?? []).map((e) => e.status))],
      },
      finding: [
        `health fields ${missing.length === 0 ? 'ALL PRESENT' : `MISSING: ${missing.join(', ')}`} on list items.`,
        'fetched WITHOUT includeData and WITH redactExecutionData=true (no execution payloads reach Argus);',
        'status filter (?status=error) + cursor pagination confirmed; durations = stoppedAt − startedAt (both nullable).',
      ].join(' '),
    });
    record('17', 'executions list shape captured', r.status === 200 && missing.length === 0,
      `GET /api/v1/executions → ${r.status}, ${items.length} item(s), health fields ${missing.length === 0 ? 'present' : `MISSING ${missing.join(',')}`}`);
  }

  // 18 — REDACTED single-execution detail (S3 drawer debug source). On-demand only:
  // GET /api/v1/executions/{id}?includeData=true&redactExecutionData=true. n8n redacts
  // server-side → the useful debug signal (which node failed + error TYPE/code) survives,
  // but the error message + all node data are stripped. Argus reads only lastNodeExecuted
  // + redactedError.{type,httpCode}; never the message/payload. Uses probe 08's failed run.
  {
    // Find a failed execution (probes 08/09 created some) via the public list.
    const errList = await client.api('GET', '/executions?status=error&limit=1&includeData=false');
    const execId = (errList.json?.data ?? [])[0]?.id ?? '';
    const r = execId ? await client.api('GET', `/executions/${execId}?includeData=true&redactExecutionData=true`) : { status: 0, json: {} };
    const rd = r.json?.data?.resultData ?? r.json?.resultData;
    // Summarize (don't dump the whole redacted graph into the contract file).
    await save('n8n-18-execution-redacted.json', {
      $probe: 'GET /api/v1/executions/{id}?includeData=true&redactExecutionData=true — redacted debug detail (S3 drawer)',
      capturedAt: now(), n8nVersion: N8N_VERSION,
      request: { method: 'GET', path: `/api/v1/executions/${execId || '{id}'}?includeData=true&redactExecutionData=true`, headers: { 'X-N8N-API-KEY': '«redacted»' } },
      response: {
        status: r.status,
        topLevelKeys: r.json?.data ? Object.keys(r.json.data).sort() : Object.keys(r.json ?? {}).sort(),
        resultDataKeys: rd ? Object.keys(rd).sort() : null,
        lastNodeExecuted: rd?.lastNodeExecuted ?? null,
        redactedError: rd?.redactedError ?? null,
      },
      finding: [
        'with redactExecutionData=true, the error surfaces as `resultData.redactedError` ({ type, httpCode }),',
        'plus `resultData.lastNodeExecuted` (the failing node NAME). The error MESSAGE and all node',
        'data are stripped server-side. Argus allowlists ONLY lastNodeExecuted + redactedError.type/httpCode.',
      ].join(' '),
    });
    record('18', 'redacted execution detail captured', r.status === 200,
      `GET /api/v1/executions/{id}?includeData → ${r.status}, failing node "${rd?.lastNodeExecuted ?? '?'}", error ${rd?.redactedError?.type ?? '—'}`);
  }

  await finish();
}

async function finish() {
  const summary = { capturedAt: now(), n8nBaseUrl: BASE, n8nVersion: N8N_VERSION, results };
  await save('n8n-probe-summary.json', summary);
  const passed = results.filter((r) => r.pass).length;
  console.log(`\nProbes recorded: ${passed}/${results.length} passed. Contracts written to contracts/.`);
}

await main();
