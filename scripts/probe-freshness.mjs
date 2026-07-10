#!/usr/bin/env node
// S6.1 (Analyzer freshness) contract probe — NON-DESTRUCTIVE (does NOT reset/seed).
//
// Standing rule 1 + Decision #23's gating contract probe. Before building the
// analyzer-freshness detection + alert, hit the REAL running instance and settle the
// two questions that decide the whole design fork:
//
//   Q1 — Is the running n8n VERSION reachable to an API-key caller?
//        Probe /rest/settings with an API key ONLY (no cookie) vs WITH a cookie, and
//        /api/v1/version. n8n serves `versionCli` only to a browser session cookie;
//        an API-key caller gets the reduced public payload with no version.
//   Q2 — Is node/credential-type METADATA reachable with a read API key, or cookie-only?
//        Probe /types/nodes.json with an API key ONLY vs WITH a cookie, and /rest/node-types.
//        The static type files sit behind the session-cookie auth middleware.
//
// Argus holds ONLY a read-only public API key (no cookie), so both "No" answers mean:
// regeneration stays a build/ops step and the UI degrades to upgrade guidance; the
// detection half ships regardless (anchored on unrecognized nodes it already syncs).
//
// Writes contracts/n8n-21-version-unreachable.json + contracts/n8n-22-types-nodes-auth.json.
// No secrets are stored (no cookie, no API key) — only statuses, key lists, sizes, findings.
// No writes to n8n.
//
// Usage: node scripts/probe-freshness.mjs   (n8n must be running; `pnpm n8n:up`)

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createN8nClient } from './lib/n8n-client.mjs';

const N8N_VERSION = '2.29.0';
const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts');
const now = () => new Date().toISOString();

const BASE = process.env.N8N_PROD_URL ?? 'http://localhost:5678';

/** Every key anywhere in the object whose name contains "version". */
function versionKeys(obj) {
  const hits = [];
  const walk = (o, path = '') => {
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (/version/i.test(k)) hits.push({ key: `${path}${k}`, value: typeof v === 'object' ? '[object]' : v });
        walk(v, `${path}${k}.`);
      }
    }
  };
  walk(obj);
  return hits;
}

