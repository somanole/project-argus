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
const item = (id, name, systems, triggers, over = {}) => ({
  instanceId: 'prod', instanceLabel: 'prod', id, name, active: true, isArchived: false,
  project: 'Revenue Ops', updatedAt: '2026-07-05T00:00:00.000Z',
  systems, triggers, mcpExposed: false, nodeCount: 4, understood: true, brokenRefCount: 0, enrichment: null, ...over,
});
const WORKFLOWS = [
  item('w1', 'Salesforce CRM Sync — nightly enrichment', ['Salesforce', 'Postgres'], ['n8n-nodes-base.scheduleTrigger'], { mcpExposed: true, enrichment }),
  item('w2', 'Refund Processor', ['Stripe', 'Slack'], ['n8n-nodes-base.webhook']),
  item('w3', 'Lead Scorer', ['OpenAI'], ['n8n-nodes-base.manualTrigger'], { brokenRefCount: 1, understood: false }),
];
const workflowsBody = {
  workflows: WORKFLOWS,
  facets: {
    systems: [{ value: 'Salesforce', count: 1 }, { value: 'Postgres', count: 1 }, { value: 'Stripe', count: 1 }, { value: 'Slack', count: 1 }, { value: 'OpenAI', count: 1 }],
    triggers: [{ value: 'n8n-nodes-base.webhook', label: 'Webhook', count: 1 }, { value: 'n8n-nodes-base.scheduleTrigger', label: 'Schedule Trigger', count: 1 }, { value: 'n8n-nodes-base.manualTrigger', label: 'Manual Trigger', count: 1 }],
    instances: [{ id: 'prod', label: 'prod', count: 3 }],
  },
  generatedAt: '2026-07-05T00:00:00.000Z',
};
const coverageBody = { total: 3, understood: 2, understoodPct: 66.7, gapsByKind: {}, unknownNodeTypes: [], unresolvedRefTotal: 0, dynamicRefTotal: 0, brokenRefTotal: 1, perInstance: [] };
const connectionsBody = { connections: [{ id: 'prod', label: 'prod', baseUrl: 'http://localhost:5678', webhookHost: null, createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-05T00:00:00.000Z', health: { status: 'ok', lastSyncedAt: '2026-07-05T00:00:00.000Z', lastError: null, workflowCount: 3 } }] };
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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };

function mockApi(route) {
  const p = new URL(route.request().url()).pathname;
  const send = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
  if (p.endsWith('/api/auth/me')) return send({ authenticated: true, actor: ACTOR });
  if (p.endsWith('/api/auth/login')) return send({ authenticated: true, actor: ACTOR });
  if (p.endsWith('/api/auth/logout')) return send({}, 204);
  if (p.endsWith('/api/workflows/coverage')) return send(coverageBody);
  if (p.endsWith('/api/workflows/enrichment-progress')) return send({ enabled: true, lastEnrichedAt: '2026-07-06T00:00:00.000Z', total: 3, analyzed: 3, stub: 0, stale: 0, pending: 0 });
  if (/\/api\/workflows\/[^/]+\/[^/]+$/.test(p)) return send(detailBody);
  if (p.endsWith('/api/workflows')) return send(workflowsBody);
  if (p.endsWith('/api/settings/llm')) return send({ config: { provider: 'openai', model: 'gpt-5-mini', configured: true, enabled: true, envLocked: false } });
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
  { name: 'Catalog list', path: '/workflows', mock: mockApi, waitFor: '.wf tbody tr', key: '.filterbar' },
  { name: 'Detail drawer', path: '/workflows', mock: mockApi, waitFor: '.wf tbody tr', key: '.drawer',
    action: async (page) => { await page.click('.wf tbody tr'); await page.waitForSelector('.drawer', { timeout: 4000 }); } },
  { name: 'Settings', path: '/settings', mock: mockApi, waitFor: '[data-testid="settings-view"]', key: '.card' },
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
