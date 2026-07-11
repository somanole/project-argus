#!/usr/bin/env node
// Responsive verification (standing rule 10): render each hero view at 375px (and
// desktop), in BOTH themes, and assert no horizontal overflow
// (documentElement.scrollWidth <= innerWidth) and the key element is in-bounds.
//
// Hermetic: serves the built web bundle and route-mocks /api/** with canned data, so
// it needs no server/n8n. Drives the system Chrome via playwright-core (no browser
// download). macOS/dev-oriented; if a browser can't launch, the caller reports it
// honestly rather than faking a pass (rule 5).
//
// Exported for scripts/verify.mjs; also runnable directly: node scripts/responsive-check.mjs

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'apps/web/dist');
const MOBILE = 375;
const DESKTOP = 1280;

// ---- canned API data (schema-valid) ----
const ACTOR = { name: 'Owner', email: 'owner@acme.example' };
const enrichment = {
  status: 'analyzed', provider: 'openai', model: 'gpt-5-mini', enrichedAt: '2026-07-05T00:00:00.000Z', corrected: false,
  summary: 'Nightly sync of Salesforce accounts into the warehouse.', description: 'Pulls Salesforce records and upserts them into Postgres each night.',
  category: 'data-pipeline', criticality: 'high', criticalityReason: 'Feeds downstream revenue reporting; a failure stales analytics.',
  riskFlags: ['handles-pii', 'production-write'], suggestedOwnerRationale: 'Data Platform owns the warehouse + Salesforce credential.',
  businessContext: 'Keeps CRM and warehouse in sync for reporting.',
};
const mkHealth = (status, over = {}) => ({
  status, failureRate: null, runsInWindow: 0, failuresInWindow: 0, lastRunAt: null, lastStatus: null,
  avgDurationMs: null, windowHours: 336, computedAt: '2026-07-06T00:00:00.000Z', unavailableReason: null, ...over,
});
const inferredOwner = { status: 'inferred', owner: { email: 'sam@acme.example', name: 'Sam Rivers' }, backupOwner: null, reason: null, source: 'project-member', memberRole: 'project:admin', assignedBy: null, assignedAt: null };
const item = (id, name, systems, triggers, over = {}) => ({
  instanceId: 'prod', instanceLabel: 'prod', id, name, active: true, isArchived: false,
  project: 'Revenue Ops', updatedAt: '2026-07-05T00:00:00.000Z',
  systems, triggers, mcpExposed: false, nodeCount: 4, understood: true, brokenRefCount: 0, enrichment: null,
  health: mkHealth('healthy', { failureRate: 0, runsInWindow: 5 }), owner: inferredOwner, ...over,
});
const WORKFLOWS = [
  item('w1', 'Salesforce CRM Sync — nightly enrichment', ['Salesforce', 'Postgres'], ['n8n-nodes-base.scheduleTrigger'], { mcpExposed: true, enrichment, health: mkHealth('failing', { failureRate: 1, runsInWindow: 4, failuresInWindow: 4, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'error' }) }),
  item('w2', 'Refund Processor', ['Stripe', 'Slack'], ['n8n-nodes-base.webhook'], { health: mkHealth('degraded', { failureRate: 0.5, runsInWindow: 6, failuresInWindow: 3, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'error' }) }),
  item('w3', 'Lead Scorer', ['OpenAI'], ['n8n-nodes-base.manualTrigger'], { brokenRefCount: 1, understood: false, health: mkHealth('idle') }),
];
const failingBody = {
  failing: [WORKFLOWS[0]],
  degraded: [WORKFLOWS[1]],
  healthy: [],
  idle: [WORKFLOWS[2]],
  unknown: [],
  summary: { failing: 1, degraded: 1, healthy: 1, idle: 1, unknown: 0 },
  windows: [{ instanceId: 'prod', instanceLabel: 'prod', windowHours: 336, available: true }],
  generatedAt: '2026-07-05T00:00:00.000Z',
};
const workflowsBody = {
  workflows: WORKFLOWS,
  facets: {
    systems: [{ value: 'Salesforce', count: 1 }, { value: 'Postgres', count: 1 }, { value: 'Stripe', count: 1 }, { value: 'Slack', count: 1 }, { value: 'OpenAI', count: 1 }],
    triggers: [{ value: 'n8n-nodes-base.webhook', label: 'Webhook', count: 1 }, { value: 'n8n-nodes-base.scheduleTrigger', label: 'Schedule Trigger', count: 1 }, { value: 'n8n-nodes-base.manualTrigger', label: 'Manual Trigger', count: 1 }],
    instances: [{ id: 'prod', label: 'prod', count: 3 }],
  },
  total: WORKFLOWS.length,
  limit: 50,
  offset: 0,
  generatedAt: '2026-07-05T00:00:00.000Z',
};
const coverageBody = { total: 3, understood: 2, understoodPct: 66.7, gapsByKind: {}, unknownNodeTypes: [], unresolvedRefTotal: 0, dynamicRefTotal: 0, brokenRefTotal: 1, perInstance: [] };
const gapWf = (id, name, over = {}) => ({ instanceId: 'prod', instanceLabel: 'prod', workflowId: id, name, criticality: 'critical', criticalityReason: 'handles money', ...over });
const gapsBody = {
  unowned: [{ ...gapWf('u1', 'Orphan Report'), inferred: null }],
  singleOwnerCritical: [{ owner: { email: 'sam@acme.example', name: 'Sam Rivers' }, workflows: [gapWf('w1', 'Daily Stripe Reconciliation'), gapWf('w2', 'Refund Processor', { instanceId: 'staging', instanceLabel: 'staging' })], crossInstance: true }],
  personalSpaceCritical: [{ ...gapWf('p1', 'Personal Ops Hack'), person: { email: 'diana@acme.example', name: 'Diana' } }],
  noBackupOwner: [{ ...gapWf('nb1', 'Invoice Dispatch'), owner: { email: 'sam@acme.example', name: 'Sam Rivers' } }],
  generatedAt: '2026-07-05T00:00:00.000Z',
};
const registerBody = {
  rows: WORKFLOWS.map((w, i) => ({ ...w, risks: i === 0 ? ['no-confirmed-owner'] : ['no-backup'] })),
  summary: { total: 3, confirmed: 1, inferred: 1, unowned: 1, criticalAtRisk: 1, noBackup: 1 },
  total: 3,
  limit: 50,
  offset: 0,
  generatedAt: '2026-07-05T00:00:00.000Z',
};
const auditBody = {
  entries: [
    { id: 2, ts: '2026-07-06T10:00:00.000Z', actorName: 'Ops Admin', actorEmail: 'ops@acme.example', action: 'ownership.assign', entityType: 'workflow_ownership', entityId: 'prod/w1', detail: { after: { ownerEmail: 'sam@acme.example' } } },
    { id: 1, ts: '2026-07-06T09:00:00.000Z', actorName: 'Ops Admin', actorEmail: 'ops@acme.example', action: 'connection.register', entityType: 'connection', entityId: 'prod', detail: null },
  ],
  actions: ['connection.register', 'ownership.assign'],
  total: 2,
  limit: 50,
  offset: 0,
  generatedAt: '2026-07-05T00:00:00.000Z',
};
const overviewBody = {
  score: {
    score: 63.5,
    pillars: [
      { key: 'ownership', label: 'Ownership', weight: 0.3, effectiveWeight: 0.3, score: 70, scored: true, reason: '1 of 3 workflows is unowned.', inputs: { total: 3, unowned: 1 } },
      { key: 'reliability', label: 'Reliability', weight: 0.25, effectiveWeight: 0.25, score: 55, scored: true, reason: '1 failing, 1 degraded of 3 evaluated.', inputs: { evaluated: 3, failing: 1 } },
      { key: 'resilience', label: 'Accountability resilience', weight: 0.2, effectiveWeight: 0.2, score: 50, scored: true, reason: '1 of 2 owned critical is a single point of failure.', inputs: { criticalOwned: 2, atRisk: 1 } },
      { key: 'hygiene', label: 'Hygiene', weight: 0.15, effectiveWeight: 0.15, score: 80, scored: true, reason: '1 of 3 workflows has a hygiene issue.', inputs: { total: 3, issueWorkflows: 1 } },
      { key: 'exposure', label: 'Exposure', weight: 0.1, effectiveWeight: 0.1, score: 50, scored: true, reason: '1 of 1 MCP-exposed reaches a sensitive system.', inputs: { mcpExposed: 1, reachingSensitive: 1 } },
    ],
  },
  unowned: { total: gapsBody.unowned.length, byCriticality: { critical: 1, high: 0, medium: 0, low: 0, none: 0 }, workflows: gapsBody.unowned },
  spofOwners: gapsBody.singleOwnerCritical,
  personalSpaceCritical: gapsBody.personalSpaceCritical,
  noBackupOwner: gapsBody.noBackupOwner,
  failingWithOwner: { count: failingBody.failing.length, workflows: failingBody.failing },
  hygiene: {
    brokenRefs: { count: 1, workflows: [WORKFLOWS[2]] },
    staleEnrichment: { count: 0, workflows: [] },
    activeNoExecutions: { count: 1, workflows: [WORKFLOWS[2]] },
  },
  exposure: {
    mcpExposed: 1, reachingSensitive: 1, reachingSensitiveUnowned: 0,
    surfaces: [{ instanceId: 'prod', instanceLabel: 'prod', workflowId: 'w1', name: 'Salesforce CRM Sync — nightly enrichment', owned: true, ownerLabel: 'Sam Rivers', reachesSensitive: true, sensitiveSystems: ['Postgres'], reachableWorkflows: 2 }],
  },
  changelog: auditBody.entries,
  health: { summary: failingBody.summary, windows: [{ instanceId: 'prod', instanceLabel: 'prod', windowHours: 336, available: true }, { instanceId: 'staging', instanceLabel: 'staging', windowHours: 336, available: false }] },
  generatedAt: '2026-07-06T00:00:00.000Z',
};
const connectionsBody = { connections: [{ id: 'prod', label: 'prod', baseUrl: 'http://localhost:5678', webhookHost: null, createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-05T00:00:00.000Z', health: { status: 'ok', lastSyncedAt: '2026-07-05T00:00:00.000Z', lastError: null, workflowCount: 3, analyzerDrift: { manifestN8nVersion: '2.29.0', status: 'core-drift', coreUnknown: { types: 3, workflows: 2 }, communityUnknown: { types: 1, workflows: 1 }, coreExamples: ['n8n-nodes-base.__futureNode', '@n8n/n8n-nodes-langchain.__newAgent'], communityExamples: ['n8n-nodes-acme.thing'] } } }] };
const gNode = (id, kind, label, over = {}) => ({ id, kind, instanceId: 'prod', instanceLabel: 'prod', label, resourceId: id.split(':').pop(), workflowId: kind === 'workflow' ? id.split(':').pop() : null, health: kind === 'workflow' ? 'healthy' : null, active: kind === 'workflow' ? true : null, archived: kind === 'workflow' ? false : null, isAgent: kind === 'workflow' ? false : null, brokenRef: kind === 'workflow' ? false : null, mcpExposed: kind === 'workflow' ? false : null, ...over });
const graphBody = {
  scope: 'estate', focus: null, hops: null, truncated: false, nodeTotal: 3, generatedAt: '2026-07-07T00:00:00.000Z',
  nodes: [gNode('wf:prod:a', 'workflow', 'Order Intake'), gNode('wf:prod:b', 'workflow', 'Send Slack Alert', { health: 'failing' }), gNode('cred:prod:c', 'credential', 'Postgres — Warehouse')],
  edges: [
    { id: 'e1', source: 'wf:prod:a', target: 'wf:prod:b', type: 'call', confidence: 'confirmed', crossInstance: false, reason: 'executeWorkflow call' },
    { id: 'e2', source: 'wf:prod:a', target: 'cred:prod:c', type: 'binds_credential', confidence: 'confirmed', crossInstance: false, reason: 'binds credential' },
  ],
};
const impactBody = { mode: 'failure', focusKind: 'workflow', focusInstanceId: 'prod', focusId: 'b', focusLabel: 'Send Slack Alert', edgeTypesTraversed: ['call'], affected: [{ instanceId: 'prod', instanceLabel: 'prod', workflowId: 'a', name: 'Order Intake', hops: 1 }], total: 1, possibleExcluded: 0, statement: '1 affected, nothing else.', generatedAt: '2026-07-07T00:00:00.000Z' };
const detailBody = {
  workflow: WORKFLOWS[0],
  facts: {
    schemaVersion: 1, analyzedAt: '2026-07-05T00:00:00.000Z', nodeCount: 4,
    nodeTypes: [{ type: 'n8n-nodes-base.salesforce', count: 1, category: 'action', known: true }],
    triggers: [{ type: 'n8n-nodes-base.scheduleTrigger', display: 'Schedule Trigger', source: 'manifest' }],
    triggerCountDetected: 1, triggerCountReported: 1,
    systems: [{ system: 'Salesforce', via: 'credential', credentialType: 'salesforceOAuth2Api', nodeType: null, resolved: true, raw: 'salesforceOAuth2Api' }],
    credentialTypes: ['salesforceOAuth2Api'], dataTableRefs: [], mcpExposed: true,
    directDeps: [{ kind: 'subWorkflow', nodeId: 'n1', nodeName: 'Call Enrich', mode: 'list', rawValue: 'w2', cachedName: 'Enrich', resolution: 'resolved', resolvedId: 'w2', resolvedName: 'Refund Processor' }],
    callerPolicy: { policy: null, callerIds: [] },
    coverage: { understood: true, unknownNodeTypes: [], unresolvedRefs: 0, reasons: [] },
  },
  deepLink: 'http://localhost:5678/workflow/w1',
};
const executionsBody = {
  runs: [
    { executionId: '9', status: 'error', startedAt: '2026-07-05T00:00:00.000Z', stoppedAt: '2026-07-05T00:00:00.005Z', mode: 'manual', durationMs: 5, deepLink: 'http://localhost:5678/workflow/w1/executions/9' },
    { executionId: '8', status: 'success', startedAt: '2026-07-04T00:00:00.000Z', stoppedAt: '2026-07-04T00:00:02.000Z', mode: 'webhook', durationMs: 2000, deepLink: 'http://localhost:5678/workflow/w1/executions/8' },
  ],
  failure: { executionId: '9', failedNode: 'Fetch Stripe Ledger', errorType: 'NodeApiError', errorCode: 'ECONNREFUSED', deepLink: 'http://localhost:5678/workflow/w1/executions/9' },
  unavailable: false, unavailableReason: null, generatedAt: '2026-07-05T00:00:00.000Z',
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };

function mockApi(route) {
  const p = new URL(route.request().url()).pathname;
  const send = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
  if (p.endsWith('/api/auth/me')) return send({ authenticated: true, actor: ACTOR });
  if (p.endsWith('/api/auth/login')) return send({ authenticated: true, actor: ACTOR });
  if (p.endsWith('/api/auth/logout')) return send({}, 204);
  if (p.endsWith('/api/workflows/coverage')) return send(coverageBody);
  if (p.endsWith('/api/workflows/enrichment-progress')) return send({ enabled: true, lastEnrichedAt: '2026-07-06T00:00:00.000Z', total: 3, analyzed: 3, stub: 0, stale: 0, pending: 0 });
  if (p.endsWith('/api/governance/overview')) return send(overviewBody);
  if (p.endsWith('/api/workflows/failing')) return send(failingBody);
  if (p.endsWith('/api/ownership/gaps')) return send(gapsBody);
  if (p.endsWith('/api/ownership/register')) return send(registerBody);
  if (p.endsWith('/api/ownership/audit')) return send(auditBody);
  if (/\/api\/ownership\/[^/]+\/assignable-users$/.test(p)) return send({ users: [{ email: 'sam@acme.example', name: 'Sam Rivers', role: 'global:member' }], available: true, reason: null });
  if (/\/api\/workflows\/[^/]+\/[^/]+\/executions$/.test(p)) return send(executionsBody);
  if (/\/api\/workflows\/[^/]+\/[^/]+$/.test(p)) return send(detailBody);
  if (p.endsWith('/api/workflows')) return send(workflowsBody);
  if (p.endsWith('/api/settings/llm')) return send({ config: { provider: 'openai', model: 'gpt-5-mini', configured: true, enabled: true, envLocked: false } });
  if (p.endsWith('/api/graph')) return send(graphBody);
  if (p.endsWith('/api/graph/impact')) return send(impactBody);
  if (p.endsWith('/api/connections')) return send(connectionsBody);
  return send({});
}
// The login view must render unauthenticated.
function mockApiUnauth(route) {
  const p = new URL(route.request().url()).pathname;
  if (p.endsWith('/api/auth/me')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false, actor: null }) });
  return mockApi(route);
}

