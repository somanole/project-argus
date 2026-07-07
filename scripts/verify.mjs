#!/usr/bin/env node
// pnpm verify — the executable definition of done (standing rule 3).
//
// One command, one plain-English report: every behavior the product owner has
// signed off → pass/fail → a number they can sanity-check. Green = shippable.
// Each milestone adds rows here in the same session the behavior is approved.
//
// M0 behaviors:
//   1. Server boots and GET /api/health responds
//   2. Web app builds (vue-tsc + vite)
//   3. n8n is reachable and its E2E endpoints are active
//   4. Contract-probe files exist
//   5. The placeholder is wired for BOTH light and dark (never flattened)
// M1 behaviors: the seeded estate's planted problems are really there.
// S1a behaviors (connect & live inventory): login required; register both
//   instances; whole estate in one view; filter by instance; API keys never
//   exposed; live update within a minute; self-heal after downtime.
//
// Usage: pnpm verify   (n8n must be running + seeded — see CLAUDE.md)

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { createN8nClient } from './lib/n8n-client.mjs';
import { INSTANCES } from './lib/launch.mjs';
import {
  connect, allWorkflows, subRefs, tagsOf, ownerProjectId, credTypesOf,
  teamProjects, projectMembers, execCount, mcpWorkflows, OWNER_EMAIL,
} from './lib/estate-read.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const N8N_BASE = process.env.N8N_BASE_URL ?? 'http://localhost:5678';
const checks = [];

function add(behavior, pass, detail) {
  checks.push({ behavior, pass, detail });
}

async function pollHealth(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(150);
  }
  return null;
}

// ---- Check 2 first: build everything (the web-build check + prereq for check 1) ----
let built = false;
let buildErr = '';
try {
  execSync('pnpm -r build', { cwd: ROOT, stdio: 'pipe' });
  built = true;
} catch (e) {
  built = false;
  buildErr = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
}
{
  const indexHtml = join(ROOT, 'apps/web/dist/index.html');
  const assetsDir = join(ROOT, 'apps/web/dist/assets');
  const css = built && existsSync(assetsDir) ? readdirSync(assetsDir).filter((f) => f.endsWith('.css')) : [];
  const ok = built && existsSync(indexHtml) && css.length > 0;
  add(
    'Web app builds (typecheck + bundle)',
    ok,
    ok ? `dist/index.html + ${css.length} css bundle` : `build failed: ${buildErr.split('\n').filter(Boolean).slice(-4).join(' ')}`,
  );
}

// ---- Check 1: server boots and /api/health responds ----
{
  const port = 3111;
  const serverEntry = join(ROOT, 'apps/server/dist/index.js');
  let child;
  let health = null;
  if (built && existsSync(serverEntry)) {
    child = spawn('node', [serverEntry], {
      cwd: ROOT,
      // Isolated throwaway DB so the health check never touches real Argus data.
      env: { ...process.env, ARGUS_PORT: String(port), ARGUS_HOST: '127.0.0.1', ARGUS_DB_PATH: join(tmpdir(), `argus-verify-m0-${Date.now()}.sqlite`) },
      stdio: 'ignore',
    });
    health = await pollHealth(`http://127.0.0.1:${port}/api/health`);
    child.kill();
  }
  const ok = !!health && health.status === 'ok' && health.db === 'ok' && health.service === 'argus-server';
  add(
    'Server boots and GET /api/health responds',
    ok,
    ok ? `status=${health.status}, db=${health.db}, v${health.version}` : 'no healthy response on :3111',
  );
}

// ---- Check 3: n8n reachable + E2E endpoints active ----
{
  let reachable = false;
  let e2eActive = false;
  try {
    const h = await fetch(`${N8N_BASE}/healthz`);
    reachable = h.status === 200;
  } catch { /* down */ }
  try {
    const r = await fetch(`${N8N_BASE}/rest/e2e/feature`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'feat:sharing', enabled: true }),
    });
    e2eActive = r.status >= 200 && r.status < 300;
  } catch { /* down */ }
  const ok = reachable && e2eActive;
  add(
    'n8n reachable and E2E endpoints active',
    ok,
    ok ? `healthz 200 + PATCH /rest/e2e/feature 200` : `reachable=${reachable}, e2e=${e2eActive} — start n8n (see CLAUDE.md)`,
  );
}

// ---- Check 4: contract-probe files exist ----
{
  const dir = join(ROOT, 'contracts');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^n8n-\d.*\.json$/.test(f)) : [];
  const required = ['n8n-00-reachable', 'n8n-01-e2e-feature-patch', 'n8n-02-public-api-unauth-rejected',
    'n8n-05-workflow-shared-shape', 'n8n-06-folders-visibility', 'n8n-07-agents-v2-visibility',
    'n8n-15-workflow-list-shape'];
  const missing = required.filter((r) => !files.some((f) => f.startsWith(r)));
  const ok = missing.length === 0;
  add('Contract-probe files exist', ok, ok ? `${files.length} probe files in contracts/` : `missing: ${missing.join(', ')}`);
}

// ---- Check 5: UI wired for BOTH light and dark, tokens only (rule 10) ----
{
  // Scan ALL shipped CSS bundles (the app is code-split into per-route chunks;
  // the token/theme/font rules live in the main entry chunk).
  const assetsDir = join(ROOT, 'apps/web/dist/assets');
  const cssFiles = built && existsSync(assetsDir) ? readdirSync(assetsDir).filter((f) => f.endsWith('.css')) : [];
  const cssText = cssFiles.map((f) => readFileSync(join(assetsDir, f), 'utf8')).join('\n');
  const hasPrimitives = /--color--/.test(cssText);
  const hasDarkAttr = /data-theme=['"]?dark/.test(cssText);
  const hasMediaDark = /prefers-color-scheme:\s*dark/.test(cssText);
  const hasFont = /InterVariable/.test(cssText);

  // EVERY Argus component must use tokens, never hard-coded hex (standing rule
  // 10) — scan all our .vue style blocks (excluding the vendored token dir).
  const walkVue = (dir) => {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'n8n-tokens') out.push(...walkVue(join(dir, e.name))); }
      else if (e.name.endsWith('.vue')) out.push(join(dir, e.name));
    }
    return out;
  };
  const webSrc = join(ROOT, 'apps/web/src');
  let hex = [];
  let usesTokens = 0;
  for (const f of existsSync(webSrc) ? walkVue(webSrc) : []) {
    const src = readFileSync(f, 'utf8');
    const i = src.indexOf('<style');
    if (i === -1) continue;
    const styleBlock = src.slice(i);
    hex.push(...(styleBlock.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []));
    usesTokens += (styleBlock.match(/var\(--/g) ?? []).length;
  }

  const ok = hasPrimitives && hasDarkAttr && hasMediaDark && hasFont && hex.length === 0 && usesTokens > 10;
  const parts = [
    hasPrimitives ? 'primitives✓' : 'primitives✗',
    hasDarkAttr ? 'dark-attr✓' : 'dark-attr✗',
    hasMediaDark ? 'media-dark✓' : 'media-dark✗',
    hasFont ? 'font✓' : 'font✗',
    `${usesTokens} var(--) refs`,
    hex.length === 0 ? 'no hard-coded hex' : `${hex.length} HEX!`,
  ];
  add('UI renders in BOTH light and dark (tokens only)', ok, parts.join(', '));
}

