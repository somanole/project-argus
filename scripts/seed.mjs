#!/usr/bin/env node
// pnpm seed — the one command. Ensures both n8n instances are up (launching them
// if needed), seeds prod, seeds staging (plus the cross-instance bridge), and
// prints where to look. Idempotent: safe to re-run any time.

import { ensureAll, INSTANCES } from './lib/launch.mjs';
import { seedInstance } from './lib/seed-runtime.mjs';
import { crossInstanceBridge } from './seed/estate.mjs';

console.log('Seeding the Argus n8n estate (prod + staging)…\n');

console.log('1/3  Ensuring both instances are up');
await ensureAll();

console.log('\n2/3  Seeding prod');
const prod = await seedInstance(INSTANCES.prod);

console.log('\n3/3  Seeding staging (+ cross-instance bridge)');
const staging = await seedInstance(INSTANCES.staging, {
  extraWorkflows: [crossInstanceBridge(INSTANCES.prod.baseUrl)],
});

console.log('\nEstate seeded:');
for (const s of [prod, staging]) {
  console.log(`  ${s.instance.padEnd(8)} ${s.counts.workflows} workflows, ${s.counts.projects} projects, ${s.counts.activated} active, ${s.execSummary.total} executions → ${s.baseUrl}`);
}
console.log('\nOpen both in a browser (owner: nathan@n8n.io / PlaywrightTest123):');
console.log(`  prod     ${INSTANCES.prod.baseUrl}`);
console.log(`  staging  ${INSTANCES.staging.baseUrl}`);
console.log('\nThen run `pnpm verify` to confirm the planted problems are really there.');
