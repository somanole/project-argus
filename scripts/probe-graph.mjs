#!/usr/bin/env node
// S5 (Graph & blast radius) contract probe — NON-DESTRUCTIVE (does NOT reset/seed).
//
// Standing rule 1: before building S5's cross-workflow edge layer + the
// workflow-index cross-check oracle, hit the REAL running, ALREADY-SEEDED estate and
// capture the actual shapes we code against:
//
//   1. THE ORACLE — n8n's own dependency index (internal REST, cookie auth):
//        POST /rest/workflow-dependencies/details { resourceIds, resourceType }
//        POST /rest/workflow-dependencies/counts  { resourceIds, resourceType }
//      For "Send Slack Alert" (fan-in 5) we expect `workflowParent` to list its 5
//      callers — the independent confirmation of Argus's confirmed call edges. Also
//      answers: does the index track tool/agent calls as `workflowCall`, or only
//      executeWorkflow?
//   2. THE EXTRACTION SHAPES S1b did NOT capture (S5 adds them):
//        - n8n-nodes-base.webhook  → parameters.path        (webhook↔HTTP matching)
//        - n8n-nodes-base.httpRequest → parameters.url      (host + path; may be expr)
//        - node.credentials { <type>: { id, name } }        (credential-binding edges)
//
// Reads BOTH seeded instances (prod :5678, staging :5679): prod carries the fan-in
// target + a webhook; staging carries the cross-instance HTTP→prod bridge.
//
// Writes contracts/n8n-20-graph-shapes.json. No writes to n8n.
//
// Usage: node scripts/probe-graph.mjs   (requires `pnpm seed` to have run)

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createN8nClient } from './lib/n8n-client.mjs';

const N8N_VERSION = '2.29.0';
const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts');
const now = () => new Date().toISOString();

const INSTANCES = [
  { role: 'prod', base: process.env.N8N_PROD_URL ?? 'http://localhost:5678' },
  { role: 'staging', base: process.env.N8N_STAGING_URL ?? 'http://localhost:5679' },
];

// Seeded workflows whose shapes exercise the S5 extraction + oracle.
const OF_INTEREST = {
  fanInTarget: ['Send Slack Alert'],            // oracle: workflowParent = 5 callers
  webhookSource: ['Order Intake'],              // n8n-nodes-base.webhook parameters.path
  crossInstance: ['Staging → Prod Order Sync'], // httpRequest parameters.url → prod webhook
  credentialBinder: ['Salesforce CRM Sync', 'Daily Stripe Reconciliation'], // node.credentials{id,name}
};

async function listAllWorkflows(client) {
  const items = [];
  let cursor = null;
  do {
    const q = `/workflows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await client.api('GET', q);
    if (r.status !== 200) throw new Error(`GET ${q} → ${r.status}`);
    items.push(...(r.json?.data ?? []));
    cursor = r.json?.nextCursor ?? null;
  } while (cursor);
  return items;
}

/** Find the credential binding shape on any node of a workflow. */
function credentialShapes(items) {
  const out = [];
  for (const w of items) {
    for (const n of w.nodes ?? []) {
      if (n.credentials && Object.keys(n.credentials).length > 0) {
        out.push({ workflow: w.name, node: n.name, type: n.type, credentials: n.credentials });
      }
    }
  }
  return out;
}

async function probeInstance({ role, base }) {
  const client = createN8nClient(base);
  if (!(await client.healthy())) {
    console.error(`  ${role}: n8n not reachable at ${base} — start it + \`pnpm seed\`.`);
    return null;
  }
  const li = await client.login();
  if (!client.cookie) {
    console.error(`  ${role}: login failed (${li.status}) — run \`pnpm seed\`.`);
    return null;
  }
  await client.mintApiKey(`argus-graph-probe-${Date.now()}`);
  if (!client.apiKey) {
    console.error(`  ${role}: could not mint an API key.`);
    return null;
  }

  const items = await listAllWorkflows(client);
  const idByName = new Map(items.map((w) => [w.name, w.id]));
  const pickIds = (names) => names.map((n) => idByName.get(n)).filter(Boolean);

  // --- 1. THE ORACLE: n8n workflow-index (internal REST, cookie auth) ---
  const fanInIds = pickIds(OF_INTEREST.fanInTarget);
  let oracleDetails = null;
  let oracleCounts = null;
  if (fanInIds.length > 0) {
    const d = await client.http('POST', '/rest/workflow-dependencies/details', {
      body: { resourceIds: fanInIds, resourceType: 'workflow' },
    });
    oracleDetails = { status: d.status, body: d.json ?? d.text };
    const c = await client.http('POST', '/rest/workflow-dependencies/counts', {
      body: { resourceIds: fanInIds, resourceType: 'workflow' },
    });
    oracleCounts = { status: c.status, body: c.json ?? c.text };
  }

  // --- 2. THE EXTRACTION SHAPES ---
  const byName = (name) => items.find((w) => w.name === name);
  const nodesOf = (name) => (byName(name)?.nodes ?? []);
  const webhookNodes = OF_INTEREST.webhookSource.flatMap((wf) =>
    nodesOf(wf).filter((n) => n.type === 'n8n-nodes-base.webhook').map((n) => ({ workflow: wf, node: n.name, type: n.type, parameters: n.parameters })),
  );
  const httpNodes = OF_INTEREST.crossInstance.flatMap((wf) =>
    nodesOf(wf).filter((n) => n.type === 'n8n-nodes-base.httpRequest').map((n) => ({ workflow: wf, node: n.name, type: n.type, url: n.parameters?.url, parameters: n.parameters })),
  );
  const credShapes = credentialShapes(items.filter((w) => OF_INTEREST.credentialBinder.includes(w.name))).slice(0, 4);

  return {
    role,
    base,
    workflowCount: items.length,
    fanInTarget: { names: OF_INTEREST.fanInTarget, ids: fanInIds },
    oracleDetails,
    oracleCounts,
    webhookNodes,
    httpNodes,
    credentialShapes: credShapes,
  };
}

