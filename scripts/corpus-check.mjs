#!/usr/bin/env node
// Offline analyzer robustness harness (S1b). Runs the REAL analyzer over the
// committed corpus of ~260 real public templates and reports:
//   - % fully understood (every node type recognized, no parse anomaly),
//   - the ranked long tail of node types it can't recognize (community packages),
//   - the zero-false-broken guarantee, proved two ways.
//
// Hermetic: reads committed fixtures, no network. Exported for scripts/verify.mjs.
//
// Zero-false-broken, proved two ways:
//   (A) The corpus is a BAG of unrelated templates — never a complete instance. Run
//       with complete=false: broken is structurally impossible, so we assert 0 broken
//       — the analyzer never cries "broken" when it can't see the whole instance.
//   (B) Treating the corpus as one synthetic instance (complete=true), we independently
//       re-derive the broken predicate (mode∈{id,list} ∧ literal ∧ absent) and assert
//       the analyzer agrees on EVERY broken, and never marks a non-id/expression broken.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyzeInstance, isExpression } from '../apps/server/dist/analyzer/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'apps/server/src/analyzer/__fixtures__/corpus.json');
const AT = '2026-01-01T00:00:00.000Z';

export function runCorpusCheck() {
  const { workflows } = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const total = workflows.length;

  // (A) complete=false — the real-world posture: never claim broken.
  const factsIncomplete = analyzeInstance(workflows, false, AT);
  let brokenIncomplete = 0;
  let understood = 0;
  const unknownTypeWorkflows = new Map();
  let anomalies = 0;
  let dynamicRefs = 0;
  let unresolvedRefs = 0;

  for (const w of workflows) {
    const f = factsIncomplete.get(w.id);
    const hasParseAnomaly = f.coverage.reasons.some((r) => r.kind === 'parseAnomaly');
    if (hasParseAnomaly) anomalies++;
    // "Understood" for a bag of templates = every node type recognized + no parse
    // anomaly. (Cross-instance sub-refs are unresolvable here by nature, so they don't
    // count against node understanding.)
    if (f.coverage.unknownNodeTypes.length === 0 && !hasParseAnomaly) understood++;
    for (const t of f.coverage.unknownNodeTypes) unknownTypeWorkflows.set(t, (unknownTypeWorkflows.get(t) ?? 0) + 1);
    for (const d of f.directDeps) {
      if (d.resolution === 'broken') brokenIncomplete++;
      if (d.resolution === 'dynamic') dynamicRefs++;
      if (d.resolution === 'unresolved') unresolvedRefs++;
    }
  }

  // (B) complete=true — re-derive the broken predicate independently.
  const factsComplete = analyzeInstance(workflows, true, AT);
  const idSet = new Set(workflows.map((w) => w.id));
  let brokenComplete = 0;
  const falseBroken = []; // any broken that fails the independent re-derivation
  for (const w of workflows) {
    for (const d of factsComplete.get(w.id).directDeps) {
      if (d.resolution !== 'broken') continue;
      brokenComplete++;
      const legit = (d.mode === 'id' || d.mode === 'list') && !isExpression(d.rawValue) && d.rawValue != null && !idSet.has(d.rawValue);
      if (!legit) falseBroken.push({ workflow: w.name, dep: d });
    }
  }

  const unknownNodeTypes = [...unknownTypeWorkflows.entries()]
    .map(([type, workflows]) => ({ type, workflows }))
    .sort((a, b) => b.workflows - a.workflows || a.type.localeCompare(b.type));

  const understoodPct = total === 0 ? 100 : Math.round((understood / total) * 1000) / 10;

  return {
    total,
    understood,
    understoodPct,
    anomalies,
    dynamicRefs,
    unresolvedRefs,
    brokenIncomplete, // must be 0 (the real-world guard)
    brokenComplete, // informational: cross-template "absent" ids under a synthetic complete set
    falseBroken, // must be empty (independent re-derivation agrees)
    unknownNodeTypes,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runCorpusCheck();
  console.log(`\nCorpus robustness — ${r.total} real public templates`);
  console.log(`  understands ${r.understoodPct}% (${r.understood}/${r.total}) — every node type recognized, no parse anomaly`);
  console.log(`  zero-false-broken: complete=false broken=${r.brokenIncomplete} (must be 0); re-derivation false-broken=${r.falseBroken.length} (must be 0)`);
  console.log(`  refs: dynamic=${r.dynamicRefs}, unresolved=${r.unresolvedRefs}, synthetic-complete broken=${r.brokenComplete}`);
  console.log(`  top unrecognized node types (community/custom long tail):`);
  for (const u of r.unknownNodeTypes.slice(0, 15)) console.log(`    ${u.workflows.toString().padStart(3)}×  ${u.type}`);
  console.log(`  distinct unrecognized types: ${r.unknownNodeTypes.length}`);
}
