import type { N8nNode, N8nWorkflowListItem, RefKind } from '@argus/shared';

/**
 * Direct-dependency extraction (S1b) — the RAW ref shapes, before resolution.
 *
 * This module decides NOTHING about "broken" (that's resolve.ts). It only reads
 * what n8n stored, for the KNOWN reference-bearing node types (a deliberate
 * allow-list, version-aware — never a blind "any node with a workflowId" scan) plus
 * the workflow-level errorWorkflow. Shapes are rule-1 verified in
 * contracts/n8n-16-workflow-list-facts-shape.json.
 */

/** Node types that reference another workflow, by full type → dependency kind. */
const REF_NODE_KINDS: Record<string, RefKind> = {
  'n8n-nodes-base.executeWorkflow': 'subWorkflow',
  '@n8n/n8n-nodes-langchain.toolWorkflow': 'toolWorkflow',
  '@n8n/n8n-nodes-langchain.agentTool': 'agentTool',
};

export interface RawRef {
  kind: RefKind;
  nodeId: string | null;
  nodeName: string | null;
  /** The observed reference mode. */
  mode: 'id' | 'name' | 'list' | 'expression' | 'url' | 'unknown';
  /** Exactly what n8n stored (id, name, or expression text); null if none. */
  rawValue: string | null;
  cachedName: string | null;
  /** rawValue is an n8n expression (`=...` / contains `{{ }}`) — unknowable statically. */
  isExpression: boolean;
  /** The node supplies its sub-workflow inline / by URL (source ≠ database) — dynamic. */
  dynamicSource: boolean;
}

/** True if a stored string value is an n8n expression rather than a literal. */
export function isExpression(value: unknown): boolean {
  return typeof value === 'string' && (value.startsWith('=') || value.includes('{{'));
}

interface ParsedWorkflowId {
  mode: RawRef['mode'];
  rawValue: string | null;
  cachedName: string | null;
  isExpression: boolean;
}

/**
 * Parse a `workflowId` parameter into a normalized shape. Handles BOTH forms:
 *   - typeVersion 1: a bare string id.
 *   - typeVersion ≥1.1: a resource locator { __rl, mode, value, cachedResultName }.
 * Returns null when there is nothing to reference (absent/empty) — the caller emits
 * NO dependency in that case (never a broken one).
 */
export function parseWorkflowId(param: unknown): ParsedWorkflowId | null {
  // Bare string (typeVersion 1).
  if (typeof param === 'string') {
    if (param === '') return null;
    return { mode: 'id', rawValue: param, cachedName: null, isExpression: isExpression(param) };
  }
  // Resource locator object.
  if (param && typeof param === 'object' && '__rl' in (param as Record<string, unknown>)) {
    const rl = param as { mode?: unknown; value?: unknown; cachedResultName?: unknown };
    const rawMode = typeof rl.mode === 'string' ? rl.mode : 'unknown';
    const value = rl.value == null ? null : String(rl.value);
    const cachedName = typeof rl.cachedResultName === 'string' && rl.cachedResultName !== '' ? rl.cachedResultName : null;
    if (value === null || value === '') return null;
    const mode: RawRef['mode'] =
      rawMode === 'id' || rawMode === 'list' || rawMode === 'name' || rawMode === 'expression' || rawMode === 'url'
        ? rawMode
        : 'unknown';
    return { mode, rawValue: value, cachedName, isExpression: isExpression(rl.value) };
  }
  return null;
}

/** Extract one node's outbound reference, if it is a known ref-bearing node type. */
export function refFromNode(node: N8nNode): RawRef | null {
  const kind = REF_NODE_KINDS[node.type];
  if (!kind) return null;

  const params = (node.parameters ?? {}) as Record<string, unknown>;
  const nodeId = node.id ?? null;
  const nodeName = node.name ?? null;

  // executeWorkflow can pull the sub-workflow from an inline definition or a URL
  // (source ≠ database) — there is no stored id to resolve; that's dynamic.
  const source = params.source;
  if (kind === 'subWorkflow' && typeof source === 'string' && source !== 'database') {
    return { kind, nodeId, nodeName, mode: 'unknown', rawValue: null, cachedName: null, isExpression: false, dynamicSource: true };
  }

  const parsed = parseWorkflowId(params.workflowId);
  if (!parsed) return null; // nothing referenced (e.g. agentTool with workflowId=null) — emit nothing.

  return {
    kind,
    nodeId,
    nodeName,
    mode: parsed.mode,
    rawValue: parsed.rawValue,
    cachedName: parsed.cachedName,
    isExpression: parsed.isExpression,
    dynamicSource: false,
  };
}

/**
 * All outbound direct-dependency references for a workflow: every known
 * ref-bearing node, plus the workflow-level `settings.errorWorkflow`.
 */
export function extractDirectRefs(wf: Pick<N8nWorkflowListItem, 'nodes' | 'settings'>): RawRef[] {
  const refs: RawRef[] = [];
  for (const node of wf.nodes ?? []) {
    const ref = refFromNode(node);
    if (ref) refs.push(ref);
  }
  const errorWorkflow = wf.settings?.errorWorkflow;
  if (typeof errorWorkflow === 'string' && errorWorkflow !== '') {
    refs.push({
      kind: 'errorWorkflow',
      nodeId: null,
      nodeName: null,
      mode: 'id',
      rawValue: errorWorkflow,
      cachedName: null,
      isExpression: isExpression(errorWorkflow),
      dynamicSource: false,
    });
  }
  return refs;
}
