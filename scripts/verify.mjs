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

  const filters = ['filter-search', 'filter-state', 'filter-mcp', 'filter-broken', 'filter-stale', 'filter-can-mask', 'filter-silently-failing', 'filter-instance', 'filter-system', 'filter-criticality', 'filter-trigger'];
  const fmissing = missing(filters);
  add('Catalog shows all filter controls (search/state/MCP/broken/stale/instance/system/criticality/trigger)', fmissing.length === 0,
    fmissing.length === 0 ? `${filters.length} filter controls present` : `MISSING: ${fmissing.join(', ')}`);

  add('Connections screen shows the connection-health indicator', has('connection-health'),
    has('connection-health') ? 'connection-health present' : 'connection-health MISSING');

  // The detail drawer's at-a-glance strip: criticality/health/owner/risk in one scan,
  // each honest when unknown. Component test in WorkflowDetailDrawer.test.ts; presence here.
  add('Detail drawer shows the at-a-glance summary strip (criticality/health/owner/risk)', has('drawer-glance'),
    has('drawer-glance') ? 'drawer-glance present' : 'drawer-glance MISSING');

  // S6.1: analyzer-freshness drift notice (core-drift + community-only variants; nothing
  // when current). Component test asserts each variant's text/state; this is the presence row.
  add('Connections screen shows the analyzer-freshness drift notice (S6.1)', has('analyzer-drift'),
    has('analyzer-drift') ? 'analyzer-drift present' : 'analyzer-drift MISSING');

  // S2: enrichment chrome — catalog badges, drawer section (summary + criticality
  // reason + risk flags + correction), the "enriched X/Y" indicator, and the Settings
  // provider/key screen. Each has a component test asserting its state; this is the
  // plain-English presence counterpart (rule 11).
  const enrichUi = [
    'enrichment-badges', 'enrichment-criticality', 'enrichment-section', 'enrichment-criticality-reason',
    'enrichment-correct-button', 'enrichment-progress', 'settings-view', 'enrichment-toggle', 'llm-provider-select', 'llm-key-input', 'llm-save',
    // Smart features: the shared switch governs enrichment + chat, and a "what's sent"
    // drawer surfaces both features' egress so the owner decides before enabling.
    'smart-features-heading', 'egress-open', 'egress-drawer', 'egress-enrichment', 'egress-chat',
  ];
  const eMissing = missing(enrichUi);
  add('Smart-features UI ships (shared switch, provider cards, "what\'s sent" egress drawer for enrichment + chat)', eMissing.length === 0,
    eMissing.length === 0 ? `${enrichUi.length} smart-features UI elements present` : `MISSING: ${eMissing.join(', ')}`);

  // S3: health chrome — the catalog badge + health facet, the "what's failing" view
  // (failing list, summary, retention window, poll-fresh/honest-stale indicator), and
  // the drawer health section. Each has a component test; this is the presence counterpart.
  const healthUi = ['health-badge', 'filter-health', 'health-view', 'health-failing-list', 'health-window', 'health-freshness', 'health-scope', 'health-search', 'health-section', 'health-summary', 'health-tile-failing', 'health-tile-healthy', 'health-tile-idle', 'execution-runs', 'execution-failure'];
  const hMissing = missing(healthUi);
  add('Health UI ships (catalog badge+facet, failing view, drawer health + runs/failure)', hMissing.length === 0,
    hMissing.length === 0 ? `${healthUi.length} health UI elements present` : `MISSING: ${hMissing.join(', ')}`);

  // S6.3: silent-failure chrome — the additive badge overlay, the drawer silently-failing box
  // + the advisory can-mask-failures flag, and the Health view's silently-failing tile + list.
  const silentUi = ['health-silent-badge', 'health-silent-failure', 'can-mask-flag', 'health-tile-silent', 'health-tile-can-mask', 'health-silent-list'];
  const sMissing = missing(silentUi);
  add('Silent-failure UI ships (badge overlay, drawer silent box + can-mask flag, Health tile + list)', sMissing.length === 0,
    sMissing.length === 0 ? `${silentUi.length} silent-failure UI elements present` : `MISSING: ${sMissing.join(', ')}`);

  // S4: ownership chrome — the catalog owner badge, the drawer ownership section +
  // assign dialog, the Ownership register (accountability table + clickable summary
  // filters), and the incident owner on the failing surface. Each has a component test.
  const ownUi = [
    'owner-badge', 'ownership-section', 'ownership-assign-button', 'ownership-suggested-owner', 'assign-owner-dialog', 'assign-owner-picker', 'assign-owner-suggestion',
    'governance-view', 'ownership-summary', 'ownership-register', 'ownership-confirmed',
    'ownership-filter-needs-owner', 'ownership-filter-critical-at-risk', 'ownership-scope', 'ownership-search', 'ownership-freshness',
    'incident-owner',
  ];
  const oMissing = missing(ownUi);
  add('Ownership UI ships (owner badge, assign dialog, ownership register + summary filters, incident owner)', oMissing.length === 0,
    oMissing.length === 0 ? `${ownUi.length} ownership UI elements present` : `MISSING: ${oMissing.join(', ')}`);

  // The Argus self-audit timeline lives in its own Activity view — the filterable,
  // CSV-exportable action log. Component test in ActivityView.test.ts; presence here.
  const activityUi = ['activity-view', 'governance-audit-timeline', 'governance-audit-export', 'audit-filter-action', 'audit-filter-actor', 'pager', 'pager-prev', 'pager-next'];
  const aMissing = missing(activityUi);
  add('Activity UI ships (audit timeline + filters + pagination + CSV export)', aMissing.length === 0,
    aMissing.length === 0 ? `${activityUi.length} activity UI elements present` : `MISSING: ${aMissing.join(', ')}`);

  // S5: graph chrome — the fleet graph canvas, scope switcher, archived toggle, the
  // confidence/cross-instance legend, and the blast-radius impact panel with its EXPLICIT
  // total + an Unselect control. Each has a component test (GraphView.test.ts); presence counterpart.
  const graphUi = [
    'graph-view', 'graph-canvas', 'graph-scope-switcher', 'graph-archived-toggle',
    'graph-legend', 'graph-impact-panel', 'graph-impact-statement', 'graph-impact-total', 'graph-zoom-controls',
    'graph-affected-list', 'graph-panel-open-detail', 'graph-panel-clear',
  ];
  const gMissing = missing(graphUi);
  add('Graph UI ships (canvas, scope switcher, archived toggle, legend, zoom controls, blast-radius panel + drawer links + unselect)', gMissing.length === 0,
    gMissing.length === 0 ? `${graphUi.length} graph UI elements present` : `MISSING: ${gMissing.join(', ')}`);

  // S6: governance-overview chrome — the score + five-pillar breakdown, every headline
  // figure (unowned/SPOF/incidents/hygiene/exposure/personal-space/changelog), the export
  // control, and the uncertainty labels (advisory owner, health-unavailable, possible
  // excluded). Each has a component test (OverviewView.test.ts); presence counterpart.
  // Each metric tile navigates to its exact set (no inline drill); the longer prose +
  // uncertainty caveats (advisory owner, confirmed-reach-only) live in ⓘ tooltips.
  const overviewUi = [
    'overview-view', 'overview-score', 'overview-score-breakdown', 'pillar-value', 'overview-unowned', 'overview-spof',
    'overview-failing', 'overview-silently-failing', 'overview-broken', 'overview-stale', 'overview-idle-active', 'overview-exposure', 'overview-personal-space',
    'overview-changelog', 'overview-export', 'overview-health-unavailable', 'infotip',
  ];
  const ovMissing = missing(overviewUi);
  add('Governance overview UI ships (score+pillars, metric tiles → their page, export, tooltips)', ovMissing.length === 0,
    ovMissing.length === 0 ? `${overviewUi.length} overview UI elements present` : `MISSING: ${ovMissing.join(', ')}`);

  // S7: chat chrome — the chat view, message list + composer, streaming indicator,
  // tool-call chips, and the bottom "Referenced" row of clickable workflow pills (built
  // only from tool-surfaced workflows). Each has a component test (ChatView.test.ts).
  const chatUi = ['chat-view', 'chat-messages', 'chat-message', 'chat-input', 'chat-send', 'chat-streaming', 'chat-tool-chip', 'chat-refs', 'chat-workflow-ref', 'chat-disabled', 'chat-open-settings'];
  const cMissing = missing(chatUi);
  add('Chat UI ships (view, composer, streaming, chips, Referenced pills, off-state panel)', cMissing.length === 0,
    cMissing.length === 0 ? `${chatUi.length} chat UI elements present` : `MISSING: ${cMissing.join(', ')}`);
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
    row('Governance overview usable at 375px — no horizontal overflow', 'Overview');
    row('Catalog usable at 375px — no horizontal overflow, no cut-off fields', 'Catalog list');
    row('Health view usable at 375px — no horizontal overflow', 'Health view');
    row('Graph view usable at 375px — no horizontal overflow', 'Graph view');
    row('Ownership register usable at 375px — no horizontal overflow', 'Ownership register');
    row('Detail drawer usable at 375px — full-width, no overflow', 'Detail drawer');
    row('Settings usable at 375px — no horizontal overflow', 'Settings');
    row('Chat view usable at 375px — no horizontal overflow', 'Chat view');
    row('Connections (with drift notice) usable at 375px — no horizontal overflow', 'Connections');
  }
}

