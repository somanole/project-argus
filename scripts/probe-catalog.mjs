#!/usr/bin/env node
// S1b (Catalog) contract probe — NON-DESTRUCTIVE (does NOT reset/seed).
//
// Standing rule 1: before building the analyzer against the workflow LIST shape,
// hit the REAL running, ALREADY-SEEDED instance and capture the actual fields the
// analyzer reads — the ones the S1a contract (n8n-15) summarized away:
//   - activeVersion.nodes / .connections  (the node graph the analyzer parses)
//   - settings.errorWorkflow / .availableInMCP / .callerPolicy / .callerIds
//   - triggerCount, tags
// It also answers the one open question that gates the slice: does the PUBLIC API
// (`GET /api/v1/workflows`) surface `settings.availableInMCP`, or must MCP-exposed
// be inferred from the `@n8n/n8n-nodes-langchain.mcpTrigger` node?
//
// Reads the seeded estate (owner nathan@n8n.io), mints a throwaway read key, and
// writes contracts/n8n-16-workflow-list-facts-shape.json. No writes to n8n.
//
// Usage: node scripts/probe-catalog.mjs   (requires `pnpm seed` to have run)

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createN8nClient } from './lib/n8n-client.mjs';

const BASE = process.env.N8N_BASE_URL ?? 'http://localhost:5678';
const N8N_VERSION = '2.29.0';
const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts');
const now = () => new Date().toISOString();

// Seeded workflows whose shapes exercise every fact the analyzer extracts.
const OF_INTEREST = {
  mcp: ['KB Lookup', 'Sensitive Data Exporter'],       // settings.availableInMCP + mcpTrigger?
  subRef: ['Order Intake', 'Enrich Customer'],          // executeWorkflow resource-locator ref
  fanInTarget: ['Send Slack Alert'],                    // executeWorkflowTrigger, triggerCount
  brokenRef: ['Lead Scorer'],                           // ref → deleted id
  agentTool: ['AI Support Agent', 'Agent Tool Orchestrator'], // toolWorkflow / agentTool refs
};

async function main() {
  await mkdir(CONTRACTS_DIR, { recursive: true });
  const client = createN8nClient(BASE);

  if (!(await client.healthy())) {
    console.error(`n8n not reachable at ${BASE} — start it + \`pnpm seed\` first.`);
    process.exit(1);
  }
  // The estate is seeded under the E2E owner; log in (cookie) and mint a read key.
  const li = await client.login();
  if (!client.cookie) {
    console.error(`login failed (${li.status}) — is the estate seeded? run \`pnpm seed\`.`);
    process.exit(1);
  }
  await client.mintApiKey(`argus-catalog-probe-${Date.now()}`);
  if (!client.apiKey) {
    console.error('could not mint an API key — aborting.');
    process.exit(1);
  }

  // Pull the whole estate (public API, paginated) exactly as Argus's client does.
  const items = [];
  let cursor = null;
  do {
    const q = `/workflows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await client.api('GET', q);
    if (r.status !== 200) {
      console.error(`GET ${q} → ${r.status}; aborting.`);
      process.exit(1);
    }
    items.push(...(r.json?.data ?? []));
    cursor = r.json?.nextCursor ?? null;
  } while (cursor);

  const byName = (name) => items.find((w) => w.name === name);
  const pick = (names) => names.map(byName).filter(Boolean);

  // Full raw items (unsummarized) for the analyzer-relevant workflows.
  const samples = {};
  for (const [group, names] of Object.entries(OF_INTEREST)) {
    samples[group] = pick(names).map((w) => w); // keep full node graph verbatim
  }

  // Answer the gating question: is availableInMCP on the PUBLIC list item?
  const mcpItems = pick(OF_INTEREST.mcp);
  const availableInMcpPresent = mcpItems.map((w) => ({
    name: w.name,
    'settings.availableInMCP': w.settings?.availableInMCP ?? '(absent)',
    hasMcpTriggerNode: (w.activeVersion?.nodes ?? w.nodes ?? []).some(
      (n) => n.type === '@n8n/n8n-nodes-langchain.mcpTrigger',
    ),
  }));

  // Confirm the analyzer's input fields are inline on list items.
  const first = items[0] ?? {};
  const factFields = ['nodes', 'connections', 'settings', 'triggerCount', 'tags'];
  const missing = factFields.filter((f) => !(f in first));
  // CRITICAL: `activeVersion` is null for every non-active workflow, but the
  // top-level `nodes` array is ALWAYS present (the current definition). So the
  // analyzer must read node facts from top-level `nodes`, not activeVersion.
  const topNodesAlwaysArray = items.every((w) => Array.isArray(w.nodes));
  const activeVersionNullCount = items.filter((w) => w.activeVersion == null).length;

  const mcpSource =
    availableInMcpPresent.every((m) => m['settings.availableInMCP'] === true)
      ? 'settings.availableInMCP (public API surfaces it)'
      : availableInMcpPresent.every((m) => m.hasMcpTriggerNode)
        ? 'mcpTrigger node (settings flag NOT on public list item — fall back to node detection)'
        : 'INCONCLUSIVE — inspect samples.mcp';

  await writeFile(
    join(CONTRACTS_DIR, 'n8n-16-workflow-list-facts-shape.json'),
    JSON.stringify(
      {
        $probe:
          'GET /api/v1/workflows?limit=N — FULL list-item shape for the S1b analyzer (nodes, settings, triggerCount, tags). Non-destructive; reads the seeded estate.',
        capturedAt: now(),
        n8nVersion: N8N_VERSION,
        request: { method: 'GET', path: '/api/v1/workflows?limit=250', headers: { 'X-N8N-API-KEY': '«redacted»' } },
        response: { status: 200, totalWorkflows: items.length, itemKeys: Object.keys(first).sort() },
        findings: {
          factFieldsPresent: missing.length === 0 ? 'ALL PRESENT (nodes, connections, settings, triggerCount, tags)' : `MISSING: ${missing.join(', ')}`,
          nodeSource: `top-level \`nodes\` (always an array: ${topNodesAlwaysArray}). \`activeVersion\` is NULL for ${activeVersionNullCount}/${items.length} workflows (only currently-active ones populate it) — DO NOT read node facts from activeVersion.`,
          mcpExposedSource: mcpSource,
          availableInMcpProbe: availableInMcpPresent,
          resourceLocatorRefs: 'executeWorkflow / toolWorkflow use workflowId={__rl,mode:"list",value:<id>}; mode="list" carries a LITERAL workflow id in `value` (both the resolved Order Intake ref and the broken Lead Scorer all-zeros ref use mode="list"). Treat mode∈{id,list} value as an id. agentTool may carry workflowId=null (no ref → emit nothing, never broken). typeVersion 1 executeWorkflow uses a bare-string workflowId; source="parameter" is inline (dynamic, no id).',
        },
        samples,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`n8n-16 captured: ${items.length} workflows.`);
  console.log(`  fact fields: ${missing.length === 0 ? 'ALL PRESENT' : `MISSING ${missing.join(',')}`}`);
  console.log(`  node source: top-level nodes always array=${topNodesAlwaysArray}; activeVersion null for ${activeVersionNullCount}/${items.length}`);
  console.log(`  MCP-exposed source → ${mcpSource}`);
  for (const m of availableInMcpPresent) console.log(`    ${m.name}: availableInMCP=${m['settings.availableInMCP']}, mcpTriggerNode=${m.hasMcpTriggerNode}`);
}

await main();
