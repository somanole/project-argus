import type { N8nWorkflowListItem, WorkflowFacts } from '@argus/shared';
import { redactDeep } from '../llm/index.js';

/**
 * Build the STRICT enrichment allowlist — the only thing that ever leaves Argus for a
 * workflow (DECISION #7 & #26). Built by INCLUSION (never "workflow JSON minus
 * secrets"): each field below is copied in deliberately; everything else — raw
 * parameter values, pinned data, execution data, and every URL / hostname / domain —
 * simply never enters. External-system identity comes from credential-/node-derived
 * systems (never URL-derived). A redaction backstop then scrubs the free-text that does
 * leave (name, tags, node names). Returns the input plus how many redactions fired.
 */

export interface FailureStats {
  last30dRuns: number;
  failures: number;
}

export interface EnrichmentInput {
  name: string;
  project: string | null;
  tags: string[];
  triggerTypes: string[];
  /** Node NAMES + TYPES only — never parameters. */
  nodes: Array<{ name: string; type: string }>;
  /** Shape-only topology (counts), no names or URLs. */
  topology: string;
  credentialTypes: string[];
  /** Credential-/node-derived systems only (DECISION #26 — nothing URL-derived). */
  systems: string[];
  failureStats: FailureStats | null;
  facts: {
    nodeCount: number;
    mcpExposed: boolean;
    brokenRefCount: number;
    understood: boolean;
  };
}

export interface BuildContext {
  project: string | null;
  failureStats?: FailureStats | null;
}

export function buildEnrichmentInput(
  wf: N8nWorkflowListItem,
  facts: WorkflowFacts,
  ctx: BuildContext,
): { input: EnrichmentInput; redactions: number; redactedKinds: string[] } {
  const nodes = (wf.nodes ?? [])
    .filter((n) => !n.disabled)
    .map((n) => ({ name: n.name ?? '(unnamed)', type: n.type })); // NO parameters, ever

  // Systems: credential- or node-derived only, resolved, de-duplicated. URL-derived
  // systems (if the analyzer ever adds them) are excluded here by construction.
  const systems = [
    ...new Set(
      facts.systems
        .filter((s) => s.resolved && s.system !== null && (s.via === 'credential' || s.via === 'node'))
        .map((s) => s.system as string),
    ),
  ].sort();

  const brokenRefCount = facts.directDeps.filter((d) => d.resolution === 'broken').length;

  const raw: EnrichmentInput = {
    name: wf.name,
    project: ctx.project,
    tags: (wf.tags ?? []).map((t) => t.name),
    triggerTypes: facts.triggers.map((t) => t.type),
    nodes,
    topology: topologySummary(wf, facts),
    credentialTypes: [...facts.credentialTypes].sort(),
    systems,
    failureStats: ctx.failureStats ?? null,
    facts: {
      nodeCount: facts.nodeCount,
      mcpExposed: facts.mcpExposed,
      brokenRefCount,
      understood: facts.coverage.understood,
    },
  };

  // Defence-in-depth backstop over every string (name, tags, node names). Params/URLs
  // never entered, so this is belt-and-suspenders, not the primary control.
  const { value, count, kinds } = redactDeep(raw);
  return { input: value, redactions: count, redactedKinds: kinds };
}

/** A shape-only summary of the connection graph — counts, never names or URLs. */
function topologySummary(wf: N8nWorkflowListItem, facts: WorkflowFacts): string {
  const nodeCount = facts.nodeCount;
  const triggers = facts.triggerCountDetected;
  const conns = wf.connections ?? {};
  let edges = 0;
  let branching = false;
  for (const out of Object.values(conns)) {
    // n8n shape: { main: [ [ {node,...}, ... ], ... ] }
    const main = (out as { main?: unknown[][] } | undefined)?.main;
    if (Array.isArray(main)) {
      for (const branch of main) {
        if (Array.isArray(branch)) {
          edges += branch.length;
          if (branch.length > 1) branching = true;
        }
      }
      if (main.filter((b) => Array.isArray(b) && b.length > 0).length > 1) branching = true;
    }
  }
  const shape = branching ? 'branching' : 'linear';
  return `${nodeCount} nodes, ${triggers} trigger(s), ${edges} connection(s), ${shape}`;
}
