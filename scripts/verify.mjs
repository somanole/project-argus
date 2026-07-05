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
//
// Usage: pnpm verify   (n8n must be running for check 3 — see CLAUDE.md)

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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
      env: { ...process.env, ARGUS_PORT: String(port), ARGUS_HOST: '127.0.0.1' },
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
    'n8n-05-workflow-shared-shape', 'n8n-06-folders-visibility', 'n8n-07-agents-v2-visibility'];
  const missing = required.filter((r) => !files.some((f) => f.startsWith(r)));
  const ok = missing.length === 0;
  add('Contract-probe files exist', ok, ok ? `${files.length} probe files in contracts/` : `missing: ${missing.join(', ')}`);
}

// ---- Check 5: placeholder wired for BOTH light and dark ----
{
  const assetsDir = join(ROOT, 'apps/web/dist/assets');
  const cssFile = built && existsSync(assetsDir) ? readdirSync(assetsDir).find((f) => f.endsWith('.css')) : null;
  const cssText = cssFile ? readFileSync(join(assetsDir, cssFile), 'utf8') : '';
  const hasPrimitives = /--color--/.test(cssText);
  const hasDarkAttr = /data-theme=['"]?dark/.test(cssText);
  const hasMediaDark = /prefers-color-scheme:\s*dark/.test(cssText);
  const hasFont = /InterVariable/.test(cssText);

  // App must use tokens, never hard-coded hex colors (standing rule 10).
  const appVue = readFileSync(join(ROOT, 'apps/web/src/App.vue'), 'utf8');
  const styleBlock = appVue.slice(appVue.indexOf('<style'));
  const hexColors = styleBlock.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  const usesTokens = (styleBlock.match(/var\(--/g) ?? []).length;

  const ok = hasPrimitives && hasDarkAttr && hasMediaDark && hasFont && hexColors.length === 0 && usesTokens > 10;
  const parts = [
    hasPrimitives ? 'primitives✓' : 'primitives✗',
    hasDarkAttr ? 'dark-attr✓' : 'dark-attr✗',
    hasMediaDark ? 'media-dark✓' : 'media-dark✗',
    hasFont ? 'font✓' : 'font✗',
    `${usesTokens} var(--) refs`,
    hexColors.length === 0 ? 'no hard-coded hex' : `${hexColors.length} HEX!`,
  ];
  add('Placeholder renders in BOTH light and dark (tokens only)', ok, parts.join(', '));
}

// ---- Seeder checks (M1): the planted problems are really there ----
// Read-only, from n8n's own APIs (no Argus analyzer yet). Needs `pnpm seed` first.
await seederChecks();

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

  // 3. Workflow count per instance in range.
  const inRange = (n) => n >= 25 && n <= 30;
  add('Workflow count per instance in range (25–30)', both(inRange(P.wfs.length), inRange(S.wfs.length)),
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