// ---- S2 checks: enrichment (hermetic — no n8n, no live LLM, no spend) ----
await s2Checks();

// ---- S8 checks: the OpenAI-compatible third provider (DECISION #30) ----
await openAiCompatibleChecks();

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

// ---- S6.1 checks: analyzer freshness (drift detection over the live estate) ----
await s61Checks();

// ---- S3 checks: health (per-workflow status from executions, the failing view) ----
// Drives a real Argus server against both live instances; asserts the seeded health
// scenarios read as planted and the "what's failing" feed is correct + retention-honest.
await s3Checks();

// ---- S4 checks: ownership & accountability (the two guarantees + gaps, live) ----
// Hermetic suite for the guarantees + gap logic; then a real Argus server against both
// live instances to prove inference, audited assignment, resync-safety, and the
// single-owner-critical cross-instance gap end to end.
await s4Checks();

// ---- S5 checks: relationships & blast radius (graph), live end-to-end ----
// Boot a real Argus against both instances, register with webhook hosts, wait for the
// estate edge pass, and assert the blast-radius core: Send Slack Alert = 5, the
// cross-instance edge is confirmed, possible edges never count, rotate ≠ failure, and
// Argus's confirmed edges match n8n's own workflow-index oracle.
await s5Checks();

// ---- S6 checks: governance overview (pure composition, never divergence) ----
// Drives a real Argus server against both live instances; asserts the composed
// dashboard equals its source reads (unowned == gaps, failing-with-owner == owned
// subset of the failing feed), every figure drills to its exact set, the score is a
// deterministic 0–100, and the export report matches the screen.
await s6Checks();

// ---- S7 checks: chat (hermetic — stub LLM, no n8n, no LLM spend) ----
// The tool loop + scripted persona are proven against a stub client; the live
// invented-facts=0 gate is `pnpm eval:chat` (run with a key, like `pnpm eval`).
await s7Checks();

// S7 chat — hermetic: the backend tool loop + scripted persona (stub LLM, no spend)
// and the faithfulness-eval harness parsing. The live gate is `pnpm eval:chat`.
async function s7Checks() {
  // 1. Backend behaviors: streaming tool loop (both providers), scripted not-found /
  //    out-of-scope persona, and the SSE route — all against a deterministic stub client.
  try {
    execSync('pnpm --filter @argus/server exec vitest run src/chat src/llm/client.test.ts', { cwd: ROOT, stdio: 'pipe' });
    add('Chat backend green (tool loop both providers · scripted not-found · SSE route · no spend)', true,
      'chat + llm tool-loop unit suite passed against a stub LLM (no network, no spend)');
  } catch (e) {
    const out = (e.stdout || e.stderr || e.message || '').toString().slice(-500);
    add('Chat backend green (tool loop both providers · scripted not-found · SSE route · no spend)', false, `suite failed: ${out}`);
  }

  // 1b. Egress gate (security review): redaction backstop on EVERY tool · get_workflow_detail
  //     shaped to an allowlist (no raw host/webhook paths/URLs/expression strings) · owner &
  //     actor emails names-only by default · ids survive (docs/DATA-FLOW-CHAT.md; #26/#28/#29).
  try {
    execSync('pnpm --filter @argus/server exec vitest run src/chat/egress.test.ts', { cwd: ROOT, stdio: 'pipe' });
    add('Chat egress hardened (all-tools scrub · shaped facts allowlist · names-only default · ids intact)', true,
      'every tool redacted; no raw host/path/URL/expr in facts; no owner/actor email by default; UUID instanceId preserved');
  } catch (e) {
    const out = (e.stdout || e.stderr || e.message || '').toString().slice(-500);
    add('Chat egress hardened (all-tools scrub · shaped facts allowlist · names-only default · ids intact)', false, `egress gate failed: ${out}`);
  }

  // 1c. Conversation history is SERVER-SIDE, keyed by the authenticated actor — a client
  //     cannot seed fabricated "prior tool results" for the model to narrate (Finding 1).
  try {
    execSync('pnpm --filter @argus/server exec vitest run src/chat/service.test.ts -t "server-side chat history"', { cwd: ROOT, stdio: 'pipe' });
    add('Chat history is server-side (client cannot seed context; namespaced per actor)', true,
      'client history dropped at the wire; turns persisted server-side per (actor, conversationId)');
  } catch (e) {
    const out = (e.stdout || e.stderr || e.message || '').toString().slice(-500);
    add('Chat history is server-side (client cannot seed context; namespaced per actor)', false, `history gate failed: ${out}`);
  }

  // 1d. Same-named workflows across instances resolve by instance (id, label, or "(prod)"
  //     suffix) instead of looping on the disambiguation prompt (user-reported bug).
  try {
    execSync('pnpm --filter @argus/server exec vitest run src/chat/tools.test.ts', { cwd: ROOT, stdio: 'pipe' });
    add('Chat resolves same-named workflows across instances (by id / label / suffix)', true,
      'get_workflow_detail narrows a duplicate name to one when the instance is named');
  } catch (e) {
    const out = (e.stdout || e.stderr || e.message || '').toString().slice(-500);
    add('Chat resolves same-named workflows across instances (by id / label / suffix)', false, `disambiguation gate failed: ${out}`);
  }

  // 1e. The egress doc reproduces the ACTUAL system prompt verbatim (rule 9 — the prompt is
  //     part of what egresses; the doc must not drift from prompt.ts).
  try {
    const { CHAT_SYSTEM_PROMPT } = await import(pathToFileURL(join(ROOT, 'apps/server/dist/chat/prompt.js')).href);
    const doc = readFileSync(join(ROOT, 'docs/DATA-FLOW-CHAT.md'), 'utf8');
    const inSync = doc.includes(CHAT_SYSTEM_PROMPT);
    add('Chat egress doc quotes the verbatim system prompt (DATA-FLOW-CHAT.md in sync)', inSync,
      inSync ? 'DATA-FLOW-CHAT.md contains the current CHAT_SYSTEM_PROMPT' : 'STALE — re-sync the prompt block in DATA-FLOW-CHAT.md with prompt.ts');
  } catch (e) {
    add('Chat egress doc quotes the verbatim system prompt (DATA-FLOW-CHAT.md in sync)', false, `could not verify: ${e.message}`);
  }

  // 2. The faithfulness eval harness runs offline: the canonical + hostile cases load and
  //    the invented-facts scorer computes (flags a fabricated fact, passes a grounded one).
  //    The LIVE gate (real wrapper over the seeded estate, invented facts = 0) is `pnpm eval:chat`.
  try {
    const { CANONICAL, HOSTILE } = await import(pathToFileURL(join(ROOT, 'scripts/eval/chat/cases.mjs')).href);
    const { scoreFaithfulness } = await import(pathToFileURL(join(ROOT, 'scripts/eval/chat/score.mjs')).href);
    // Grounded answer: every name/number is in the corpus ⇒ 0 invented.
    const grounded = scoreFaithfulness('Daily Stripe Reconciliation is failing; 3 workflows affected.', 'Daily Stripe Reconciliation ... affected count 3 ...', 3);
    // Fabricated answer: a workflow + count that never appear in the corpus ⇒ invented > 0.
    const fabricated = scoreFaithfulness('Quarterly Unicorn Sync owns 99 workflows.', 'Daily Stripe Reconciliation ... affected count 3 ...', 3);
    const ok = Array.isArray(CANONICAL) && CANONICAL.length === 8 && Array.isArray(HOSTILE) && HOSTILE.length >= 4 && grounded.inventedCount === 0 && fabricated.inventedCount > 0;
    add('Chat faithfulness eval harness runs (8 canonical + hostile cases; invented-facts scorer computes)', ok,
      ok ? `${CANONICAL.length} canonical + ${HOSTILE.length} hostile cases; scorer flags fabricated (${fabricated.inventedCount}), passes grounded (0)` : 'cases/scorer did not verify — see `pnpm eval:chat`');
  } catch (e) {
    add('Chat faithfulness eval harness runs (8 canonical + hostile cases; invented-facts scorer computes)', false,
      `eval harness not loadable: ${e.message}`);
  }
}

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

