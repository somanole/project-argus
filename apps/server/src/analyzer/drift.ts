import type { AnalyzerDrift, WorkflowFacts } from '@argus/shared';
import { manifest as defaultManifest } from './manifest.js';

/**
 * Analyzer-freshness drift (S6.1). Anchored on the ONE signal Argus can verify with
 * its read-only API key — node types in real synced workflows that the vendored
 * manifest doesn't recognize — never on the running n8n version (unreachable with an
 * API key; see contracts/n8n-21). A stale manifest makes the analyzer *incomplete, not
 * wrong* (rule 5), so this is a coverage nudge, never a correctness alarm.
 *
 * Split by namespace decides the call-to-action:
 *  - CORE (n8n-nodes-base.* / @n8n/n8n-nodes-langchain.*) unrecognized → these ship WITH
 *    n8n, so an unknown one almost certainly means the instance runs a newer n8n than the
 *    manifest → regenerate the manifest.
 *  - COMMUNITY / custom (any other namespace) → third-party nodes the source-vendored
 *    manifest can never know; a rebuild WON'T add them → not a regenerate case.
 */

/** Namespaces that ship with n8n itself — an unknown one signals a stale manifest. */
export const CORE_NODE_PREFIXES = ['n8n-nodes-base.', '@n8n/n8n-nodes-langchain.'] as const;

/** How many actual type names to list on the notice before "+N more" (per kind). */
const MAX_LISTED = 6;

/** True when a node type belongs to a core n8n package (vs a community/custom one). */
export function isCoreNodeType(type: string): boolean {
  return CORE_NODE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * Aggregate one connection's per-workflow facts into an advisory drift summary.
 * @param factsList the instance's per-workflow facts (null = a workflow that couldn't
 *   be analyzed at all; it contributes no unknown-node signal here).
 * @param manifestN8nVersion the version the manifest was built for (the only version
 *   Argus knows for certain). Defaults to the vendored manifest's pin.
 */
export function computeAnalyzerDrift(
  factsList: Iterable<WorkflowFacts | null>,
  manifestN8nVersion: string = defaultManifest.n8nVersion,
): AnalyzerDrift {
  const coreTypes = new Set<string>();
  const communityTypes = new Set<string>();
  let coreWorkflows = 0;
  let communityWorkflows = 0;

  for (const facts of factsList) {
    if (!facts) continue;
    const unknown = facts.coverage.unknownNodeTypes;
    if (unknown.length === 0) continue;
    let hasCore = false;
    let hasCommunity = false;
    for (const type of unknown) {
      if (isCoreNodeType(type)) {
        coreTypes.add(type);
        hasCore = true;
      } else {
        communityTypes.add(type);
        hasCommunity = true;
      }
    }
    // Count each workflow at most once per bucket it contributes to.
    if (hasCore) coreWorkflows += 1;
    if (hasCommunity) communityWorkflows += 1;
  }

  // core-drift wins when both kinds are present — the regenerate case is the actionable one.
  const status: AnalyzerDrift['status'] =
    coreTypes.size > 0 ? 'core-drift' : communityTypes.size > 0 ? 'community-only' : 'current';

  // The ACTUAL unrecognized type names, split by kind so each is listed under the message
  // it belongs to. Capped for display; the `types` counts above give the true totals, so
  // the UI can render an honest "+N more" — never an illustrative "e.g." (rule 5).
  const coreExamples = [...coreTypes].sort().slice(0, MAX_LISTED);
  const communityExamples = [...communityTypes].sort().slice(0, MAX_LISTED);

  return {
    manifestN8nVersion,
    status,
    coreUnknown: { types: coreTypes.size, workflows: coreWorkflows },
    communityUnknown: { types: communityTypes.size, workflows: communityWorkflows },
    coreExamples,
    communityExamples,
  };
}