async function main() {
  await mkdir(CONTRACTS_DIR, { recursive: true });
  const results = [];
  for (const inst of INSTANCES) {
    console.log(`probing ${inst.role} (${inst.base})…`);
    const r = await probeInstance(inst);
    if (r) results.push(r);
  }
  if (results.length === 0) {
    console.error('no instances probed — aborting.');
    process.exit(1);
  }

  // Derive the headline findings for the contract's human summary.
  const prod = results.find((r) => r.role === 'prod');
  const oracleOk = prod?.oracleDetails?.status === 200;
  const slackId = prod?.fanInTarget?.ids?.[0];
  // The index wraps the payload in { data: { <id>: {...} } }.
  const slackDetail = oracleOk && slackId ? prod.oracleDetails.body?.data?.[slackId] : null;
  const parents = (slackDetail?.dependencies ?? []).filter((d) => d.type === 'workflowParent');

  const findings = {
    oracle:
      prod?.oracleDetails == null
        ? 'NOT PROBED (prod unavailable)'
        : oracleOk
          ? `POST /rest/workflow-dependencies/details → 200. Send Slack Alert workflowParent count = ${parents.length} (expect 5 callers). Dependency types observed: ${[...new Set((slackDetail?.dependencies ?? []).map((d) => d.type))].join(', ') || '(none)'}.`
          : `UNEXPECTED status ${prod.oracleDetails.status} — inspect oracleDetails (module may be disabled or path changed).`,
    webhookPathShape:
      'n8n-nodes-base.webhook stores the path at parameters.path (literal string, e.g. "order-intake"); may be an n8n expression → unmatchable.',
    httpUrlShape:
      'n8n-nodes-base.httpRequest stores the target at parameters.url (literal or expression). Cross-instance edge = url host matches another connection webhook_host + path matches a webhook there.',
    credentialBindingShape:
      'node.credentials = { <credentialType>: { id, name } } — the id is the estate-unique credential id used for binds_credential / shared_credential edges (S1b captured only the TYPE).',
  };

  await writeFile(
    join(CONTRACTS_DIR, 'n8n-20-graph-shapes.json'),
    JSON.stringify(
      {
        $probe:
          'S5 graph: n8n workflow-index dependency oracle (internal REST) + the webhook/HTTP/credential-binding node shapes S5 extraction reads. Non-destructive; reads the seeded estate.',
        capturedAt: now(),
        n8nVersion: N8N_VERSION,
        oracleRequest: {
          method: 'POST',
          path: '/rest/workflow-dependencies/details',
          auth: 'cookie (owner login) — INTERNAL REST, dev/demo oracle only',
          body: { resourceIds: ['<workflowId>…'], resourceType: 'workflow' },
        },
        findings,
        instances: results,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`\nn8n-20 captured: ${results.map((r) => `${r.role}=${r.workflowCount}wf`).join(', ')}.`);
  console.log(`  oracle: ${findings.oracle}`);
  console.log(`  webhook nodes: ${results.reduce((a, r) => a + r.webhookNodes.length, 0)}; http nodes: ${results.reduce((a, r) => a + r.httpNodes.length, 0)}; cred shapes: ${results.reduce((a, r) => a + r.credentialShapes.length, 0)}`);
}

await main();
