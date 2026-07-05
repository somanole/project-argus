#!/usr/bin/env node
// pnpm n8n:up — launch the two managed n8n instances (prod + staging) and wait
// until both are healthy. This is what `pnpm seed` calls internally; run it on its
// own when you just want the estate's instances up (e.g. to browse them).

import { ensureAll, INSTANCES } from './lib/launch.mjs';

console.log('Bringing up the Argus n8n estate (prod + staging)…\n');
const outcomes = await ensureAll();
console.log('\nBoth instances healthy:');
for (const inst of Object.values(INSTANCES)) {
  console.log(`  ${inst.name.padEnd(8)} ${outcomes[inst.name].padEnd(8)} ${inst.baseUrl}`);
}
console.log('\nLog in with nathan@n8n.io / PlaywrightTest123 (owner).');