async function serveDist() {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const filePath = join(DIST, urlPath);
      let body, ct;
      try {
        const s = await stat(filePath);
        if (s.isDirectory()) throw new Error('dir');
        body = await readFile(filePath);
        ct = MIME[extname(filePath)] ?? 'application/octet-stream';
      } catch {
        body = await readFile(join(DIST, 'index.html')); // SPA fallback
        ct = 'text/html';
      }
      res.writeHead(200, { 'content-type': ct });
      res.end(body);
    } catch {
      res.writeHead(500); res.end('err');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

const VIEWS = [
  { name: 'Login', path: '/login', mock: mockApiUnauth, waitFor: 'form.panel', key: 'form.panel' },
  { name: 'Overview', path: '/overview', mock: mockApi, waitFor: '[data-testid="overview-score"]', key: '[data-testid="overview-score-breakdown"]' },
  { name: 'Catalog list', path: '/workflows', mock: mockApi, waitFor: '.wf tbody tr', key: '.toolbar' },
  { name: 'Health view', path: '/health', mock: mockApi, waitFor: '[data-testid="health-failing-list"]', key: '[data-testid="health-summary"]' },
  // Wait on the view root (instant) rather than the heavy async vue-flow canvas — the
  // rule-10 gate here is "no horizontal overflow at 375px"; the canvas rendering is
  // proven by GraphView.test.ts. Key element is the always-present scope switcher.
  { name: 'Graph view', path: '/graph', mock: mockApi, waitFor: '[data-testid="graph-view"]', key: '[data-testid="graph-scope-switcher"]' },
  { name: 'Ownership register', path: '/estate/ownership', mock: mockApi, waitFor: '[data-testid="ownership-register"]', key: '[data-testid="ownership-summary"]' },
  { name: 'Activity view', path: '/activity', mock: mockApi, waitFor: '[data-testid="activity-view"]', key: '[data-testid="governance-audit-timeline"]' },
  { name: 'Detail drawer', path: '/workflows', mock: mockApi, waitFor: '.wf tbody tr', key: '.drawer',
    action: async (page) => { await page.click('.wf tbody tr'); await page.waitForSelector('.drawer', { timeout: 4000 }); } },
  { name: 'Settings', path: '/settings', mock: mockApi, waitFor: '[data-testid="settings-view"]', key: '.card' },
  // Chat empty state renders without an /api call (chat only POSTs on send). The rule-10
  // gate is "no horizontal overflow at 375px"; the composer is the always-present key.
  { name: 'Chat view', path: '/chat', mock: mockApi, waitFor: '[data-testid="chat-view"]', key: '[data-testid="chat-input"]' },
  // S6.1: the mock connection is in core-drift, so the analyzer-drift notice renders — the
  // rule-10 gate is "no horizontal overflow at 375px" with the notice (and its example
  // types / rebuild disclosure) present.
  { name: 'Connections', path: '/connections', mock: mockApi, waitFor: '[data-testid="analyzer-drift"]', key: '[data-testid="analyzer-drift"]' },
];

export async function runResponsiveCheck() {
  if (!existsSync(join(DIST, 'index.html'))) return { ok: false, error: 'web not built (apps/web/dist missing)', views: [] };

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    try {
      browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    } catch (e) {
      return { ok: false, error: `could not launch Chrome: ${e.message}`, views: [] };
    }
  }

  const server = await serveDist();
  const base = `http://127.0.0.1:${server.address().port}`;
  const views = [];
  try {
    for (const v of VIEWS) {
      const measurements = [];
      for (const theme of ['light', 'dark']) {
        for (const width of [MOBILE, DESKTOP]) {
          const ctx = await browser.newContext({ viewport: { width, height: 812 }, colorScheme: theme });
          const page = await ctx.newPage();
          await page.route('**/api/**', v.mock);
          await page.goto(`${base}${v.path}`, { waitUntil: 'domcontentloaded' });
          let rendered = true;
          try { await page.waitForSelector(v.waitFor, { timeout: 6000 }); } catch { rendered = false; }
          if (v.action) { try { await v.action(page); } catch { rendered = false; } }
          await page.waitForTimeout(120);
          const m = await page.evaluate((keySel) => {
            const de = document.documentElement;
            const key = document.querySelector(keySel);
            const kr = key ? key.getBoundingClientRect() : null;
            return {
              scrollWidth: de.scrollWidth, innerWidth: window.innerWidth,
              keyPresent: !!key,
              keyInBounds: kr ? kr.right <= window.innerWidth + 1 && kr.width > 0 : false,
            };
          }, v.key);
          measurements.push({ theme, width, rendered, ...m, overflow: m.scrollWidth > m.innerWidth + 1 });
          await ctx.close();
        }
      }
      const ok = measurements.every((x) => x.rendered && !x.overflow && x.keyPresent && x.keyInBounds);
      const worst = measurements.find((x) => !x.rendered || x.overflow || !x.keyInBounds);
      views.push({ name: v.name, ok, measurements, worst: worst ?? null });
    }
  } finally {
    await browser.close();
    server.close();
  }
  return { ok: views.every((v) => v.ok), views };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runResponsiveCheck();
  if (!r.ok && r.error) { console.error(`responsive-check: ${r.error}`); process.exit(1); }
  console.log('\nResponsive check — hero views at 375px (+desktop), both themes');
  for (const v of r.views) {
    const mark = v.ok ? '✔' : '✘';
    const detail = v.ok
      ? v.measurements.map((m) => `${m.theme}@${m.width}: sw${m.scrollWidth}≤iw${m.innerWidth}`).join('  ')
      : `FAIL ${v.worst?.theme}@${v.worst?.width}: scrollWidth ${v.worst?.scrollWidth} vs innerWidth ${v.worst?.innerWidth}${v.worst && !v.worst.rendered ? ' (not rendered)' : ''}`;
    console.log(`  ${mark} ${v.name}: ${detail}`);
  }
  process.exit(r.ok ? 0 : 1);
}
