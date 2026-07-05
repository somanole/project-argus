#!/usr/bin/env node
// pnpm seed:unlock — re-apply the E2E license flags + quotas to both instances.
// They live in memory and are lost on an n8n restart or reset; this fixes an
// intact-but-locked estate without touching the seeded data.

import { createN8nClient } from './lib/n8n-client.mjs';
import { INSTANCES } from './lib/launch.mjs';

let failures = 0;
for (const inst of Object.values(INSTANCES)) {
  const client = createN8nClient(inst.baseUrl);
  if (!(await client.healthy())) {
    console.error(`✘ ${inst.name}: not reachable at ${inst.baseUrl} — run \`pnpm n8n:up\` first`);
    failures++;
    continue;
  }
  if (!(await client.e2eActive())) {
    console.error(`✘ ${inst.name}: E2E endpoints inactive — is it running with E2E_TESTS=true?`);
    failures++;
    continue;
  }
  await client.unlock();
  console.log(`✔ ${inst.name}: re-applied license flags + quotas at ${inst.baseUrl}`);
}
process.exit(failures === 0 ? 0 : 1);