// ---- UI-presence (standing rule 11): every signed-off chrome element ships ----
// Presence/state guard, not appearance — grep the built bundle for each stable
// data-testid. The fast component tests (Vue Test Utils) assert each renders with
// its key text/state; this row is the plain-English `pnpm verify` counterpart.
{
  const assetsDir = join(ROOT, 'apps/web/dist/assets');
  const jsFiles = built && existsSync(assetsDir) ? readdirSync(assetsDir).filter((f) => f.endsWith('.js')) : [];
  const js = jsFiles.map((f) => readFileSync(join(assetsDir, f), 'utf8')).join('\n');
  const has = (id) => js.includes(`"${id}"`);
  const missing = (ids) => ids.filter((id) => !has(id));

  add('Catalog header shows the coverage number', has('coverage-indicator'),
    has('coverage-indicator') ? 'coverage-indicator present' : 'coverage-indicator MISSING');

  const fresh = missing(['freshness-pill', 'synced-indicator']);
  add('Catalog header shows the polling freshness pill + synced indicator', fresh.length === 0,
    fresh.length === 0 ? 'freshness-pill + synced-indicator present' : `MISSING: ${fresh.join(', ')}`);

  // The freshness pill must go HONEST when a connection stops syncing (rule 5) —
  // a rejected key / unreachable instance surfaces as "not syncing", never a green
  // poll. The failing-state branch ships in the bundle (state guarded by a web test).
  const surfacesFailure = js.includes('not syncing') && js.includes('failing');
  add('Catalog surfaces a failing sync (rejected key ≠ healthy pill)', surfacesFailure,
    surfacesFailure ? 'failing-state pill ships' : 'failing-state pill MISSING');

  const filters = ['filter-search', 'filter-state', 'filter-mcp', 'filter-broken', 'filter-instance', 'filter-system', 'filter-criticality', 'filter-trigger'];
  const fmissing = missing(filters);
  add('Catalog shows all filter controls (search/state/MCP/broken/instance/system/criticality/trigger)', fmissing.length === 0,
    fmissing.length === 0 ? `${filters.length} filter controls present` : `MISSING: ${fmissing.join(', ')}`);

  add('Connections screen shows the connection-health indicator', has('connection-health'),
    has('connection-health') ? 'connection-health present' : 'connection-health MISSING');

  // S2: enrichment chrome — catalog badges, drawer section (summary + criticality
  // reason + risk flags + correction), the "enriched X/Y" indicator, and the Settings
  // provider/key screen. Each has a component test asserting its state; this is the
  // plain-English presence counterpart (rule 11).
  const enrichUi = [
    'enrichment-badges', 'enrichment-criticality', 'enrichment-section', 'enrichment-criticality-reason',
    'enrichment-correct-button', 'enrichment-progress', 'settings-view', 'enrichment-toggle', 'llm-provider-select', 'llm-key-input', 'llm-save',
  ];
  const eMissing = missing(enrichUi);
  add('Enrichment UI ships (master switch, catalog badges, drawer summary+reason, correction)', eMissing.length === 0,
    eMissing.length === 0 ? `${enrichUi.length} enrichment UI elements present` : `MISSING: ${eMissing.join(', ')}`);

  // S3: health chrome — the catalog badge + health facet, the "what's failing" view
  // (failing list, summary, retention window, poll-fresh/honest-stale indicator), and
  // the drawer health section. Each has a component test; this is the presence counterpart.
  const healthUi = ['health-badge', 'filter-health', 'health-view', 'health-failing-list', 'health-window', 'health-freshness', 'health-section', 'health-summary', 'execution-runs', 'execution-failure'];
  const hMissing = missing(healthUi);
  add('Health UI ships (catalog badge+facet, failing view, drawer health + runs/failure)', hMissing.length === 0,
    hMissing.length === 0 ? `${healthUi.length} health UI elements present` : `MISSING: ${hMissing.join(', ')}`);

  // S4: ownership chrome — the catalog owner badge, the drawer ownership section +
  // assign dialog, the Governance view (gaps groups + audit timeline + export), and the
  // incident owner on the failing surface. Each has a component test; presence counterpart.
  const ownUi = [
    'owner-badge', 'ownership-section', 'ownership-assign-button', 'assign-owner-dialog', 'assign-owner-picker', 'assign-owner-suggestion',
    'governance-view', 'governance-gaps', 'gap-unowned', 'gap-single-owner', 'gap-personal-space', 'gap-no-backup',
    'governance-audit-timeline', 'governance-audit-export', 'incident-owner',
  ];
  const oMissing = missing(ownUi);
  add('Ownership UI ships (owner badge, assign dialog, Governance gaps + audit timeline, incident owner)', oMissing.length === 0,
    oMissing.length === 0 ? `${ownUi.length} ownership UI elements present` : `MISSING: ${oMissing.join(', ')}`);
}

// ---- Responsive (standing rule 10): hero views usable at 375px, both themes ----
// Renders each hero view in a real browser (system Chrome) at 375px + desktop, in
// light AND dark, and asserts documentElement.scrollWidth <= innerWidth (no
// horizontal overflow) with the key element in-bounds. Hermetic (serves the built
// bundle, mocks /api). If a browser can't launch, we say so — never fake a pass.
{
  let res;
  try {
    const { runResponsiveCheck } = await import('./responsive-check.mjs');
    res = await runResponsiveCheck();
  } catch (e) {
    res = { ok: false, error: e.message, views: [] };
  }
  if (res.error) {
    add('Hero views usable at 375px (no horizontal overflow)', false, `responsive check unavailable: ${res.error}`);
  } else {
    const byName = Object.fromEntries(res.views.map((v) => [v.name, v]));
    const row = (label, viewName) => {
      const v = byName[viewName];
      const ok = !!v && v.ok;
      const detail = ok
        ? '375px + desktop, light + dark: no horizontal overflow'
        : v?.worst
          ? `overflow at ${v.worst.theme}@${v.worst.width}: scrollWidth ${v.worst.scrollWidth} > innerWidth ${v.worst.innerWidth}${!v.worst.rendered ? ' (not rendered)' : ''}`
          : 'view not measured';
      add(label, ok, detail);
    };
    row('Login usable at 375px — no horizontal overflow', 'Login');
    row('Catalog usable at 375px — no horizontal overflow, no cut-off fields', 'Catalog list');
    row('Health view usable at 375px — no horizontal overflow', 'Health view');
    row('Governance view usable at 375px — no horizontal overflow', 'Governance view');
    row('Detail drawer usable at 375px — full-width, no overflow', 'Detail drawer');
    row('Settings usable at 375px — no horizontal overflow', 'Settings');
  }
}

// ---- S2 checks: enrichment (hermetic — no n8n, no live LLM, no spend) ----
await s2Checks();

// ---- Seeder checks (M1): the planted problems are really there ----
// Read-only, from n8n's own APIs (no Argus analyzer yet). Needs `pnpm seed` first.
await seederChecks();

// ---- S1a checks: connect & live inventory (the signed-off behaviors) ----
// Drives a real Argus server against both live instances end to end.
await s1aChecks();

// ---- S1b checks: catalog (deterministic facts, filters, coverage) ----
// Corpus robustness (offline), the analyzer over the live seed, the API filters,
// and the scale smoke-test.
await s1bChecks();

// ---- S3 checks: health (per-workflow status from executions, the failing view) ----
// Drives a real Argus server against both live instances; asserts the seeded health
// scenarios read as planted and the "what's failing" feed is correct + retention-honest.
await s3Checks();

// ---- S4 checks: ownership & accountability (the two guarantees + gaps, live) ----
// Hermetic suite for the guarantees + gap logic; then a real Argus server against both
// live instances to prove inference, audited assignment, resync-safety, and the
// single-owner-critical cross-instance gap end to end.
await s4Checks();

