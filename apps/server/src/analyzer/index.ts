import type { N8nWorkflowListItem, WorkflowFacts } from '@argus/shared';
import { manifest as defaultManifest, type Manifest } from './manifest.js';
import { analyzeWorkflow, finalizeFacts } from './facts.js';

/**
 * The deterministic catalog analyzer (S1b). Pure, no LLM, no DB, no network.
 *
 * Two passes, mapping onto the sync engine which holds a whole instance's list at
 * once: pass 1 analyzes each workflow's node graph; pass 2 resolves direct-dependency
 * references against the instance's COMPLETE id set (the precondition that makes
 * broken-detection sound). See resolve.ts for the zero-false-broken guarantee.
 */

export {
  analyzeWorkflow,
  finalizeFacts,
  FACTS_SCHEMA_VERSION,
  type Pass1Facts,
} from './facts.js';
export { coverageOf, type CoverageEntry } from './coverage.js';
export { createManifest, manifest, type Manifest, type ManifestData } from './manifest.js';
export { extractDirectRefs, parseWorkflowId, isExpression, type RawRef } from './refs.js';
export { resolveRef, resolveRefs } from './resolve.js';
export { classifyTrigger } from './triggers.js';
export { systemsForNode, dedupeSystems } from './systems.js';

/**
 * Analyze one instance's full workflow list end-to-end (pass 1 + pass 2).
 * @param items the instance's COMPLETE workflow list (fully paginated).
 * @param complete true only when that list was read without error — gates broken.
 * @returns facts keyed by workflow id.
 */
export function analyzeInstance(
  items: N8nWorkflowListItem[],
  complete: boolean,
  analyzedAt: string,
  manifest: Manifest = defaultManifest,
): Map<string, WorkflowFacts> {
  const idSet = new Set(items.map((w) => w.id));
  const nameById = new Map(items.map((w) => [w.id, w.name] as const));
  const out = new Map<string, WorkflowFacts>();
  for (const w of items) {
    const p = analyzeWorkflow(w, manifest);
    out.set(w.id, finalizeFacts(p, idSet, complete, nameById, analyzedAt));
  }
  return out;
}