async function main() {
  await mkdir(CONTRACTS_DIR, { recursive: true });
  const client = createN8nClient(BASE);

  if (!(await client.healthy())) {
    console.error(`n8n not reachable at ${BASE} — start it with \`pnpm n8n:up\`.`);
    process.exit(1);
  }
  const li = await client.login();
  if (!client.cookie) {
    console.error(`login failed (${li.status}) — run \`pnpm seed\` to (re)create the owner.`);
    process.exit(1);
  }
  await client.mintApiKey(`argus-freshness-probe-${Date.now()}`);
  if (!client.apiKey) {
    console.error('could not mint an API key.');
    process.exit(1);
  }

  // --- Q1: version reachability ---------------------------------------------
  // API-key ONLY (no cookie): force cookie off, key stays attached.
  const settingsKeyOnly = await client.http('GET', '/rest/settings', { cookie: '' });
  // Cookie present (the browser path), key suppressed.
  const settingsCookie = await client.http('GET', '/rest/settings', { cookie: client.cookie, key: false });
  const apiV1Version = await client.http('GET', '/api/v1/version', { cookie: '' });

  const keyOnlyBody = settingsKeyOnly.json?.data ?? settingsKeyOnly.json ?? {};
  const cookieBody = settingsCookie.json?.data ?? settingsCookie.json ?? {};
  const keyOnlyVersionKeys = versionKeys(keyOnlyBody);
  const cookieVersionKeys = versionKeys(cookieBody);

  const q1 = {
    question: 'Is the running n8n version reachable to an API-key caller?',
    answer:
      keyOnlyVersionKeys.length === 0
        ? 'NO — an API-key caller gets no version. versionCli is cookie-session only.'
        : `UNEXPECTED — API-key /rest/settings exposed version keys: ${keyOnlyVersionKeys.map((k) => k.key).join(', ')}. Re-examine the design fork.`,
    restSettings_apiKeyOnly: {
      request: { method: 'GET', path: '/rest/settings', auth: 'X-N8N-API-KEY only (no cookie)', headers: '«redacted»' },
      status: settingsKeyOnly.status,
      topKeys: Object.keys(keyOnlyBody).sort(),
      versionKeys: keyOnlyVersionKeys,
    },
    restSettings_cookie: {
      request: { method: 'GET', path: '/rest/settings', auth: 'session cookie', headers: '«redacted»' },
      status: settingsCookie.status,
      topKeys: Object.keys(cookieBody).sort(),
      versionKeys: cookieVersionKeys,
    },
    apiV1Version: {
      request: { method: 'GET', path: '/api/v1/version', auth: 'X-N8N-API-KEY only', headers: '«redacted»' },
      status: apiV1Version.status,
    },
  };

  // --- Q2: node/credential-type metadata reachability ------------------------
  const nodesKeyOnly = await client.http('GET', '/types/nodes.json', { cookie: '' });
  const nodesCookie = await client.http('GET', '/types/nodes.json', { cookie: client.cookie, key: false });
  const credsKeyOnly = await client.http('GET', '/types/credentials.json', { cookie: '' });
  const restNodeTypes = await client.http('POST', '/rest/node-types', { cookie: '', body: {} });

  const nodesCookieLen = Array.isArray(nodesCookie.json) ? nodesCookie.json.length : null;

  const q2 = {
    question: 'Is node/credential-type metadata reachable with a read API key, or cookie-only?',
    answer:
      nodesKeyOnly.status === 401 && nodesCookie.status === 200
        ? 'NO — cookie-only. /types/nodes.json is 401 with an API key, 200 with a session cookie.'
        : `UNEXPECTED — nodes.json apiKey=${nodesKeyOnly.status}, cookie=${nodesCookie.status}. Re-examine the design fork.`,
    typesNodes_apiKeyOnly: {
      request: { method: 'GET', path: '/types/nodes.json', auth: 'X-N8N-API-KEY only (no cookie)', headers: '«redacted»' },
      status: nodesKeyOnly.status,
    },
    typesNodes_cookie: {
      request: { method: 'GET', path: '/types/nodes.json', auth: 'session cookie', headers: '«redacted»' },
      status: nodesCookie.status,
      nodeTypeCount: nodesCookieLen,
    },
    typesCredentials_apiKeyOnly: {
      request: { method: 'GET', path: '/types/credentials.json', auth: 'X-N8N-API-KEY only', headers: '«redacted»' },
      status: credsKeyOnly.status,
    },
    restNodeTypes_apiKeyOnly: {
      request: { method: 'POST', path: '/rest/node-types', auth: 'X-N8N-API-KEY only', headers: '«redacted»' },
      status: restNodeTypes.status,
    },
  };

  await writeFile(
    join(CONTRACTS_DIR, 'n8n-21-version-unreachable.json'),
    JSON.stringify(
      {
        $probe:
          'Decision #23 gating probe Q1: does an API-key caller learn the running n8n version? Non-destructive.',
        capturedAt: now(),
        n8nVersion: N8N_VERSION,
        base: BASE,
        finding: q1.answer,
        detail: q1,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  await writeFile(
    join(CONTRACTS_DIR, 'n8n-22-types-nodes-auth.json'),
    JSON.stringify(
      {
        $probe:
          'Decision #23 gating probe Q2: is node/credential-type metadata reachable with a read API key or cookie-only? Non-destructive.',
        capturedAt: now(),
        n8nVersion: N8N_VERSION,
        base: BASE,
        finding: q2.answer,
        detail: q2,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log('\nn8n-21 (version):', q1.answer);
  console.log('n8n-22 (node metadata):', q2.answer);
  console.log(`  /types/nodes.json cookie → ${nodesCookie.status} (${nodesCookieLen} node types); apiKey → ${nodesKeyOnly.status}`);
}

await main();