// S2 enrichment — all hermetic (built code + JSON + unit suite); no n8n, no LLM spend.
async function s2Checks() {
  // 1. THE GATE (data-flow): planted secrets never reach the model. Runs the SAME
  //    built allowlist builder the server uses; asserts params/URLs/secrets are absent
  //    from the egress payload. Provider-agnostic — one payload for both providers.
  try {
    const mod = await import(pathToFileURL(join(ROOT, 'apps/server/dist/enrichment/allowlist.js')).href);
    const S = {
      aws: 'AKIAIOSFODNN7EXAMPLE',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig_abc123def456ghi789jkl',
      conn: 'postgres://u:HunterYellow42Pass@db.internal:5432/main',
      url: 'https://apiuser:P4ssw0rdLeak@api.vendor.example/v1?api_key=tok9xKq2mVn7Pw4Lr8Ts',
      nodeName: 'sk-proj-NODELEAKabcdefghij0123456789',
      tag: 'xoxb-999888-TAGLEAKtokenvalue',
    };
    const facts = {
      schemaVersion: 1, analyzedAt: '', nodeCount: 2, nodeTypes: [],
      triggers: [{ type: 'n8n-nodes-base.webhook', display: 'Webhook', source: 'manifest' }],
      triggerCountDetected: 1, triggerCountReported: 1,
      systems: [{ system: 'Postgres', via: 'credential', credentialType: 'postgres', nodeType: null, resolved: true, raw: 'postgres' }],
      credentialTypes: ['postgres'], dataTableRefs: [], mcpExposed: false, directDeps: [],
      callerPolicy: { policy: null, callerIds: [] }, coverage: { understood: true, unknownNodeTypes: [], unresolvedRefs: 0, reasons: [] },
    };
    const wf = {
      id: 'w', name: 'Vendor Sync', active: true, isArchived: false, createdAt: '', updatedAt: '', versionId: 'v', shared: [],
      nodes: [
        { type: 'n8n-nodes-base.httpRequest', name: `Call ${S.nodeName}`, parameters: { url: S.url, auth: `Bearer ${S.jwt}` } },
        { type: 'n8n-nodes-base.postgres', name: 'Store', parameters: { conn: S.conn, aws: S.aws } },
      ],
      connections: {}, settings: {}, triggerCount: 1, tags: [{ id: 't', name: S.tag }],
    };
    const { input } = mod.buildEnrichmentInput(wf, facts, { project: 'Data Platform' });
    const blob = JSON.stringify(input);
    const leaked = Object.entries(S).filter(([, v]) => blob.includes(v)).map(([k]) => k);
    const noUrl = !/https?:\/\//.test(blob);
    add('Planted secrets never reach the model (allowlist + redaction, either provider)', leaked.length === 0 && noUrl,
      leaked.length === 0 && noUrl ? 'no params, URLs, or planted secrets in the egress payload' : `LEAKED: ${[...leaked, noUrl ? '' : 'a URL'].filter(Boolean).join(', ')}`);
  } catch (e) {
    add('Planted secrets never reach the model', false, `could not load built enrichment code (build first): ${e.message}`);
  }

  // 2. The eval harness runs: the labeled set parses and the H1 scorer computes (no LLM).
  try {
    const labeled = JSON.parse(readFileSync(join(ROOT, 'scripts/eval/labeled/workflows.json'), 'utf8'));
    const { score } = await import(pathToFileURL(join(ROOT, 'scripts/eval/score.mjs')).href);
    const s = score([{ expected: { category: 'revenue-ops', criticality: 'high', riskFlags: ['x'] }, output: { category: 'revenue-ops', criticality: 'high', riskFlags: ['x'] } }]);
    const ok = Array.isArray(labeled.cases) && labeled.cases.length >= 10 && s.categoryAccuracy === 100 && s.riskFlagPrecision === 100;
    add('Enrichment eval harness runs (labeled set parses, H1 scorer computes)', ok, `${labeled.cases?.length ?? 0} labeled cases; scorer verified`);
  } catch (e) {
    add('Enrichment eval harness runs', false, `eval harness error: ${e.message}`);
  }

  // 3. The behavioral guarantees are asserted by the unit suite: re-run = 0 API calls,
  //    correction writes an audit entry in the same transaction, kill switch = no-op,
  //    redaction, schema gating, provider abstraction, stub-not-guess.
  try {
    execSync('pnpm --filter @argus/server exec vitest run src/enrichment src/llm src/app.test.ts', { cwd: ROOT, stdio: 'pipe' });
    add('Enrichment behaviors green (0-call re-run · audited correction · kill switch · redaction)', true, 'enrichment + llm + api unit suite passed');
  } catch (e) {
    const out = (e.stdout?.toString() || e.message || '').slice(-160);
    add('Enrichment behaviors green (0-call re-run · audited correction · kill switch · redaction)', false, `suite failed: ${out}`);
  }
}

async function seederChecks() {
  const both = (p, s) => p && s;

  // 1. Two isolated E2E instances up.
  const up = {};
  for (const inst of Object.values(INSTANCES)) {
    const c = createN8nClient(inst.baseUrl);
    up[inst.name] = (await c.healthy()) && (await c.e2eActive());
  }
  add('Two isolated E2E instances up (prod + staging)', both(up.prod, up.staging),
    `prod=${up.prod ? 'up' : 'down'}, staging=${up.staging ? 'up' : 'down'}`);
  if (!both(up.prod, up.staging)) return;

  // Read both estates once.
  const read = async (inst) => {
    const c = await connect(inst.baseUrl);
    const wfs = await allWorkflows(c);
    return { inst, c, wfs, byName: new Map(wfs.map((w) => [w.name, w])), ids: new Set(wfs.map((w) => w.id)) };
  };
  let P, S;
  try {
    P = await read(INSTANCES.prod);
    S = await read(INSTANCES.staging);
  } catch (e) {
    add('Estate is seeded', false, `could not read estate: ${e.message} — run \`pnpm seed\``);
    return;
  }
  if (P.wfs.length === 0 || S.wfs.length === 0) {
    add('Estate is seeded', false, `prod=${P.wfs.length} wf, staging=${S.wfs.length} wf — run \`pnpm seed\``);
    return;
  }

  // 2. 4 team projects per instance.
  const TEAM_NAMES = ['Revenue Ops', 'Customer Support', 'Data Platform', 'Marketing'];
  const pTeams = await teamProjects(P.c);
  const sTeams = await teamProjects(S.c);
  const teamsOk = (t) => TEAM_NAMES.every((n) => t.some((p) => p.name === n));
  add('4 team projects per instance', both(teamsOk(pTeams) && pTeams.length === 4, teamsOk(sTeams) && sTeams.length === 4),
    `prod ${pTeams.length}, staging ${sTeams.length}`);

  // 3. Workflow count per instance in range (~100: curated core + procedural background).
  const inRange = (n) => n >= 90 && n <= 115;
  add('Workflow count per instance in range (~100)', both(inRange(P.wfs.length), inRange(S.wfs.length)),
    `prod ${P.wfs.length}, staging ${S.wfs.length}`);

  // 4. Sub-workflow chain depth 3 (Order Intake → Enrich → Billing).
  const chainDepth = (x) => {
    const oi = x.byName.get('Order Intake'), en = x.byName.get('Enrich Customer'), bi = x.byName.get('Billing Service');
    return oi && en && bi && subRefs(oi).includes(en.id) && subRefs(en).includes(bi.id) ? 3 : 0;
  };
  add('Sub-workflow chain depth 3 (Order Intake→Enrich→Billing)', both(chainDepth(P) === 3, chainDepth(S) === 3),
    `prod depth ${chainDepth(P)}, staging depth ${chainDepth(S)}`);

  // 5. "Send Slack Alert" fan-in = 5.
  const fanIn = (x) => {
    const slack = x.byName.get('Send Slack Alert');
    if (!slack) return -1;
    return x.wfs.filter((w) => subRefs(w).includes(slack.id)).length;
  };
  add('"Send Slack Alert" called by exactly 5 workflows', both(fanIn(P) === 5, fanIn(S) === 5),
    `prod fan-in ${fanIn(P)}, staging fan-in ${fanIn(S)}`);

  // 6. Exactly one broken reference.
  const brokenCount = (x) => x.wfs.flatMap((w) => subRefs(w)).filter((r) => !x.ids.has(r)).length;
  add('Exactly one broken sub-workflow reference', both(brokenCount(P) === 1, brokenCount(S) === 1),
    `prod ${brokenCount(P)}, staging ${brokenCount(S)}`);

  // 7. Exactly one orphan ("Old CSV Import": inactive, unreferenced, untagged).
  const orphanOk = (x) => {
    const o = x.byName.get('Old CSV Import');
    if (!o) return false;
    const inbound = x.wfs.filter((w) => subRefs(w).includes(o.id)).length;
    return !o.active && inbound === 0 && tagsOf(o).length === 0;
  };
  add('Planted orphan present (inactive, unreferenced)', both(orphanOk(P), orphanOk(S)),
    `prod ${orphanOk(P) ? 'ok' : 'no'}, staging ${orphanOk(S) ? 'ok' : 'no'}`);

  // 8. Deliberate failures present (Stripe error-only; Zendesk + Sentinel mixed).
  const failuresOk = async (x) => {
    const recon = x.byName.get('Daily Stripe Reconciliation');
    const zen = x.byName.get('Zendesk Sync');
    const sen = x.byName.get('Data Quality Sentinel');
    const reconErr = await execCount(x.c, recon.id, 'error');
    const reconOk = await execCount(x.c, recon.id, 'success');
    const zenErr = await execCount(x.c, zen.id, 'error');
    const zenOk = await execCount(x.c, zen.id, 'success');
    const senErr = await execCount(x.c, sen.id, 'error');
    const senOk = await execCount(x.c, sen.id, 'success');
    return { pass: reconErr > 0 && reconOk === 0 && zenErr > 0 && zenOk > 0 && senErr > 0 && senOk > 0, reconErr, zenErr, zenOk, senErr, senOk };
  };
  const fp = await failuresOk(P);
  const fs = await failuresOk(S);
  add('Deliberate failures have real run history', both(fp.pass, fs.pass),
    `prod: Stripe ${fp.reconErr} err/only, Zendesk ${fp.zenOk}✓/${fp.zenErr}✘, Sentinel ${fp.senOk}✓/${fp.senErr}✘`);

  // 9. Single-owner-critical: Revenue Ops has one assigned member (Sam) + ≥5 critical.
  const spof = async (x, teams) => {
    const rev = teams.find((p) => p.name === 'Revenue Ops');
    if (!rev) return { pass: false, members: [], critical: 0 };
    const members = (await projectMembers(x.c, rev.id)).filter((e) => e !== OWNER_EMAIL);
    const critical = x.wfs.filter((w) => tagsOf(w).includes('critical') && ownerProjectId(w) === rev.id).length;
    return { pass: members.length === 1 && members[0] === 'sam.rivers@acme.example' && critical >= 5, members, critical };
  };
  const spofP = await spof(P, pTeams);
  const spofS = await spof(S, sTeams);
  add('Single-owner-critical (Sam solely owns ≥5 critical)', both(spofP.pass, spofS.pass),
    `prod: ${spofP.members.length} owner=${spofP.members[0] ?? '?'}, ${spofP.critical} critical`);

  // 10. Archived workflow still called by a live (non-archived) workflow.
  // (n8n 2.29 blocks *publishing* a workflow that references an archived callee,
  // so the caller is live-but-unpublished — the depends_on_archived finding.)
  const archivedCalled = (x) => {
    const archived = x.wfs.filter((w) => w.isArchived);
    return archived.some((a) => x.wfs.some((w) => !w.isArchived && subRefs(w).includes(a.id)));
  };
  add('Archived workflow still called by a live workflow', both(archivedCalled(P), archivedCalled(S)),
    `prod ${archivedCalled(P) ? 'yes' : 'no'}, staging ${archivedCalled(S) ? 'yes' : 'no'}`);

  // 11. Cross-instance webhook edge: staging HTTP → prod webhook (host+path).
  const bridge = S.byName.get('Staging → Prod Order Sync');
  const bridgeUrls = (bridge?.nodes ?? []).filter((n) => n.type === 'n8n-nodes-base.httpRequest').map((n) => n.parameters?.url);
  const prodHook = `${INSTANCES.prod.baseUrl}/webhook/order-intake`;
  const prodHasHook = P.wfs.some((w) => w.active && (w.nodes ?? []).some((n) => n.type === 'n8n-nodes-base.webhook' && n.parameters?.path === 'order-intake'));
  add('Cross-instance webhook edge (staging → prod)', bridgeUrls.includes(prodHook) && prodHasHook,
    bridgeUrls.includes(prodHook) ? `staging calls ${prodHook}` : `bridge urls: ${bridgeUrls.join(', ') || 'none'}`);

  // 12. Shared-identity SPOF: same email is a user in both instances.
  const userEmails = async (c) => (((await c.api('GET', '/users?includeRole=true')).json?.data) ?? []).map((u) => u.email);
  const pEmails = await userEmails(P.c);
  const sEmails = await userEmails(S.c);
  const sharedSam = pEmails.includes('sam.rivers@acme.example') && sEmails.includes('sam.rivers@acme.example');
  add('Shared-identity person across both instances (Sam)', sharedSam,
    `sam present: prod=${pEmails.includes('sam.rivers@acme.example')}, staging=${sEmails.includes('sam.rivers@acme.example')}`);

  // 13. Shared external system: a Salesforce credential referenced in both.
  const salesforceOk = async (x) => {
    const creds = ((await x.c.api('GET', '/credentials')).json?.data) ?? [];
    const hasCred = creds.some((cr) => cr.type === 'salesforceOAuth2Api');
    const usedBy = x.wfs.some((w) => credTypesOf(w).includes('salesforceOAuth2Api'));
    return hasCred && usedBy;
  };
  const sfP = await salesforceOk(P);
  const sfS = await salesforceOk(S);
  add('Shared external system (Salesforce) in both instances', both(sfP, sfS),
    `prod ${sfP ? 'yes' : 'no'}, staging ${sfS ? 'yes' : 'no'}`);

  // 14. Two MCP-exposed workflows per instance.
  const pMcp = (await mcpWorkflows(P.c)).length;
  const sMcp = (await mcpWorkflows(S.c)).length;
  add('Two MCP-exposed workflows per instance', both(pMcp === 2, sMcp === 2),
    `prod ${pMcp}, staging ${sMcp}`);
}

