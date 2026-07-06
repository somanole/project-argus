#!/usr/bin/env node
// Fetch a corpus of REAL public n8n templates for the analyzer robustness harness.
// DEV-ONLY (not run in CI/verify): it writes committed fixtures the offline
// corpus-check reads, so the coverage number is measured against real-world
// diversity without a network dependency at test time.
//
// Source: n8n's public template library (api.n8n.io). We normalize each template to
// the analyzer's list-item input shape (top-level nodes + settings; connections are
// dropped — the analyzer derives facts from nodes/settings only) and strip the
// marketing metadata. Sub-workflow references in templates point at ids that live in
// the author's own instance (not our corpus), which is exactly why the harness runs
// with complete=false: a template is never a complete instance, so broken is never
// claimed. See scripts/corpus-check.mjs.
//
// Usage: node scripts/fetch-corpus.mjs [count]   (default 300)

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'apps/server/src/analyzer/__fixtures__');
const API = 'https://api.n8n.io/templates/workflows';
const TARGET = Number(process.argv[2] ?? 300);
const ROWS = 100;

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // 1) collect ids across pages.
  const ids = [];
  for (let page = 1; ids.length < TARGET; page++) {
    const list = await getJson(`${API}?page=${page}&rows=${ROWS}`);
    const wfs = list.workflows ?? [];
    if (wfs.length === 0) break;
    for (const w of wfs) ids.push(w.id);
    await sleep(150);
  }
  const wanted = ids.slice(0, TARGET);
  console.log(`collected ${wanted.length} template ids; fetching details…`);

  // 2) fetch each detail, normalize to the analyzer's list-item shape.
  const corpus = [];
  let failed = 0;
  for (let i = 0; i < wanted.length; i++) {
    const id = wanted[i];
    try {
      const d = await getJson(`${API}/${id}`);
      const w = d.workflow ?? {};
      const def = w.workflow ?? {};
      const nodes = Array.isArray(def.nodes) ? def.nodes : [];
      corpus.push({
        id: `tpl_${id}`,
        name: w.name ?? `template ${id}`,
        active: false,
        isArchived: false,
        createdAt: w.createdAt ?? '1970-01-01T00:00:00.000Z',
        updatedAt: w.createdAt ?? '1970-01-01T00:00:00.000Z',
        versionId: null,
        shared: [],
        // Analyzer input — keep only the fields it reads.
        nodes: nodes.map((n) => ({
          id: n.id,
          name: n.name,
          type: n.type,
          typeVersion: n.typeVersion,
          disabled: n.disabled,
          webhookId: n.webhookId,
          parameters: n.parameters ?? {},
          credentials: n.credentials,
        })),
        settings: def.settings ?? {},
        triggerCount: undefined,
        tags: [],
      });
    } catch {
      failed++;
    }
    if ((i + 1) % 25 === 0) {
      console.log(`  ${i + 1}/${wanted.length} (${failed} failed)`);
      await sleep(200);
    }
  }

  const outPath = join(OUT_DIR, 'corpus.json');
  await writeFile(outPath, JSON.stringify({ source: API, fetchedCount: corpus.length, workflows: corpus }) + '\n', 'utf8');
  const bytes = (await import('node:fs')).statSync(outPath).size;
  console.log(`wrote ${corpus.length} templates (${failed} failed) → ${outPath} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}

await main();
