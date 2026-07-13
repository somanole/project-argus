import type { CanMaskFailures, MaskReason, N8nNode, N8nWorkflowListItem } from '@argus/shared';

/**
 * S6.3 Layer 1 — the deterministic "can mask failures" config-risk detector. Pure; reads
 * ONLY the workflow JSON (no LLM, no execution history). A workflow "can mask failures"
 * when an enabled node is configured so a node error would be swallowed instead of failing
 * the run:
 *  - `onError: 'continueRegularOutput'` (or the legacy `continueOnFail: true`) — the error is
 *    merged into the normal output and the run continues green (contracts/n8n-23 confirms
 *    n8n marks such a node `executionStatus: 'success'`).
 *  - `onError: 'continueErrorOutput'` whose error output DEAD-ENDS (no downstream node) — the
 *    error is routed to a branch that goes nowhere. A CONNECTED error output is real handling,
 *    NOT a mask, so it does not trigger the flag.
 *
 * This is advisory config-risk — it says a workflow *can* hide a failure, never that it *has*
 * (rule 12 discipline: advisory, never a factual claim). Honest when unparsed: if the node
 * graph is absent, `flagged` is false with no reasons (rule 5), never a fabricated risk.
 */
export function detectCanMaskFailures(wf: N8nWorkflowListItem): CanMaskFailures {
  const nodes: N8nNode[] = Array.isArray(wf.nodes) ? wf.nodes : [];
  const connections = (wf.connections as Record<string, unknown> | undefined) ?? {};
  const reasons: MaskReason[] = [];

  for (const node of nodes) {
    if (node.disabled === true) continue;
    // onError / continueOnFail ride through N8nNode's passthrough (not pinned fields).
    const raw = node as Record<string, unknown>;
    const onError = raw.onError;
    const continueOnFail = raw.continueOnFail;
    const nodeName = node.name ?? node.id ?? 'unknown node';

    if (onError === 'continueRegularOutput') {
      reasons.push({ nodeName, mechanism: 'continue-regular-output' });
    } else if (continueOnFail === true) {
      reasons.push({ nodeName, mechanism: 'legacy-continue-on-fail' });
    } else if (onError === 'continueErrorOutput' && errorBranchDeadEnds(connections, node.name)) {
      reasons.push({ nodeName, mechanism: 'dead-end-error-branch' });
    }
  }

  const noErrorWorkflow = !(typeof wf.settings?.errorWorkflow === 'string' && wf.settings.errorWorkflow !== '');
  return { flagged: reasons.length > 0, reasons, noErrorWorkflow };
}

/**
 * n8n appends the error output as a SECOND `main` output (index 1) when a node is set to
 * `continueErrorOutput`. It dead-ends when that output has no outgoing connection — i.e.
 * `connections[node].main[1]` is absent or empty. Index 0 (the regular output) is ignored.
 */
function errorBranchDeadEnds(connections: Record<string, unknown>, nodeName: string | undefined): boolean {
  if (!nodeName) return true;
  const nodeConns = connections[nodeName] as { main?: unknown[] } | undefined;
  const main = nodeConns?.main;
  const errorOutput = Array.isArray(main) ? main[1] : undefined;
  return !Array.isArray(errorOutput) || errorOutput.length === 0;
}