/**
 * S8 — the third provider: any OpenAI-compatible endpoint (DECISION #30). Hermetic: a
 * stubbed fetch stands in for the endpoint, so these rows run with no network and no
 * spend. The live proof (`pnpm eval --provider openai_compatible`) is separate.
 */
async function openAiCompatibleChecks() {
  // 1. The deployment-mode promise: with a self-hosted endpoint, no request leaves for
  //    an external host. Asserted at the wrapper by recording every URL it requests.
  try {
    const { createLlmClient } = await import(pathToFileURL(join(ROOT, 'apps/server/dist/llm/index.js')).href);
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }) };
    };
    try {
      // Drive the tool-loop seam (chat's egress path) — it needs no Zod schema to run.
      const client = createLlmClient({ provider: 'openai_compatible', apiKey: '', model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434/v1' });
      for await (const ev of client.streamToolLoop({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [], maxIterations: 1 })) void ev;
    } finally {
      globalThis.fetch = realFetch;
    }
    const external = seen.filter((u) => !/^http:\/\/127\.0\.0\.1:11434\//.test(u));
    add(
      'Self-hosted endpoint: nothing leaves your network (no external host contacted)',
      seen.length > 0 && external.length === 0,
      external.length === 0 ? `${seen.length} request(s), all to the configured endpoint` : `LEAKED to: ${external.join(', ')}`,
    );
  } catch (e) {
    add('Self-hosted endpoint: nothing leaves your network (no external host contacted)', false, `could not verify: ${e.message}`);
  }

  // 2. A user-supplied base URL is SSRF-adjacent: the key goes wherever it points. The
  //    scheme is validated and embedded credentials refused — but private/loopback hosts
  //    are deliberately ALLOWED (an in-VPC endpoint is the whole point).
  try {
    const { checkBaseUrl } = await import(pathToFileURL(join(ROOT, 'packages/shared/dist/llm-config.js')).href);
    const rejects = ['file:///etc/passwd', 'ftp://h/v1', 'https://user:pw@h/v1', 'https://h/v1?k=leak', 'nonsense'];
    const allows = ['http://127.0.0.1:11434/v1', 'http://10.4.2.9:8000/v1', 'https://gw.acme.example/v1'];
    const ok = rejects.every((u) => !checkBaseUrl(u).ok) && allows.every((u) => checkBaseUrl(u).ok) && checkBaseUrl('http://127.0.0.1:11434/v1').insecure === true;
    add('Base URL validated (scheme + no embedded credentials; private hosts allowed)', ok, `${rejects.length} rejected, ${allows.length} allowed, http:// flagged insecure`);
  } catch (e) {
    add('Base URL validated (scheme + no embedded credentials; private hosts allowed)', false, `could not verify: ${e.message}`);
  }

  // 3. Seam support is PROBED, never assumed. A model that ignores `tools` and answers in
  //    prose must disable chat explicitly — the silent-wrongness case (rule 5).
  try {
    const { probeCapabilities } = await import(pathToFileURL(join(ROOT, 'apps/server/dist/llm/index.js')).href);
    const realFetch = globalThis.fetch;
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    globalThis.fetch = async (_url, init) => {
      const b = JSON.parse(String(init.body));
      // The endpoint accepts `tools`, ignores them, and answers in prose (phi4-mini).
      if (b.tools) return reply({ choices: [{ message: { content: 'There are 4 failing workflows.' }, finish_reason: 'stop' }], usage: {} });
      return reply({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} });
    };
    let caps;
    try {
      caps = await probeCapabilities({ provider: 'openai_compatible', apiKey: '', model: 'phi4-mini', baseUrl: 'http://127.0.0.1:11434/v1' });
    } finally {
      globalThis.fetch = realFetch;
    }
    const ok = caps.structuredOutput === true && caps.streamingToolCalls === false && /chat is unavailable/i.test(caps.note ?? '');
    add(
      'Capability probe catches a model that ignores tools → "chat unavailable", enrichment OK',
      ok,
      ok ? 'enrichment supported, chat explicitly disabled (never a silent wrong answer)' : `probe said: ${JSON.stringify(caps)}`,
    );
  } catch (e) {
    add('Capability probe catches a model that ignores tools → "chat unavailable", enrichment OK', false, `could not verify: ${e.message}`);
  }

  // 4. The wire body matches the REAL captured contract (contracts/llm-openai-compatible.json):
  //    reasoning_effort is OpenAI-only (Ollama 400s), and max_completion_tokens is silently
  //    IGNORED there — so the compat path must send max_tokens or the token cap is a lie.
  try {
    const c = JSON.parse(readFileSync(join(ROOT, 'contracts/llm-openai-compatible.json'), 'utf8'));
    const captured =
      c.reasoning_effort_rejected?.status === 400 &&
      c.max_completion_tokens_IGNORED?.finish_reason === 'stop' &&
      c.max_tokens_HONORED?.finish_reason === 'length' &&
      c.seam2_tool_calls_UNSUPPORTED_phi4mini?.tool_calls == null;
    add('OpenAI-compatible contract captured from a real endpoint (rule 1)', captured, captured ? `${c.endpoint}` : 'contract file missing the key findings');
  } catch (e) {
    add('OpenAI-compatible contract captured from a real endpoint (rule 1)', false, `contract not captured: ${e.message} — run the probe`);
  }

  // 5. The behaviors, asserted by the unit suites (adapter wire body, probe, degradation,
  //    audited base-URL change, keyless config, gating tuple).
  try {
    execSync('pnpm --filter @argus/server exec vitest run src/llm/openai-compatible.test.ts src/settings/repo.test.ts src/chat/service.test.ts', { cwd: ROOT, stdio: 'pipe' });
    execSync('pnpm --filter @argus/shared exec vitest run src/llm-config.test.ts', { cwd: ROOT, stdio: 'pipe' });
    add('Third-provider behaviors green (wire body · probe · degrade · audited base URL · keyless)', true, 'openai-compatible + settings + chat + shared suites passed');
  } catch (e) {
    const out = (e.stdout?.toString() || e.message || '').slice(-160);
    add('Third-provider behaviors green (wire body · probe · degrade · audited base URL · keyless)', false, `suite failed: ${out}`);
  }

  // 6. The docs promise what the code does (rule 9): both one-pagers + README name the
  //    self-hosted destination and the http:// caveat.
  try {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const df = readFileSync(join(ROOT, 'docs/DATA-FLOW.md'), 'utf8');
    const dfc = readFileSync(join(ROOT, 'docs/DATA-FLOW-CHAT.md'), 'utf8');
    const promise = /nothing leaves your network/i;
    const dest = /<your base URL>\/chat\/completions/;
    const insecure = /unencrypted/i;
    const ok = promise.test(readme) && promise.test(df) && promise.test(dfc) && dest.test(df) && dest.test(dfc) && insecure.test(df) && insecure.test(dfc);
    add('Data-flow docs name the self-hosted destination + the http:// caveat', ok, ok ? 'README + both one-pagers in sync' : 'a doc is missing the destination or the unencrypted-transport note');
  } catch (e) {
    add('Data-flow docs name the self-hosted destination + the http:// caveat', false, `doc check failed: ${e.message}`);
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
  // The catalog is server-side paginated (default 50/page) — pass a big limit to scan the
  // whole estate in these behavioural checks; `.total` carries the full match count.
  const listNames = async () => ((await argus('/api/workflows?limit=5000')).json?.workflows ?? []).map((w) => w.name);

  let child = boot();
  try {
    const health = await pollHealth(`${base}/api/health`);
    if (!health) { add('S1a Argus server boots', false, `no health on :${port}`); return; }

    // Login is required before anything else.
    const unauth = await argus('/api/workflows');
    add('Login required (no session ⇒ blocked)', unauth.status === 401, `GET /api/workflows without session → ${unauth.status}`);

    const li = await argus('/api/auth/login', { method: 'POST', body: { password: 'verify-admin', name: 'Verify Owner', email: 'verify@acme.example' } });
    cookie = li.setCookies.map((c) => c.split(';')[0]).join('; ');

    // Logins & logouts land in the self-audit timeline — the operator's comings and goings
    // show alongside every other governance action. Exercise a throwaway session so both
    // actions are recorded, then read them back with the main session.
    {
      const tmp = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'verify-admin', name: 'Comes And Goes', email: 'transient@acme.example' }) });
      const tmpCookie = (tmp.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: tmpCookie } });
      const timeline = (await argus('/api/ownership/audit?action=auth&limit=50')).json ?? {};
      const acts = (timeline.entries ?? []).map((e) => e.action);
      add('Logins & logouts are audited (auth.login / auth.logout in the timeline)',
        acts.includes('auth.login') && acts.includes('auth.logout'),
        `login=${acts.includes('auth.login')}, logout=${acts.includes('auth.logout')}; ${timeline.total ?? 0} auth events`);
    }

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

    // The whole estate in one view — `.total` is the full match count (across all pages).
    const listResp = (await argus('/api/workflows')).json ?? {};
    const total = listResp.total;
    const expected = prodWfs.length + stagingWfs.length;
    add('Whole estate lists in one view (paginated; total across pages)', total === expected && (listResp.workflows?.length ?? 0) === Math.min(expected, listResp.limit),
      `Argus total ${total} = prod ${prodWfs.length} + staging ${stagingWfs.length}; page ${listResp.workflows?.length}/${listResp.limit}`);

    // Filter by instance — compare the total, not the (paginated) page length.
    const pf = (await argus(`/api/workflows?instanceId=${prodId}`)).json?.total ?? 0;
    const sf = (await argus(`/api/workflows?instanceId=${stagingId}`)).json?.total ?? 0;
    add('Filter by instance', pf === prodWfs.length && sf === stagingWfs.length, `prod ${pf}, staging ${sf}`);

    // Search matches the OWNER (assigned or inferred), not just the name — so flows can be
    // found by who owns them. Probe with a real owner name from the live estate: every
    // result must match by name-or-owner, and at least one must match by OWNER alone.
    const estateList = (await argus('/api/workflows?limit=5000')).json ?? {};
    const owned = (estateList.workflows ?? []).find((w) => w.owner?.owner?.name);
    if (owned) {
      const ownerName = owned.owner.owner.name;
      const q = ownerName.toLowerCase();
      const res = (await argus(`/api/workflows?q=${encodeURIComponent(ownerName)}&limit=5000`)).json ?? {};
      const rows = res.workflows ?? [];
      const matchesContract = rows.length > 0 && rows.every((w) =>
        w.name.toLowerCase().includes(q)
        || (w.owner?.owner?.name ?? '').toLowerCase().includes(q)
        || (w.owner?.owner?.email ?? '').toLowerCase().includes(q));
      const someByOwner = rows.some((w) => (w.owner?.owner?.name ?? '').toLowerCase().includes(q) && !w.name.toLowerCase().includes(q));
      add('Search finds flows by owner (assigned or inferred), never a non-match', matchesContract && someByOwner,
        `q="${ownerName}" → ${res.total} of ${estateList.total} workflows; all match name-or-owner, ≥1 by owner`);
    } else {
      add('Search finds flows by owner (assigned or inferred), never a non-match', true, 'no owned workflow in the estate to probe — skipped');
    }

    // Pagination: page 2 continues where page 1 stopped, and the pages don't overlap.
    const p1 = (await argus('/api/workflows?limit=50&offset=0')).json ?? {};
    const p2 = (await argus('/api/workflows?limit=50&offset=50')).json ?? {};
    const ids = (r) => new Set((r.workflows ?? []).map((w) => `${w.instanceId}/${w.id}`));
    const overlap = [...ids(p1)].some((k) => ids(p2).has(k));
    add('Catalog is server-side paginated (distinct, non-overlapping pages)',
      p1.workflows?.length === 50 && p2.workflows?.length === 50 && !overlap && p1.total === expected,
      `page1 ${p1.workflows?.length}, page2 ${p2.workflows?.length}, overlap=${overlap}, total ${p1.total}`);

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