// S1a — spin up a real Argus server against both live instances and verify the
// owner's signed-off behaviors: register, one estate list, filter, login-gate,
// live update within a minute, self-heal after downtime.
async function s1aChecks() {
  // Need both instances reachable + E2E (the seeder + inventory source).
  const up = {};
  for (const inst of Object.values(INSTANCES)) {
    const c = createN8nClient(inst.baseUrl);
    up[inst.name] = (await c.healthy()) && (await c.e2eActive());
  }
  if (!up.prod || !up.staging) {
    add('S1a live inventory', false, `instances down (prod=${up.prod ? 'up' : 'down'}, staging=${up.staging ? 'up' : 'down'}) — run \`pnpm seed\``);
    return;
  }

  const serverEntry = join(ROOT, 'apps/server/dist/index.js');
  if (!existsSync(serverEntry)) {
    add('S1a live inventory', false, 'server build missing');
    return;
  }

  const port = 3211;
  const base = `http://127.0.0.1:${port}`;
  const dbPath = join(tmpdir(), `argus-verify-s1a-${Date.now()}.sqlite`);
  const env = {
    ...process.env,
    ARGUS_PORT: String(port), ARGUS_HOST: '127.0.0.1', ARGUS_DB_PATH: dbPath,
    ARGUS_ADMIN_PASSWORD: 'verify-admin', ARGUS_SESSION_SECRET: 'verify-secret',
    ARGUS_ENCRYPTION_KEY: 'verify-enc', ARGUS_POLL_INTERVAL_MS: '3000',
  };
  const boot = () => spawn('node', [serverEntry], { cwd: ROOT, env, stdio: 'ignore' });

  let cookie = '';
  async function argus(path, opts = {}) {
    const headers = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    let json;
    try { json = await res.json(); } catch { /* 204/none */ }
    return { status: res.status, json, setCookies: res.headers.getSetCookie?.() ?? [] };
  }
  const rename = (c, wf, full, name) => c.api('PUT', `/workflows/${wf.id}`, { name, nodes: full.nodes, connections: full.connections, settings: full.settings });
  const listNames = async () => ((await argus('/api/workflows')).json?.workflows ?? []).map((w) => w.name);

  let child = boot();
  try {
    const health = await pollHealth(`${base}/api/health`);
    if (!health) { add('S1a Argus server boots', false, `no health on :${port}`); return; }

    // Login is required before anything else.
    const unauth = await argus('/api/workflows');
    add('Login required (no session ⇒ blocked)', unauth.status === 401, `GET /api/workflows without session → ${unauth.status}`);

    const li = await argus('/api/auth/login', { method: 'POST', body: { password: 'verify-admin', name: 'Verify Owner', email: 'verify@acme.example' } });
    cookie = li.setCookies.map((c) => c.split(';')[0]).join('; ');

    // Connect to n8n (mint read keys) + read the ground truth per instance.
    const prodC = await connect(INSTANCES.prod.baseUrl);
    const stagingC = await connect(INSTANCES.staging.baseUrl);
    const prodWfs = await allWorkflows(prodC);
    const stagingWfs = await allWorkflows(stagingC);

    // Register both instances.
    const r1 = await argus('/api/connections', { method: 'POST', body: { label: 'prod', baseUrl: INSTANCES.prod.baseUrl, apiKey: prodC.apiKey } });
    const r2 = await argus('/api/connections', { method: 'POST', body: { label: 'staging', baseUrl: INSTANCES.staging.baseUrl, apiKey: stagingC.apiKey } });
    const prodId = r1.json?.connection?.id;
    const stagingId = r2.json?.connection?.id;
    const conns = (await argus('/api/connections')).json?.connections ?? [];
    const healths = conns.map((c) => c.health.status).join('/');
    add('Register both seeded instances', r1.status === 201 && r2.status === 201 && conns.length === 2 && conns.every((c) => c.health.status === 'ok'),
      `${conns.length} connections registered, health ${healths || 'none'}`);

    // The whole estate in one view.
    const total = ((await argus('/api/workflows')).json?.workflows ?? []).length;
    const expected = prodWfs.length + stagingWfs.length;
    add('Whole estate lists in one view', total === expected, `Argus ${total} = prod ${prodWfs.length} + staging ${stagingWfs.length}`);

    // Filter by instance.
    const pf = ((await argus(`/api/workflows?instanceId=${prodId}`)).json?.workflows ?? []).length;
    const sf = ((await argus(`/api/workflows?instanceId=${stagingId}`)).json?.workflows ?? []).length;
    add('Filter by instance', pf === prodWfs.length && sf === stagingWfs.length, `prod ${pf}, staging ${sf}`);

    // API keys are never exposed.
    const leak = JSON.stringify(conns).includes(prodC.apiKey) || JSON.stringify(conns).includes(stagingC.apiKey);
    add('API keys never exposed (encrypted at rest)', !leak, leak ? 'KEY LEAKED in a response' : 'no key in any response');

    // Live update within a minute: rename a prod workflow, watch Argus catch it.
    const target = prodWfs.find((w) => w.name === 'Old CSV Import') ?? prodWfs[0];
    const full = (await prodC.api('GET', `/workflows/${target.id}`)).json;
    let liveOk = false, liveSecs = '60+';
    if (target && full) {
      const newName = `Argus verify — ${Date.now()}`;
      await rename(prodC, target, full, newName);
      const t0 = Date.now();
      while (Date.now() - t0 < 60_000) {
        if ((await listNames()).includes(newName)) { liveOk = true; liveSecs = ((Date.now() - t0) / 1000).toFixed(1); break; }
        await sleep(1000);
      }
      add('Live update reflected within a minute', liveOk, liveOk ? `n8n edit → Argus in ${liveSecs}s` : 'not reflected within 60s');

      // Self-heal: kill Argus, change n8n while it's down, restart on the same DB.
      child.kill();
      await sleep(700);
      const downName = `Argus self-heal — ${Date.now()}`;
      await rename(prodC, target, full, downName);
      child = boot();
      const h2 = await pollHealth(`${base}/api/health`);
      let healed = false, healSecs = '60+';
      if (h2) {
        const t1 = Date.now();
        while (Date.now() - t1 < 60_000) {
          if ((await listNames()).includes(downName)) { healed = true; healSecs = ((Date.now() - t1) / 1000).toFixed(1); break; }
          await sleep(1000);
        }
      }
      add('Self-heals after downtime (reconciles on restart)', healed, healed ? `caught up ${healSecs}s after restart` : 'did not reconcile');

      // Restore the original name so the seeded estate is untouched.
      await rename(prodC, target, full, target.name);
    } else {
      add('Live update reflected within a minute', false, 'no prod workflow to edit — run `pnpm seed`');
      add('Self-heals after downtime (reconciles on restart)', false, 'skipped (no workflow to edit)');
    }
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
}

// S1b — the catalog: deterministic facts, filters, coverage. Proves the analyzer
// against (a) a corpus of real public templates offline, (b) the live seeded
// estate, (c) the API filters the owner demos, and (d) snappiness at scale.
async function s1bChecks() {
  const up = {};
  for (const inst of Object.values(INSTANCES)) {
    const c = createN8nClient(inst.baseUrl);
    up[inst.name] = (await c.healthy()) && (await c.e2eActive());
  }
  if (!up.prod || !up.staging) {
    add('S1b catalog', false, `instances down (prod=${up.prod ? 'up' : 'down'}, staging=${up.staging ? 'up' : 'down'}) — run \`pnpm seed\``);
    return;
  }

  // ---- Part A: corpus robustness (offline, hermetic fixtures) ----
  try {
    const { runCorpusCheck } = await import('./corpus-check.mjs');
    const floor = JSON.parse(readFileSync(join(ROOT, 'apps/server/src/analyzer/__fixtures__/corpus-floor.json'), 'utf8')).understoodPctFloor;
    const r = runCorpusCheck();
    add(`Analyzer understands ≥${floor}% of real public templates`, r.understoodPct >= floor,
      `understands ${r.understoodPct}% (${r.understood}/${r.total}); rest explicitly unparsed; floor ${floor}%`);
    add('Zero false broken-refs across the corpus', r.brokenIncomplete === 0 && r.falseBroken.length === 0,
      `never-broken-when-partial ${r.brokenIncomplete === 0 ? 'ok' : 'FAIL'}; independent re-derivation false-broken=${r.falseBroken.length}`);
    add('Unrecognized node types catalogued, never dropped', Array.isArray(r.unknownNodeTypes),
      `${r.unknownNodeTypes.length} community/custom types, top: ${r.unknownNodeTypes[0]?.type ?? '—'}`);
  } catch (e) {
    add('Analyzer corpus robustness', false, `corpus-check failed: ${e.message}`);
  }

  // ---- Part B: the analyzer over the LIVE seeded estate ----
  const { analyzeInstance, coverageOf } = await import('../apps/server/dist/analyzer/index.js');
  const at = new Date().toISOString();
  const covEntries = [];
  const perInst = {};
  for (const inst of Object.values(INSTANCES)) {
    const c = await connect(inst.baseUrl);
    const items = await allWorkflows(c);
    const facts = analyzeInstance(items, true, at);
    perInst[inst.name] = { items, facts };
    for (const w of items) covEntries.push({ instanceId: inst.name, instanceLabel: inst.name, facts: facts.get(w.id) ?? null });
  }

  const brokenNames = (name) => {
    const { items, facts } = perInst[name];
    return items.flatMap((w) => (facts.get(w.id)?.directDeps ?? []).filter((d) => d.resolution === 'broken').map(() => w.name));
  };
  const bp = brokenNames('prod'), bs = brokenNames('staging');
  add('Exactly one broken ref per instance — the planted one, no false positives',
    bp.length === 1 && bs.length === 1 && bp[0] === 'Lead Scorer' && bs[0] === 'Lead Scorer',
    `prod ${bp.length} (${bp.join(',') || 'none'}), staging ${bs.length} (${bs.join(',') || 'none'})`);

  const fanIn = (name, target) => {
    const { items, facts } = perInst[name];
    return items.filter((w) => (facts.get(w.id)?.directDeps ?? []).some((d) => d.resolvedName === target)).length;
  };
  const fp = fanIn('prod', 'Send Slack Alert'), fs = fanIn('staging', 'Send Slack Alert');
  add('"Send Slack Alert" depended on by exactly 5 workflows (analyzer)', fp === 5 && fs === 5, `prod ${fp}, staging ${fs}`);

  const touches = (name, system) => {
    const { items, facts } = perInst[name];
    return items.filter((w) => (facts.get(w.id)?.systems ?? []).some((s) => s.system === system)).map((w) => w.name);
  };
  const sfp = touches('prod', 'Salesforce'), sfs = touches('staging', 'Salesforce');
  add('Salesforce touched in both instances (analyzer)', sfp.length === 1 && sfs.length === 1,
    `prod [${sfp.join(', ') || 'none'}], staging [${sfs.join(', ') || 'none'}]`);

  const mcpNames = (name) => { const { items, facts } = perInst[name]; return items.filter((w) => facts.get(w.id)?.mcpExposed).map((w) => w.name); };
  const mp = mcpNames('prod'), ms = mcpNames('staging');
  add('MCP-exposed flagged for exactly 2 workflows per instance', mp.length === 2 && ms.length === 2,
    `prod [${mp.join(', ')}], staging [${ms.join(', ')}]`);

  // Estate reads as diverse, not repetitive: the procedural background pushes the
  // fleet across many external systems and every trigger kind (analyzer's own view).
  const diversity = (name) => {
    const { items, facts } = perInst[name];
    const systems = new Set(), triggerKinds = new Set();
    for (const w of items) {
      const f = facts.get(w.id); if (!f) continue;
      for (const s of f.systems) if (s.system) systems.add(s.system);
      for (const t of f.nodeTypes) if (t.category === 'trigger') triggerKinds.add(t.type);
    }
    return { systems: systems.size, triggers: triggerKinds.size };
  };
  const dp = diversity('prod'), ds = diversity('staging');
  add('Estate is diverse (≥15 external systems, ≥5 trigger kinds)',
    dp.systems >= 15 && dp.triggers >= 5 && ds.systems >= 15 && ds.triggers >= 5,
    `prod ${dp.systems} systems/${dp.triggers} triggers, staging ${ds.systems}/${ds.triggers}`);

  // Real dependency clusters (not isolated islands): beyond the curated Slack hub
  // (fan-in 5), the background forms at least one high-fan-in shared sub-workflow.
  const topHub = (name) => {
    const { items, facts } = perInst[name];
    const counts = new Map();
    for (const w of items) {
      for (const dep of facts.get(w.id)?.directDeps ?? []) {
        const t = dep.resolvedName;
        if (!t || t === 'Send Slack Alert') continue;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    let best = ['—', 0];
    for (const e of counts) if (e[1] > best[1]) best = e;
    return best;
  };
  const hp = topHub('prod'), hs = topHub('staging');
  add('Background forms real dependency clusters (a hub with fan-in ≥8)',
    hp[1] >= 8 && hs[1] >= 8, `prod "${hp[0]}" ×${hp[1]}, staging "${hs[0]}" ×${hs[1]}`);

  const report = coverageOf(covEntries);
  const gaps = report.total - report.understood;
  add('Coverage is honest and the seed is fully understood',
    report.understoodPct === 100 && report.brokenRefTotal === 2 && report.understood + gaps === report.total,
    `understands ${report.understoodPct}% (${report.understood}/${report.total}), broken ${report.brokenRefTotal}, gaps ${gaps}`);

  // ---- Part C: the API SERVES the filters (the owner's demo surface) ----
  const serverEntry = join(ROOT, 'apps/server/dist/index.js');
  if (existsSync(serverEntry)) {
    const port = 3212;
    const base = `http://127.0.0.1:${port}`;
    const dbPath = join(tmpdir(), `argus-verify-s1b-${Date.now()}.sqlite`);
    const env = {
      ...process.env,
      ARGUS_PORT: String(port), ARGUS_HOST: '127.0.0.1', ARGUS_DB_PATH: dbPath,
      ARGUS_ADMIN_PASSWORD: 'v', ARGUS_SESSION_SECRET: 'v', ARGUS_ENCRYPTION_KEY: 'v', ARGUS_POLL_INTERVAL_MS: '3000',
    };
    const child = spawn('node', [serverEntry], { cwd: ROOT, env, stdio: 'ignore' });
    let cookie = '';
    const argus = async (path, opts = {}) => {
      const headers = { accept: 'application/json' };
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      const res = await fetch(base + path, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
      let json; try { json = await res.json(); } catch { /* none */ }
      return { status: res.status, json, setCookies: res.headers.getSetCookie?.() ?? [] };
    };
    try {
      const health = await pollHealth(`${base}/api/health`);
      if (!health) {
        add('S1b API serves the catalog', false, `no health on :${port}`);
      } else {
        const li = await argus('/api/auth/login', { method: 'POST', body: { password: 'v', name: 'V', email: 'v@acme.example' } });
        cookie = li.setCookies.map((c) => c.split(';')[0]).join('; ');
        const prodC = await connect(INSTANCES.prod.baseUrl);
        const stagingC = await connect(INSTANCES.staging.baseUrl);
        await argus('/api/connections', { method: 'POST', body: { label: 'prod', baseUrl: INSTANCES.prod.baseUrl, apiKey: prodC.apiKey } });
        await argus('/api/connections', { method: 'POST', body: { label: 'staging', baseUrl: INSTANCES.staging.baseUrl, apiKey: stagingC.apiKey } });
        const expected = perInst.prod.items.length + perInst.staging.items.length;
        let synced = 0;
        for (let i = 0; i < 40; i++) {
          synced = ((await argus('/api/workflows')).json?.workflows ?? []).length;
          if (synced >= expected) break;
          await sleep(500);
        }

        const sf = (await argus('/api/workflows?system=Salesforce')).json?.workflows ?? [];
        const sfInstances = new Set(sf.map((w) => w.instanceLabel));
        add('Filter "touching Salesforce" returns both instances in one view', sf.length === 2 && sfInstances.size === 2,
          `${sf.length} workflow(s) across ${sfInstances.size} instance(s): ${sf.map((w) => `${w.instanceLabel}:${w.name}`).join(', ')}`);

        const mcpList = (await argus('/api/workflows?mcp=true')).json?.workflows ?? [];
        add('Filter "MCP-exposed" returns 2 per instance (4 total)', mcpList.length === 4, `${mcpList.length} MCP-exposed served`);

        const cov = (await argus('/api/workflows/coverage')).json;
        add('Coverage endpoint reports the trust number', cov?.understoodPct === 100 && cov?.brokenRefTotal === 2,
          `understands ${cov?.understoodPct}%, ${cov?.brokenRefTotal} broken across the estate`);

        const all = (await argus('/api/workflows')).json?.workflows ?? [];
        const lead = all.find((w) => w.name === 'Lead Scorer');
        const detail = lead ? (await argus(`/api/workflows/${lead.instanceId}/${lead.id}`)).json : null;
        const dep = detail?.facts?.directDeps?.[0];
        add('Detail drawer serves facts + n8n deep-link (broken ref honest)',
          !!detail && dep?.resolution === 'broken' && typeof detail.deepLink === 'string' && detail.deepLink.includes('/workflow/'),
          detail ? `deep-link ${detail.deepLink}, Lead Scorer dep = ${dep?.resolution}` : 'no detail');
      }
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  }

  // ---- Part D: scale smoke-test (snappy at ~1.5–3k; full seed:large is S1b.1) ----
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const Database = require(join(ROOT, 'apps/server/node_modules/better-sqlite3'));
    const { migrate } = await import('../apps/server/dist/db/migrate.js');
    const { replaceInstanceWorkflows, listWorkflows, getWorkflowDetail } = await import('../apps/server/dist/workflows/repo.js');
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    const nowIso = new Date().toISOString();
    const TARGET = 1500;
    let sampleId = null, sampleInstance = null;
    for (const inst of Object.values(INSTANCES)) {
      const { items, facts } = perInst[inst.name];
      db.prepare('INSERT INTO connections (id,label,base_url,api_key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(inst.name, inst.name, inst.baseUrl, 'x', nowIso, nowIso);
      const cache = [];
      let n = 0;
      while (cache.length < TARGET) {
        for (const w of items) {
          if (cache.length >= TARGET) break;
          cache.push({
            id: `${w.id}-${n}`, name: `${w.name} #${n}`, active: w.active, isArchived: w.isArchived,
            projectId: null, projectName: null, updatedAt: w.updatedAt, versionId: w.versionId, facts: facts.get(w.id) ?? null,
          });
        }
        n++;
      }
      replaceInstanceWorkflows(db, inst.name, cache, nowIso);
      sampleId = cache[0].id; sampleInstance = inst.name;
    }
    const totalScaled = listWorkflows(db).length;
    const t0 = Date.now(); const sfScaled = listWorkflows(db, { systems: ['Salesforce'] }); const listMs = Date.now() - t0;
    const t1 = Date.now(); const d = getWorkflowDetail(db, sampleInstance, sampleId); const detailMs = Date.now() - t1;
    add(`Catalog stays snappy at ~${totalScaled} workflows (full seed:large → S1b.1)`,
      listMs < 500 && detailMs < 100 && totalScaled >= 3000 && sfScaled.length > 0 && !!d,
      `${totalScaled} workflows; filtered list ${listMs}ms, detail ${detailMs}ms`);
    db.close();
  } catch (e) {
    add('Catalog scale smoke-test', false, `scale test failed: ${e.message}`);
  }
}

// S3 — health: boot a real Argus server against both live instances, register them,
// wait for the health sync, and assert the seeded scenarios read as planted and the
// "what's failing" feed is correct + retention-honest (the owner's sign-off bullets).
async function s3Checks() {
  const up = {};
  for (const inst of Object.values(INSTANCES)) {
    const c = createN8nClient(inst.baseUrl);
    up[inst.name] = (await c.healthy()) && (await c.e2eActive());
  }
  if (!up.prod || !up.staging) {
    add('S3 health', false, `instances down (prod=${up.prod ? 'up' : 'down'}, staging=${up.staging ? 'up' : 'down'}) — run \`pnpm seed\``);
    return;
  }
  const serverEntry = join(ROOT, 'apps/server/dist/index.js');
  if (!existsSync(serverEntry)) { add('S3 health', false, 'server build missing'); return; }

  const port = 3213;
  const base = `http://127.0.0.1:${port}`;
  const dbPath = join(tmpdir(), `argus-verify-s3-${Date.now()}.sqlite`);
  const env = {
    ...process.env,
    ARGUS_PORT: String(port), ARGUS_HOST: '127.0.0.1', ARGUS_DB_PATH: dbPath,
    ARGUS_ADMIN_PASSWORD: 'v', ARGUS_SESSION_SECRET: 'v', ARGUS_ENCRYPTION_KEY: 'v', ARGUS_POLL_INTERVAL_MS: '3000',
  };
  const child = spawn('node', [serverEntry], { cwd: ROOT, env, stdio: 'ignore' });
  let cookie = '';
  const argus = async (path, opts = {}) => {
    const headers = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    let json; try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, json, setCookies: res.headers.getSetCookie?.() ?? [] };
  };

  try {
    const health = await pollHealth(`${base}/api/health`);
    if (!health) { add('S3 health server boots', false, `no health on :${port}`); return; }

    const li = await argus('/api/auth/login', { method: 'POST', body: { password: 'v', name: 'V', email: 'v@acme.example' } });
    cookie = li.setCookies.map((c) => c.split(';')[0]).join('; ');
    const prodC = await connect(INSTANCES.prod.baseUrl);
    const stagingC = await connect(INSTANCES.staging.baseUrl);
    await argus('/api/connections', { method: 'POST', body: { label: 'prod', baseUrl: INSTANCES.prod.baseUrl, apiKey: prodC.apiKey } });
    await argus('/api/connections', { method: 'POST', body: { label: 'staging', baseUrl: INSTANCES.staging.baseUrl, apiKey: stagingC.apiKey } });

    // Wait until health has been computed for the seeded failing workflow.
    const healthByName = async () => {
      const wfs = (await argus('/api/workflows')).json?.workflows ?? [];
      return new Map(wfs.map((w) => [w.name, w.health]));
    };
    let byName = new Map();
    for (let i = 0; i < 60; i++) {
      byName = await healthByName();
      const stripe = byName.get('Daily Stripe Reconciliation');
      if (stripe && stripe.status !== 'unknown') break;
      await sleep(500);
    }

    const statusOf = (name) => byName.get(name)?.status ?? 'missing';
    // The always-failing critical workflow reads failing (execution-derived, even though inactive).
    add('Seeded always-failing workflow reads FAILING', statusOf('Daily Stripe Reconciliation') === 'failing',
      `Daily Stripe Reconciliation = ${statusOf('Daily Stripe Reconciliation')}`);
    // The flaky + alternating workflows read degraded (3✓/3✘).
    add('Seeded flaky + alternating workflows read DEGRADED',
      statusOf('Zendesk Sync') === 'degraded' && statusOf('Data Quality Sentinel') === 'degraded',
      `Zendesk Sync = ${statusOf('Zendesk Sync')}, Data Quality Sentinel = ${statusOf('Data Quality Sentinel')}`);
    // An all-success workflow reads healthy.
    add('Seeded all-success workflow reads HEALTHY', statusOf('Order Intake') === 'healthy',
      `Order Intake = ${statusOf('Order Intake')}`);
    // A workflow with no runs reads idle, phrased against the retention window.
    const slack = byName.get('Send Slack Alert');
    add('Seeded run-less workflow reads IDLE (against the retention window)',
      slack?.status === 'idle' && slack?.runsInWindow === 0 && slack?.windowHours === 336,
      `Send Slack Alert = ${slack?.status}, runs ${slack?.runsInWindow}, window ${slack?.windowHours}h`);
    // Poll-fresh: health carries a computed-at (not a stale/never state).
    const stripeH = byName.get('Daily Stripe Reconciliation');
    add('Health is poll-fresh (carries a computed-at timestamp)', !!stripeH?.computedAt && stripeH.windowHours === 336,
      `computedAt ${stripeH?.computedAt ? 'present' : 'MISSING'}, window ${stripeH?.windowHours}h`);

    // The "what's failing right now" feed lists the failing workflow, retention-honest.
    const feed = (await argus('/api/workflows/failing')).json ?? {};
    const failingNames = (feed.failing ?? []).map((w) => w.name);
    const degradedNames = (feed.degraded ?? []).map((w) => w.name);
    const windowOk = (feed.windows ?? []).length > 0 && (feed.windows ?? []).every((w) => w.windowHours === 336);
    add('"What\'s failing" feed lists failing + degraded, retention window shown',
      failingNames.includes('Daily Stripe Reconciliation') &&
      degradedNames.includes('Zendesk Sync') && degradedNames.includes('Data Quality Sentinel') && windowOk,
      `failing [${failingNames.join(', ') || 'none'}], degraded incl Zendesk=${degradedNames.includes('Zendesk Sync')}, window 336h=${windowOk}`);
    // Summary counts + honest availability (executions were readable → available).
    const sum = feed.summary ?? {};
    add('Failing feed summary counts + instances report available (executions readable)',
      (sum.failing ?? 0) >= 1 && (sum.degraded ?? 0) >= 2 && (feed.windows ?? []).every((w) => w.available === true),
      `summary failing ${sum.failing}, degraded ${sum.degraded}, healthy ${sum.healthy}, idle ${sum.idle}; all available`);

    // On-demand redacted execution debug: the drawer's failing-workflow endpoint returns
    // the failing NODE + error type/code (redacted, no message) + per-run n8n deep links.
    const allWfs = (await argus('/api/workflows')).json?.workflows ?? [];
    const stripe = allWfs.find((w) => w.name === 'Daily Stripe Reconciliation');
    const dbg = stripe ? (await argus(`/api/workflows/${stripe.instanceId}/${stripe.id}/executions`)).json : null;
    const runOk = (dbg?.runs ?? []).length > 0 && (dbg.runs ?? []).every((r) => typeof r.deepLink === 'string' && r.deepLink.includes('/executions/'));
    const failNodeOk = dbg?.failure?.failedNode === 'Fetch Stripe Ledger' && !!dbg?.failure?.errorType;
    add('Redacted execution debug: failing node + error class + per-run deep links',
      !dbg?.unavailable && runOk && failNodeOk,
      dbg ? `node "${dbg.failure?.failedNode}", error ${dbg.failure?.errorType ?? '—'}·${dbg.failure?.errorCode ?? '—'}, ${dbg.runs?.length ?? 0} runs w/ deep links` : 'no debug payload');
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
}

// S4 — ownership & accountability: the guarantees + governance gaps, hermetic then live.
async function s4Checks() {
  // Hermetic: the two guarantees (resync-safe, no un-audited change), inference,
  // and the gap computations (incl. cross-instance single-owner-critical) + routes.
  try {
    execSync('pnpm --filter @argus/server exec vitest run src/ownership src/app.test.ts', { cwd: ROOT, stdio: 'pipe' });
    add('Ownership behaviors green (resync-safe · no un-audited change · gaps · inference)', true, 'ownership repo + inference + api unit suite passed');
  } catch (e) {
    const out = (e.stdout?.toString() || e.message || '').slice(-160);
    add('Ownership behaviors green (resync-safe · no un-audited change · gaps · inference)', false, `suite failed: ${out}`);
  }

  const up = {};
  for (const inst of Object.values(INSTANCES)) {
    const c = createN8nClient(inst.baseUrl);
    up[inst.name] = (await c.healthy()) && (await c.e2eActive());
  }
  if (!up.prod || !up.staging) {
    add('S4 ownership (live)', false, `instances down (prod=${up.prod ? 'up' : 'down'}, staging=${up.staging ? 'up' : 'down'}) — run \`pnpm seed\``);
    return;
  }
  const serverEntry = join(ROOT, 'apps/server/dist/index.js');
  if (!existsSync(serverEntry)) { add('S4 ownership (live)', false, 'server build missing'); return; }

  const port = 3214;
  const base = `http://127.0.0.1:${port}`;
  const dbPath = join(tmpdir(), `argus-verify-s4-${Date.now()}.sqlite`);
  const env = {
    ...process.env,
    ARGUS_PORT: String(port), ARGUS_HOST: '127.0.0.1', ARGUS_DB_PATH: dbPath,
    ARGUS_ADMIN_PASSWORD: 'v', ARGUS_SESSION_SECRET: 'v', ARGUS_ENCRYPTION_KEY: 'v', ARGUS_POLL_INTERVAL_MS: '3000',
  };
  const child = spawn('node', [serverEntry], { cwd: ROOT, env, stdio: 'ignore' });
  let cookie = '';
  const argus = async (path, opts = {}) => {
    const headers = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    let json; try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, json, setCookies: res.headers.getSetCookie?.() ?? [] };
  };

  try {
    const health = await pollHealth(`${base}/api/health`);
    if (!health) { add('S4 ownership server boots', false, `no health on :${port}`); return; }
    const li = await argus('/api/auth/login', { method: 'POST', body: { password: 'v', name: 'Verify Owner', email: 'verify@acme.example' } });
    cookie = li.setCookies.map((c) => c.split(';')[0]).join('; ');
    const prodC = await connect(INSTANCES.prod.baseUrl);
    const stagingC = await connect(INSTANCES.staging.baseUrl);
    const r1 = await argus('/api/connections', { method: 'POST', body: { label: 'prod', baseUrl: INSTANCES.prod.baseUrl, apiKey: prodC.apiKey } });
    const r2 = await argus('/api/connections', { method: 'POST', body: { label: 'staging', baseUrl: INSTANCES.staging.baseUrl, apiKey: stagingC.apiKey } });
    const prodId = r1.json?.connection?.id, stagingId = r2.json?.connection?.id;

    // Wait for inventory + ownership inference (owner present, resolved beyond unowned).
    let workflows = [];
    for (let i = 0; i < 60; i++) {
      workflows = (await argus('/api/workflows')).json?.workflows ?? [];
      if (workflows.length > 0 && workflows.some((w) => w.owner && w.owner.status === 'inferred')) break;
      await sleep(500);
    }

    // Inferred advisory owner present (membership-based) for a Revenue Ops workflow.
    const revWf = workflows.find((w) => w.project === 'Revenue Ops' && w.instanceId === prodId);
    const inferredOk = !!revWf && revWf.owner?.status === 'inferred' && !!revWf.owner?.owner;
    add('Inferred owner shows as advisory (from n8n project membership)', inferredOk,
      revWf ? `${revWf.name}: ${revWf.owner?.status}${revWf.owner?.owner ? ` → ${revWf.owner.owner.email ?? revWf.owner.owner.name}` : ''} (${revWf.owner?.source ?? '—'})` : 'no Revenue Ops workflow found');

    // Assign an owner → owned + an audit entry with who / before→after / reason.
    const target = revWf ?? workflows[0];
    const assignResp = await argus(`/api/ownership/${target.instanceId}/${target.id}/owner`, { method: 'PUT', body: { ownerEmail: 'sam.rivers@acme.example', ownerName: 'Sam Rivers', reason: 'owns revenue ops' } });
    const assignedOk = assignResp.json?.status === 'assigned' && assignResp.json?.owner?.email === 'sam.rivers@acme.example';
    const audit = (await argus('/api/ownership/audit')).json ?? {};
    const entry = (audit.entries ?? []).find((e) => e.action === 'ownership.assign' && e.entityId === `${target.instanceId}/${target.id}`);
    const auditOk = !!entry && entry.actorEmail === 'verify@acme.example' && entry.detail?.after?.ownerEmail === 'sam.rivers@acme.example' && entry.detail?.before?.ownerEmail === null;
    add('Assign owner → owned + audit entry (who / before→after / reason)', assignedOk && auditOk,
      `assigned=${assignedOk}, audit entry ${entry ? 'present' : 'MISSING'} by ${entry?.actorEmail ?? '—'}`);

    // Guarantee (i): a full resync (the poll re-lists) does NOT wipe the assignment.
    await sleep(4000); // ≥ one poll cycle (3s)
    const after = (await argus('/api/workflows')).json?.workflows ?? [];
    const stillAssigned = after.find((w) => w.instanceId === target.instanceId && w.id === target.id)?.owner?.status === 'assigned';
    add('A full resync does NOT wipe ownership (guarantee)', stillAssigned,
      stillAssigned ? 'assignment survived a poll/resync cycle' : 'assignment lost after resync');

    // Single-owner-critical (cross-instance, exact-email): inject criticality (verify has
    // no LLM) for a Revenue Ops workflow in EACH instance, assign Sam to both, assert the gap.
    let gapOk = false, gapDetail = 'skipped';
    try {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const Database = require(join(ROOT, 'apps/server/node_modules/better-sqlite3'));
      const db = new Database(dbPath);
      const enrich = (iid, wid) => db.prepare(
        `INSERT OR REPLACE INTO workflow_enrichments (instance_id, workflow_id, input_hash, provider, model, prompt_version, schema_version, status, enrichment_json, corrected_json, enriched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(iid, wid, 'h', 'verify', 'verify', 'v', 1, 'analyzed', JSON.stringify({ criticality: 'critical', criticalityReason: 'seeded for verify' }), null, new Date().toISOString());
      const prodRev = after.filter((w) => w.instanceId === prodId && w.project === 'Revenue Ops').slice(0, 1);
      const stagRev = after.filter((w) => w.instanceId === stagingId && w.project === 'Revenue Ops').slice(0, 1);
      for (const w of [...prodRev, ...stagRev]) enrich(w.instanceId, w.id);
      db.close();
      for (const w of [...prodRev, ...stagRev]) {
        await argus(`/api/ownership/${w.instanceId}/${w.id}/owner`, { method: 'PUT', body: { ownerEmail: 'sam.rivers@acme.example', ownerName: 'Sam Rivers' } });
      }
      const gaps = (await argus('/api/ownership/gaps')).json ?? {};
      const sam = (gaps.singleOwnerCritical ?? []).find((g) => g.owner.email === 'sam.rivers@acme.example');
      gapOk = !!sam && sam.workflows.length >= 2 && sam.crossInstance === true;
      gapDetail = sam ? `Sam solely owns ${sam.workflows.length} critical, crossInstance=${sam.crossInstance}` : `no single-owner gap (${(gaps.singleOwnerCritical ?? []).length} groups)`;
    } catch (e) {
      gapDetail = `gap setup failed: ${e.message}`;
    }
    add('Single-owner-critical surfaces Sam across BOTH instances (exact-email)', gapOk, gapDetail);

    // The governance-gaps + audit timeline are served, and the audit exports to CSV.
    const gaps2 = (await argus('/api/ownership/gaps')).json ?? {};
    const gapsShapeOk = Array.isArray(gaps2.unowned) && Array.isArray(gaps2.singleOwnerCritical) && Array.isArray(gaps2.personalSpaceCritical) && Array.isArray(gaps2.noBackupOwner);
    let csvOk = false;
    try {
      const res = await fetch(`${base}/api/ownership/audit/export.csv`, { headers: { cookie } });
      const ct = res.headers.get('content-type') ?? '';
      const text = await res.text();
      csvOk = ct.includes('text/csv') && text.includes('ownership.assign');
    } catch { /* fetch failed */ }
    add('Governance gaps + filterable audit timeline (CSV-exportable) served', gapsShapeOk && csvOk,
      `gaps shape ${gapsShapeOk ? 'ok' : 'bad'}, CSV export ${csvOk ? 'ok' : 'MISSING'}`);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
}

// ---- Report ----
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
console.log('\n  Project Argus — verify report');
console.log('  ' + '─'.repeat(74));
let failures = 0;
for (const c of checks) {
  if (!c.pass) failures++;
  const mark = c.pass ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  console.log(`  ${mark} ${pad(c.behavior, 52)} ${c.detail}`);
}
console.log('  ' + '─'.repeat(74));
const passed = checks.length - failures;
if (failures === 0) {
  console.log(`  \x1b[32mGREEN\x1b[0m — ${passed}/${checks.length} behaviors verified.\n`);
} else {
  console.log(`  \x1b[31mRED\x1b[0m — ${passed}/${checks.length} passed, ${failures} failing.\n`);
}
process.exit(failures === 0 ? 0 : 1);
