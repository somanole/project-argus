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