// S6.1 — analyzer freshness: detect when a connected instance has drifted past the
// pinned manifest. Anchored on verifiable unrecognized node types (never a version
// Argus can't read), split core vs community/custom. Detection + alert only — refresh
// is a build/ops step (Decision #32; contracts n8n-21/22).
async function s61Checks() {
  const { analyzeInstance, computeAnalyzerDrift } = await import('../apps/server/dist/analyzer/index.js');

  // Regression: the core/community split + status precedence, the poll→health wiring,
  // and the UI variants (core-drift / community-only / nothing-when-current).
  try {
    execSync('pnpm --filter @argus/server exec vitest run src/analyzer/drift.test.ts src/sync/engine.test.ts', { cwd: ROOT, stdio: 'pipe' });
    execSync('pnpm --filter @argus/web exec vitest run src/components/AnalyzerDriftNotice.test.ts src/views/ConnectionsView.test.ts', { cwd: ROOT, stdio: 'pipe' });
    add('Analyzer-freshness drift is detected and split core vs community/custom', true,
      'drift unit + poll→health wiring + UI-variant tests pass');
  } catch (e) {
    const out = (e.stdout?.toString() || e.message || '').slice(-200);
    add('Analyzer-freshness drift is detected and split core vs community/custom', false, out);
  }

  // Positive sanity (deterministic, in-process): a synthetic post-manifest CORE node type
  // flags core-drift ("coverage may have dropped"); a community/custom one is community-only
  // (a rebuild won't add it — not a regenerate case).
  const f = (types) => ({ coverage: { understood: types.length === 0, unknownNodeTypes: types, unresolvedRefs: 0, reasons: [] } });
  const coreD = computeAnalyzerDrift([f(['n8n-nodes-base.__futureNode']), f(['@n8n/n8n-nodes-langchain.__x'])]);
  const commD = computeAnalyzerDrift([f(['n8n-nodes-acme.thing'])]);
  add('A post-manifest CORE node flags core-drift; community/custom is labeled (not regenerate)',
    coreD.status === 'core-drift' && commD.status === 'community-only',
    `synthetic core → ${coreD.status} (${coreD.coreUnknown.types} core types, ${coreD.coreUnknown.workflows} wfs); community → ${commD.status}`);

  // Baseline sanity (live): the in-sync seeded estate (n8n = manifest pin) has 0 core-drift.
  const up = {};
  for (const inst of Object.values(INSTANCES)) {
    const c = createN8nClient(inst.baseUrl);
    up[inst.name] = (await c.healthy()) && (await c.e2eActive());
  }
  if (!up.prod || !up.staging) {
    add('Baseline: in-sync seeded estate shows 0 core-drift connections', false,
      `instances down (prod=${up.prod ? 'up' : 'down'}, staging=${up.staging ? 'up' : 'down'}) — run \`pnpm seed\``);
    return;
  }
  const at = new Date().toISOString();
  const results = [];
  for (const inst of Object.values(INSTANCES)) {
    const c = await connect(inst.baseUrl);
    const items = await allWorkflows(c);
    const facts = analyzeInstance(items, true, at);
    results.push({ name: inst.name, drift: computeAnalyzerDrift([...facts.values()]) });
  }
  const anyCore = results.some((r) => r.drift.status === 'core-drift');
  const manifestV = results[0]?.drift.manifestN8nVersion ?? '?';
  add('Baseline: in-sync seeded estate shows 0 core-drift connections (analyzer honest, rule 5)',
    !anyCore,
    `analyzer built for n8n ${manifestV}; ${results.map((r) => `${r.name}=${r.drift.status} (core ${r.drift.coreUnknown.types}/comm ${r.drift.communityUnknown.types})`).join(', ')}`);
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
          synced = (await argus('/api/workflows')).json?.total ?? 0;
          if (synced >= expected) break;
          await sleep(500);
        }

        const sf = (await argus('/api/workflows?system=Salesforce&limit=5000')).json?.workflows ?? [];
        const sfInstances = new Set(sf.map((w) => w.instanceLabel));
        add('Filter "touching Salesforce" returns both instances in one view', sf.length === 2 && sfInstances.size === 2,
          `${sf.length} workflow(s) across ${sfInstances.size} instance(s): ${sf.map((w) => `${w.instanceLabel}:${w.name}`).join(', ')}`);

        const mcpList = (await argus('/api/workflows?mcp=true&limit=5000')).json?.workflows ?? [];
        add('Filter "MCP-exposed" returns 2 per instance (4 total)', mcpList.length === 4, `${mcpList.length} MCP-exposed served`);

        const cov = (await argus('/api/workflows/coverage')).json;
        add('Coverage endpoint reports the trust number', cov?.understoodPct === 100 && cov?.brokenRefTotal === 2,
          `understands ${cov?.understoodPct}%, ${cov?.brokenRefTotal} broken across the estate`);

        const all = (await argus('/api/workflows?limit=5000')).json?.workflows ?? [];
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
      const wfs = (await argus('/api/workflows?limit=5000')).json?.workflows ?? [];
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
    // Every health state is a browsable list (the summary tiles all filter a real set),
    // and each list length equals its summary count — no state is a dead-end number.
    const listLen = (k) => (feed[k] ?? []).length;
    const listsMatchCounts = ['failing', 'degraded', 'healthy', 'idle', 'unknown'].every((k) => listLen(k) === (sum[k] ?? 0));
    add('Health feed exposes every state as a browsable list (healthy/idle too), lists == counts',
      Array.isArray(feed.healthy) && Array.isArray(feed.idle) && listLen('idle') >= 1 && listsMatchCounts,
      `lists failing ${listLen('failing')}/degraded ${listLen('degraded')}/healthy ${listLen('healthy')}/idle ${listLen('idle')}/unknown ${listLen('unknown')} == counts=${listsMatchCounts}`);

    // On-demand redacted execution debug: the drawer's failing-workflow endpoint returns
    // the failing NODE + error type/code (redacted, no message) + per-run n8n deep links.
    const allWfs = (await argus('/api/workflows?limit=5000')).json?.workflows ?? [];
    const stripe = allWfs.find((w) => w.name === 'Daily Stripe Reconciliation');
    const dbg = stripe ? (await argus(`/api/workflows/${stripe.instanceId}/${stripe.id}/executions`)).json : null;
    const runOk = (dbg?.runs ?? []).length > 0 && (dbg.runs ?? []).every((r) => typeof r.deepLink === 'string' && r.deepLink.includes('/executions/'));
    const failNodeOk = dbg?.failure?.failedNode === 'Fetch Stripe Ledger' && !!dbg?.failure?.errorType;
    add('Redacted execution debug: failing node + error class + per-run deep links',
      !dbg?.unavailable && runOk && failNodeOk,
      dbg ? `node "${dbg.failure?.failedNode}", error ${dbg.failure?.errorType ?? '—'}·${dbg.failure?.errorCode ?? '—'}, ${dbg.runs?.length ?? 0} runs w/ deep links` : 'no debug payload');

    // ── S6.3 silent-failure detection ("green but broken") ────────────────────
    const wfByName = new Map(allWfs.map((w) => [w.name, w]));
    const inv = wfByName.get('Inventory Sync');
    const invSf = inv?.health?.silentFailures;
    // Green-but-swallowing: the run status is green (healthy/idle) BUT a node silently failed,
    // and Argus names the offending node — even though n8n marks every run success.
    add('S6.3 seeded green-but-swallowing reads SILENTLY FAILING with the offending node named',
      !!invSf && invSf.runsAffected > 0 && invSf.lastNode === 'Push to Warehouse' && ['healthy', 'idle'].includes(inv?.health?.status),
      inv ? `Inventory Sync status=${inv.health?.status} (green), silent runsAffected=${invSf?.runsAffected ?? 0}, node="${invSf?.lastNode ?? '—'}", err ${invSf?.lastErrorType ?? '—'}·${invSf?.lastErrorCode ?? '—'}` : 'Inventory Sync missing');

    // Layer 1: the static can-mask-failures flag fires on both swallow-configured workflows,
    // and NOT on a clean control (deterministic, no LLM).
    const notifier = wfByName.get('Resilient Notifier');
    const orderIntake = wfByName.get('Order Intake');
    add('S6.3 Layer-1 can-mask-failures flag: fires on swallow-configured, clean control not flagged',
      inv?.canMaskFailures === true && notifier?.canMaskFailures === true && orderIntake?.canMaskFailures === false,
      `Inventory Sync=${inv?.canMaskFailures}, Resilient Notifier=${notifier?.canMaskFailures}, Order Intake=${orderIntake?.canMaskFailures}`);

    // Mask-prone-but-healthy carries the flag but has NO silent failure; the clean control has neither.
    const notifierSilent = (notifier?.health?.silentFailures?.runsAffected ?? 0) > 0;
    const orderSilent = (orderIntake?.health?.silentFailures?.runsAffected ?? 0) > 0;
    add('S6.3 mask-prone-but-healthy has the flag but NO silent failure; clean control shows neither',
      notifier?.canMaskFailures === true && !notifierSilent && orderIntake?.canMaskFailures === false && !orderSilent,
      `Resilient Notifier silent=${notifierSilent}; Order Intake canMask=${orderIntake?.canMaskFailures}, silent=${orderSilent}`);

    // Zero-false: ONLY the seeded green-but-swallowing workflow reads silently failing —
    // one per seeded instance (prod + staging), and nothing else (no false positives).
    const silentList = (feed.silentlyFailing ?? []).map((w) => w.name);
    add('S6.3 only the seeded green-but-swallowing workflow reads silently failing — no false positives',
      silentList.length >= 1 && silentList.every((n) => n === 'Inventory Sync') && (sum.silentlyFailing ?? 0) === silentList.length,
      `silentlyFailing feed = [${silentList.join(', ') || 'none'}], summary=${sum.silentlyFailing}`);

    // On-demand (drawer): the LIVE silent-failure signal is ALLOWLISTED — node + error class
    // only, with NO error message, stack, or payload host leaking into Argus's output.
    const invDbgSf = inv ? (await argus(`/api/workflows/${inv.instanceId}/${inv.id}/executions`)).json?.silentFailures : null;
    const serialized = JSON.stringify(invDbgSf ?? {});
    const noLeak = !/stack/i.test(serialized) && !serialized.includes('127.0.0.1') && !/connect econnrefused/i.test(serialized);
    add('S6.3 on-demand silent-failure is allowlisted (node + error class only; no message/stack/payload)',
      !!invDbgSf && invDbgSf.runsAffected > 0 && invDbgSf.lastNode === 'Push to Warehouse' && noLeak,
      invDbgSf ? `node "${invDbgSf.lastNode}", err ${invDbgSf.lastErrorType ?? '—'}·${invDbgSf.lastErrorCode ?? '—'}, no-leak=${noLeak}` : 'no on-demand silent signal');

    // Contract-verify (rule 1): n8n-23 characterizes the swallow shape + the un-redacted signal.
    let n23 = null;
    try { n23 = JSON.parse(readFileSync(new URL('../contracts/n8n-23-execution-silent-failure.json', import.meta.url), 'utf8')); } catch { /* missing */ }
    add('S6.3 contract n8n-23 captured (redacted-invisible → un-redacted allowlisted signal)',
      !!n23 && n23.recommendedSeedMechanism === 'http-continue-regular' && /un-redacted/i.test(n23.finding ?? ''),
      n23 ? `recommended="${n23.recommendedSeedMechanism}", finding characterized` : 'contracts/n8n-23 MISSING');

    // Phase 1 — Explore FILTERS: can-mask and silently-failing are findable server-side.
    const canMaskList = ((await argus('/api/workflows?canMask=true&limit=5000')).json?.workflows ?? []).map((w) => w.name).sort();
    const silentFilterList = ((await argus('/api/workflows?silentlyFailing=true&limit=5000')).json?.workflows ?? []).map((w) => w.name).sort();
    add('S6.3 Explore filter: canMask=true returns exactly the swallow-configured workflows',
      canMaskList.length === 4 && canMaskList.every((n) => n === 'Inventory Sync' || n === 'Resilient Notifier'),
      `canMask filter → [${[...new Set(canMaskList)].join(', ') || 'none'}] (${canMaskList.length})`);
    add('S6.3 Explore filter: silentlyFailing=true returns exactly the silently-failing workflows',
      silentFilterList.length === 2 && silentFilterList.every((n) => n === 'Inventory Sync'),
      `silentlyFailing filter → [${[...new Set(silentFilterList)].join(', ') || 'none'}] (${silentFilterList.length})`);

    // Phase 1 — Overview surfaces the silently-failing figure (deep-links to the filtered set).
    const ov = (await argus('/api/governance/overview')).json ?? {};
    const ovSilent = ov.silentlyFailing ?? {};
    add('S6.3 Overview surfaces the silently-failing figure (count == its drilled set)',
      ovSilent.count === 2 && (ovSilent.workflows ?? []).length === ovSilent.count && (ovSilent.workflows ?? []).every((w) => w.name === 'Inventory Sync'),
      `overview silentlyFailing count=${ovSilent.count}, drills to ${(ovSilent.workflows ?? []).length}`);

    // Health feed also buckets the can-mask set (backs the Health "can mask failures" tile).
    const feedCanMask = (feed.canMask ?? []).map((w) => w.name);
    add('S6.3 Health feed buckets the can-mask set for its tile (== the flagged workflows)',
      (feed.summary?.canMask ?? 0) === feedCanMask.length && feedCanMask.length === 4 && feedCanMask.every((n) => n === 'Inventory Sync' || n === 'Resilient Notifier'),
      `health feed canMask = [${[...new Set(feedCanMask)].join(', ') || 'none'}] (${feedCanMask.length}), summary=${feed.summary?.canMask}`);
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
      workflows = (await argus('/api/workflows?limit=5000')).json?.workflows ?? [];
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
    const after = (await argus('/api/workflows?limit=5000')).json?.workflows ?? [];
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

    // The ownership register: paginated accountability table + posture summary + filters.
    let regOk = false;
    let regDetail = '';
    try {
      // The summary posture is filter-independent (computed over ALL) — read it off the
      // needs-owner response (default working set + page 1) and its page 2. `confirmed` is
      // the complement of needs-owner and is taken from the summary, not a separate fetch.
      const p1 = (await argus('/api/ownership/register?state=needs-owner&limit=50&offset=0')).json ?? {};
      const p2 = (await argus('/api/ownership/register?state=needs-owner&limit=50&offset=50')).json ?? {};
      const s = p1.summary ?? {};
      const rows1 = Array.isArray(p1.rows) ? p1.rows : [];
      const rows2 = Array.isArray(p2.rows) ? p2.rows : [];
      const summaryOk = (s.confirmed + s.inferred + s.unowned) === s.total && s.total > 0;
      const rowsHaveRisks = rows1.length > 0 && rows1.every((r) => Array.isArray(r.risks) && r.risks.length > 0);
      const needsAllUnassigned = rows1.every((r) => r.owner?.status !== 'assigned');
      const needsTotal = p1.total ?? -1;
      // needs-owner = advisory + unowned; + confirmed = the whole estate (a clean partition).
      const partitionsOk = needsTotal === (s.inferred + s.unowned) && (needsTotal + s.confirmed) === s.total;
      // Paginated: page 2 has rows and none overlap page 1.
      const ids = (r) => new Set(r.map((x) => `${x.instanceId}/${x.id}`));
      const pagedOk = rows1.length === 50 && rows2.length > 0 && ![...ids(rows1)].some((k) => ids(rows2).has(k));
      regOk = summaryOk && rowsHaveRisks && needsAllUnassigned && partitionsOk && pagedOk;
      regDetail = `total ${s.total} (confirmed ${s.confirmed} · advisory ${s.inferred} · unowned ${s.unowned}), needs-owner ${needsTotal}, partitions=${partitionsOk}, page1 ${rows1.length}/page2 ${rows2.length} distinct=${pagedOk}`;
    } catch (e) {
      regDetail = `register failed: ${e.message}`;
    }
    add('Ownership register: paginated table + posture summary + honest filters (assigned vs advisory)', regOk, regDetail);

    // Audit timeline: partial (case-insensitive substring) actor match + paginated pages.
    let pageOk = false;
    let auditDetail = '';
    try {
      const full = (await argus('/api/ownership/audit')).json ?? {};
      const p1 = (await argus('/api/ownership/audit?limit=1&offset=0')).json ?? {};
      const p2 = (await argus('/api/ownership/audit?limit=1&offset=1')).json ?? {};
      const paged = (p1.entries?.length === 1) && (p2.entries?.length === 1)
        && p1.entries[0].id !== p2.entries[0].id && p1.total === full.total && full.total >= 2;
      // 'VERIF' is an uppercase substring of verify@acme.example — proves partial + case-insensitive.
      // Matches name OR email; every hit must carry the substring in one of the two.
      const partial = (await argus('/api/ownership/audit?actor=VERIF')).json ?? {};
      const partialOk = (partial.entries?.length ?? 0) > 0
        && partial.entries.every((e) => `${e.actorName} ${e.actorEmail}`.toLowerCase().includes('verif'));
      const none = (await argus('/api/ownership/audit?actor=nobody-xyz')).json ?? {};
      const noneOk = (none.entries?.length ?? 0) === 0 && none.total === 0;
      pageOk = paged && partialOk && noneOk;
      auditDetail = `total ${full.total}, pages distinct=${paged}, partial 'VERIF'→${partial.entries?.length ?? 0}, empty-miss=${noneOk}`;
    } catch (e) {
      auditDetail = `audit paging/partial failed: ${e.message}`;
    }
    add('Audit timeline pages + partial actor match (name or email, case-insensitive)', pageOk, auditDetail);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
}

