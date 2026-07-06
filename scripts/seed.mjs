#!/usr/bin/env node
// pnpm seed — the one command. Ensures both n8n instances are up (launching them
// if needed), seeds prod, seeds staging (plus the cross-instance bridge), and
// prints where to look. Idempotent: safe to re-run any time.

import { ensureAll, INSTANCES } from './lib/launch.mjs';
import { seedInstance } from './lib/seed-runtime.mjs';
import { crossInstanceBridge } from './seed/estate.mjs';
import { reconnectLocalArgus } from './lib/argus-reconnect.mjs';

console.log('Seeding the Argus n8n estate (prod + staging)…\n');

console.log('1/4  Ensuring both instances are up');
await ensureAll();

console.log('\n2/4  Seeding prod');
const prod = await seedInstance(INSTANCES.prod);

console.log('\n3/4  Seeding staging (+ cross-instance bridge)');
const staging = await seedInstance(INSTANCES.staging, {
  extraWorkflows: [crossInstanceBridge(INSTANCES.prod.baseUrl)],
});

// The reset above invalidated any n8n API key a running Argus had stored, so
// re-point a local Argus at the fresh estate (no-op if none is running).
console.log('\n4/4  Refreshing local Argus connections (if running)');
const reconnect = await reconnectLocalArgus(INSTANCES);
if (!reconnect.skipped) console.log(`  refreshed ${reconnect.refreshed} Argus connection(s) with fresh read-only keys`);

console.log('\nEstate seeded:');
for (const s of [prod, staging]) {
  console.log(`  ${s.instance.padEnd(8)} ${s.counts.workflows} workflows, ${s.counts.projects} projects, ${s.counts.activated} active, ${s.execSummary.total} executions → ${s.baseUrl}`);
}
console.log('\nOpen both in a browser (owner: nathan@n8n.io / PlaywrightTest123):');
console.log(`  prod     ${INSTANCES.prod.baseUrl}`);
console.log(`  staging  ${INSTANCES.staging.baseUrl}`);
console.log('\nThen run `pnpm verify` to confirm the planted problems are really there.');