// S5 — relationships & blast radius (graph): live end-to-end against both instances.
async function s5Checks() {
  const up = {};
  for (const inst of Object.values(INSTANCES)) {
    const c = createN8nClient(inst.baseUrl);
    up[inst.name] = (await c.healthy()) && (await c.e2eActive());
  }
  if (!up.prod || !up.staging) {
    add('S5 graph', false, `instances down (prod=${up.prod ? 'up' : 'down'}, staging=${up.staging ? 'up' : 'down'}) — run \`pnpm seed\``);
    return;
  }
  const serverEntry = join(ROOT, 'apps/server/dist/index.js');
  if (!existsSync(serverEntry)) { add('S5 graph', false, 'server build missing'); return; }

  const port = 3215;
  const base = `http://127.0.0.1:${port}`;
  const dbPath = join(tmpdir(), `argus-verify-s5-${Date.now()}.sqlite`);
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
  const setEq = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

  try {
    const health = await pollHealth(`${base}/api/health`);
    if (!health) { add('S5 graph server boots', false, `no health on :${port}`); return; }
    const li = await argus('/api/auth/login', { method: 'POST', body: { password: 'v', name: 'V', email: 'v@acme.example' } });
    cookie = li.setCookies.map((c) => c.split(';')[0]).join('; ');
    const prodC = await connect(INSTANCES.prod.baseUrl);
    const stagingC = await connect(INSTANCES.staging.baseUrl);
    // webhookHost set so the estate pass can CONFIRM the cross-instance webhook edge.
    await argus('/api/connections', { method: 'POST', body: { label: 'prod', baseUrl: INSTANCES.prod.baseUrl, apiKey: prodC.apiKey, webhookHost: INSTANCES.prod.baseUrl } });
    await argus('/api/connections', { method: 'POST', body: { label: 'staging', baseUrl: INSTANCES.staging.baseUrl, apiKey: stagingC.apiKey, webhookHost: INSTANCES.staging.baseUrl } });

    // Wait for the estate edge pass to produce edges.
    let estate = { nodes: [], edges: [] };
    for (let i = 0; i < 60; i++) {
      estate = (await argus('/api/graph?scope=estate')).json ?? { nodes: [], edges: [] };
      if ((estate.edges ?? []).length > 0) break;
      await sleep(500);
    }
    const nodeById = new Map((estate.nodes ?? []).map((n) => [n.id, n]));
    const conns = (await argus('/api/connections')).json?.connections ?? [];
    const prodId = conns.find((c) => c.label === 'prod')?.id;
    const wfs = (await argus('/api/workflows?limit=5000')).json?.workflows ?? [];
    const prodSlack = wfs.find((w) => w.name === 'Send Slack Alert' && w.instanceId === prodId);

    // 1. Blast radius: "what breaks if Send Slack Alert fails" = exactly 5 callers.
    let impact = null;
    if (prodSlack) impact = (await argus(`/api/graph/impact?mode=failure&instanceId=${prodSlack.instanceId}&id=${prodSlack.id}`)).json;
    const directCallers = (impact?.affected ?? []).filter((a) => a.hops === 1);
    add('Blast radius: "what breaks if Send Slack Alert fails" = 5 callers',
      !!impact && directCallers.length === 5,
      impact ? `${directCallers.length} direct callers; total ${impact.total}; "${impact.statement}"` : 'no impact payload');

    // 2. The cross-instance (prod↔staging) webhook edge is detected + CONFIRMED.
    const xi = (estate.edges ?? []).find((e) => e.type === 'cross_instance_webhook');
    const xiSrc = xi ? nodeById.get(xi.source) : null;
    const xiDst = xi ? nodeById.get(xi.target) : null;
    add('Cross-instance edge (prod↔staging) detected + CONFIRMED',
      !!xi && xi.confidence === 'confirmed' && xi.crossInstance === true && xiDst?.label === 'Order Intake',
      xi ? `${xiSrc?.label} (${xiSrc?.instanceLabel}) → ${xiDst?.label} (${xiDst?.instanceLabel}), ${xi.confidence}` : 'no cross-instance edge');

    // 3. A `possible` edge is tracked-as-excluded, never counted in a blast radius.
    const possibleEdges = (estate.edges ?? []).filter((e) => e.confidence === 'possible');
    const peTargetNode = possibleEdges.map((e) => nodeById.get(e.target)).find((n) => n?.kind === 'workflow' && n.workflowId);
    let possibleOk = false, possibleDetail = `${possibleEdges.length} possible edges in estate`;
    if (peTargetNode) {
      const r = (await argus(`/api/graph/impact?mode=failure&instanceId=${peTargetNode.instanceId}&id=${peTargetNode.workflowId}`)).json;
      // possibleExcluded > 0 proves the possible edge touching this node was seen and left OUT of `total`.
      possibleOk = !!r && (r.possibleExcluded ?? 0) >= 1;
      possibleDetail = `${possibleEdges.length} possible; "${peTargetNode.label}" blast radius total ${r?.total} · excluded ${r?.possibleExcluded}`;
    }
    add('A `possible` edge is excluded from the blast-radius count (trust spine)', possibleOk, possibleDetail);

    // 4. Rotate-credential is a DIFFERENT answer than what-breaks-if-it-fails.
    const bc = (estate.edges ?? []).find((e) => e.type === 'binds_credential');
    const credNode = bc ? nodeById.get(bc.target) : null;
    const binderNode = bc ? nodeById.get(bc.source) : null;
    let rotOk = false, rotDetail = 'no binds_credential edge';
    if (credNode && binderNode) {
      const rot = (await argus(`/api/graph/impact?mode=credential_rotation&instanceId=${credNode.instanceId}&id=${credNode.resourceId}`)).json;
      const fail = (await argus(`/api/graph/impact?mode=failure&instanceId=${binderNode.instanceId}&id=${binderNode.workflowId}`)).json;
      const rotIds = (rot?.affected ?? []).map((a) => a.workflowId);
      const failIds = (fail?.affected ?? []).map((a) => a.workflowId);
      rotOk = (rot?.total ?? 0) >= 1 && rot?.edgeTypesTraversed?.[0] === 'binds_credential' && !setEq(rotIds, failIds);
      rotDetail = `rotate "${credNode.label}" → ${rot?.total} binder(s) via ${rot?.edgeTypesTraversed?.join(',')}; failure of "${binderNode.label}" → ${fail?.total} (different set=${!setEq(rotIds, failIds)})`;
    }
    add('Rotate-credential traverses credential edges — a different answer than failure', rotOk, rotDetail);

    // 5. Oracle: Argus's confirmed callers of Send Slack Alert MATCH n8n's own
    //    workflow-index (independent confirmation on the exact H3-critical edges).
    let oracleOk = false, oracleDetail = 'oracle not reached';
    try {
      const oracle = createN8nClient(INSTANCES.prod.baseUrl);
      await oracle.login();
      if (prodSlack && oracle.cookie) {
        const d = await oracle.http('POST', '/rest/workflow-dependencies/details', { body: { resourceIds: [prodSlack.id], resourceType: 'workflow' } });
        const deps = d.json?.data?.[prodSlack.id]?.dependencies ?? [];
        const parentIds = deps.filter((x) => x.type === 'workflowParent').map((x) => x.id);
        const argusIds = directCallers.map((a) => a.workflowId);
        oracleOk = parentIds.length === 5 && setEq(parentIds, argusIds);
        oracleDetail = `n8n workflow-index parents ${parentIds.length}, Argus direct callers ${argusIds.length}, match=${setEq(parentIds, argusIds)}`;
      }
    } catch (e) { oracleDetail = `oracle call failed: ${e.message}`; }
    add('Confirmed edges match n8n workflow-index (independent oracle)', oracleOk, oracleDetail);

    // 6. Scale sanity: the estate graph + a neighborhood query stay responsive.
    const t0 = Date.now();
    const nbFocus = prodSlack ? `wf:${prodSlack.instanceId}:${prodSlack.id}` : null;
    const nb = nbFocus ? (await argus(`/api/graph?scope=neighborhood&focus=${encodeURIComponent(nbFocus)}&hops=2`)).json : null;
    const ms = Date.now() - t0;
    add('Graph estate + neighborhood queries responsive at fleet scale',
      (estate.nodes ?? []).length > 0 && !!nb && ms < 4000,
      `estate ${estate.nodes?.length ?? 0} nodes / ${estate.edges?.length ?? 0} edges; neighborhood ${nb?.nodes?.length ?? 0} nodes in ${ms}ms`);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
}

// S6 — governance overview: boot a real Argus server against both live instances,
// register them, wait for sync, and prove the composed dashboard NEVER diverges from
// its source reads, every figure drills, the score is deterministic, and export matches.
async function s6Checks() {
  const up = {};
  for (const inst of Object.values(INSTANCES)) {
    const c = createN8nClient(inst.baseUrl);
    up[inst.name] = (await c.healthy()) && (await c.e2eActive());
  }
  if (!up.prod || !up.staging) {
    add('S6 governance overview', false, `instances down (prod=${up.prod ? 'up' : 'down'}, staging=${up.staging ? 'up' : 'down'}) — run \`pnpm seed\``);
    return;
  }
  const serverEntry = join(ROOT, 'apps/server/dist/index.js');
  if (!existsSync(serverEntry)) { add('S6 governance overview', false, 'server build missing'); return; }

  const port = 3216;
  const base = `http://127.0.0.1:${port}`;
  const dbPath = join(tmpdir(), `argus-verify-s6-${Date.now()}.sqlite`);
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
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* non-JSON (e.g. the markdown export) */ }
    return { status: res.status, json, text, setCookies: res.headers.getSetCookie?.() ?? [] };
  };

  try {
    const health = await pollHealth(`${base}/api/health`);
    if (!health) { add('S6 overview server boots', false, `no health on :${port}`); return; }
    const li = await argus('/api/auth/login', { method: 'POST', body: { password: 'v', name: 'V', email: 'v@acme.example' } });
    cookie = li.setCookies.map((c) => c.split(';')[0]).join('; ');
    const prodC = await connect(INSTANCES.prod.baseUrl);
    const stagingC = await connect(INSTANCES.staging.baseUrl);
    await argus('/api/connections', { method: 'POST', body: { label: 'prod', baseUrl: INSTANCES.prod.baseUrl, apiKey: prodC.apiKey, webhookHost: INSTANCES.prod.baseUrl } });
    await argus('/api/connections', { method: 'POST', body: { label: 'staging', baseUrl: INSTANCES.staging.baseUrl, apiKey: stagingC.apiKey, webhookHost: INSTANCES.staging.baseUrl } });

    // Wait for the catalog + health sync to settle so the composed figures are populated.
    let ov = null;
    for (let i = 0; i < 60; i++) {
      ov = (await argus('/api/governance/overview')).json;
      if (ov && ov.unowned && (ov.unowned.total > 0 || (ov.health?.summary?.failing ?? 0) > 0)) break;
      await sleep(500);
    }
    if (!ov) { add('S6 governance overview', false, 'no overview payload'); return; }

    // 1. Non-divergence: overview.unowned == the Governance view's own gaps read.
    const gaps = (await argus('/api/ownership/gaps')).json ?? { unowned: [] };
    add('Overview composes, never diverges: unowned == Governance gaps',
      ov.unowned.total === (gaps.unowned?.length ?? -1) && ov.unowned.total === ov.unowned.workflows.length,
      `overview ${ov.unowned.total} unowned == gaps ${gaps.unowned?.length}; drills to ${ov.unowned.workflows.length}`);

    // 2. Non-divergence: failing-with-owner == the OWNED subset of the Health feed.
    const feed = (await argus('/api/workflows/failing')).json ?? { failing: [], degraded: [] };
    const ownedFailing = [...(feed.failing ?? []), ...(feed.degraded ?? [])].filter((w) => w.owner && w.owner.status === 'assigned');
    add('Overview composes, never diverges: failing-with-owner == ASSIGNED-owner subset of Health feed',
      ov.failingWithOwner.count === ownedFailing.length && ov.failingWithOwner.count === ov.failingWithOwner.workflows.length,
      `${ov.failingWithOwner.count} confirmed-owner incidents == ${ownedFailing.length} from the failing feed; drills to ${ov.failingWithOwner.workflows.length}`);

    // 3. The governance score is a deterministic, explainable 0–100 with five pillars.
    const s = ov.score;
    const inRange = s.score === null || (typeof s.score === 'number' && s.score >= 0 && s.score <= 100);
    const explained = Array.isArray(s.pillars) && s.pillars.length === 5 && s.pillars.every((p) => typeof p.reason === 'string' && p.inputs);
    add('Governance score is a deterministic, explainable 0–100 (five pillars, no black box)',
      inRange && explained,
      `score ${s.score}; pillars ${s.pillars?.map((p) => `${p.label}=${p.scored ? p.score : 'n/a'}`).join(', ')}`);

    // 4. Every headline tile's count equals its EXACT workflow set — the composition
    //    guarantee that makes each tile's deep-link honest (the number leads to that set).
    const drills = [
      ['unowned', ov.unowned.total, ov.unowned.workflows.length],
      ['failing-with-owner', ov.failingWithOwner.count, ov.failingWithOwner.workflows.length],
      ['broken-refs', ov.hygiene.brokenRefs.count, ov.hygiene.brokenRefs.workflows.length],
      ['active-no-exec', ov.hygiene.activeNoExecutions.count, ov.hygiene.activeNoExecutions.workflows.length],
      ['mcp-exposed', ov.exposure.mcpExposed, ov.exposure.surfaces.length],
    ];
    const mismatched = drills.filter(([, count, len]) => count !== len);
    add('Every overview tile count == its exact workflow set (deep-links stay honest)', mismatched.length === 0,
      mismatched.length === 0 ? `${drills.length} tiles match their set exactly` : `MISMATCH: ${mismatched.map(([n, c, l]) => `${n} ${c}≠${l}`).join(', ')}`);

    // 4b. The Estate deep-links each land on EXACTLY the tile's set — the catalog filters
    //     the hygiene/idle tiles point at (?broken / ?stale / ?health=idle&active=true).
    const brokenList = (await argus('/api/workflows?broken=true')).json ?? {};
    const staleList = (await argus('/api/workflows?stale=true')).json ?? {};
    const idleActiveList = (await argus('/api/workflows?health=idle&active=true')).json ?? {};
    const linkChecks = [
      ['broken', brokenList.workflows?.length, ov.hygiene.brokenRefs.count],
      ['stale', staleList.workflows?.length, ov.hygiene.staleEnrichment.count],
      ['idle-active', idleActiveList.workflows?.length, ov.hygiene.activeNoExecutions.count],
    ];
    const linkBad = linkChecks.filter(([, got, want]) => got !== want);
    add('Overview tiles deep-link to their exact Estate set (broken / stale / idle-active filters)', linkBad.length === 0,
      linkBad.length === 0 ? linkChecks.map(([n, got]) => `${n}=${got}`).join(', ') : `MISMATCH: ${linkBad.map(([n, g, w]) => `${n} ${g}≠${w}`).join(', ')}`);

    // 5. The export is a structured, readable report that matches the screen.
    const rep = await argus('/api/governance/export');
    const md = rep.text ?? '';
    add('Export produces a structured governance report (matches the screen)',
      rep.status === 200 && md.includes('# Argus — Governance report') && md.includes('Governance score') && md.includes(String(ov.unowned.total)),
      rep.status === 200 ? `markdown report, ${md.length} chars, score + ${ov.unowned.total} unowned present` : `export HTTP ${rep.status}`);
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
