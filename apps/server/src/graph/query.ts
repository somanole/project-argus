import type { DependencyGraph, GraphEdge, GraphNode, GraphScope } from '@argus/shared';
import type { StoredEdge, GraphWorkflowMeta } from './repo.js';
import { isAgentWorkflow, nodeIdOf, type NodeIdent } from './build.js';

/**
 * Scoped graph assembly (S5). The estate is never returned as a raw hairball: the
 * full-fleet view is bounded — all cross-instance edges (the money finding) are
 * always kept, plus the highest-degree nodes per instance up to a cap, with
 * `truncated` set honestly when anything was dropped (rule 5 — no silent cap).
 */

/** Max workflow nodes in the estate view before we sample by degree. */
const ESTATE_NODE_CAP = 600;
const DEFAULT_HOPS = 2;

function wfGraphNode(w: GraphWorkflowMeta): GraphNode {
  return {
    id: nodeIdOf({ kind: 'workflow', instanceId: w.instanceId, id: w.id }),
    kind: 'workflow',
    instanceId: w.instanceId,
    instanceLabel: w.instanceLabel,
    label: w.name,
    resourceId: w.id,
    workflowId: w.id,
    health: w.health,
    active: w.active,
    archived: w.archived,
    isAgent: isAgentWorkflow(w.facts),
    brokenRef: w.brokenRef,
    mcpExposed: w.mcpExposed,
  };
}

function resourceGraphNode(ident: NodeIdent, instanceLabel: string): GraphNode {
  return {
    id: nodeIdOf(ident),
    kind: ident.kind,
    instanceId: ident.instanceId,
    instanceLabel,
    label: ident.label,
    resourceId: ident.id,
    workflowId: null,
    health: null,
    active: null,
    archived: null,
    isAgent: null,
    brokenRef: null,
    mcpExposed: null,
  };
}

function toGraphEdge(e: StoredEdge): GraphEdge {
  const source = nodeIdOf(e.src);
  const target = nodeIdOf(e.dst);
  return {
    id: `${source}->${target}:${e.type}`,
    source,
    target,
    type: e.type,
    confidence: e.confidence,
    crossInstance: e.crossInstance,
    reason: e.reason,
  };
}

/**
 * Assemble the nodes referenced by a set of edges (plus a seed set of workflow keys),
 * pulling workflow metadata where known and synthesizing resource nodes for
 * credentials/data tables.
 */
function assemble(
  scope: GraphScope,
  focus: string | null,
  hops: number | null,
  keptEdges: StoredEdge[],
  seedWorkflowKeys: Set<string>,
  wfByKey: Map<string, GraphWorkflowMeta>,
  instanceLabels: Map<string, string>,
  truncated: boolean,
  nodeTotal: number,
  generatedAt: string,
): DependencyGraph {
  const nodes = new Map<string, GraphNode>();
  const addWf = (instanceId: string, id: string) => {
    const w = wfByKey.get(`${instanceId}::${id}`);
    if (w) {
      const gn = wfGraphNode(w);
      nodes.set(gn.id, gn);
    }
  };
  for (const key of seedWorkflowKeys) {
    const [instanceId, id] = key.split('::');
    if (instanceId && id) addWf(instanceId, id);
  }
  for (const e of keptEdges) {
    if (e.src.kind === 'workflow') addWf(e.src.instanceId, e.src.id);
    else nodes.set(nodeIdOf(e.src), resourceGraphNode(e.src, instanceLabels.get(e.src.instanceId) ?? e.src.instanceId));
    if (e.dst.kind === 'workflow') addWf(e.dst.instanceId, e.dst.id);
    else nodes.set(nodeIdOf(e.dst), resourceGraphNode(e.dst, instanceLabels.get(e.dst.instanceId) ?? e.dst.instanceId));
  }
  // Only keep edges whose BOTH endpoints made it into the node set.
  const edges = keptEdges.filter((e) => nodes.has(nodeIdOf(e.src)) && nodes.has(nodeIdOf(e.dst))).map(toGraphEdge);
  return { scope, focus, hops, nodes: [...nodes.values()], edges, truncated, nodeTotal, generatedAt };
}

export interface GraphQuery {
  scope: GraphScope;
  /** workflow node id (wf:inst:id) for neighborhood; instanceId for instance; system name for system. */
  focus?: string | null;
  hops?: number | null;
}

export function buildGraphView(
  workflows: GraphWorkflowMeta[],
  edges: StoredEdge[],
  q: GraphQuery,
  generatedAt: string,
): DependencyGraph {
  const wfByKey = new Map(workflows.map((w) => [`${w.instanceId}::${w.id}`, w]));
  const instanceLabels = new Map(workflows.map((w) => [w.instanceId, w.instanceLabel]));

  if (q.scope === 'neighborhood') {
    const hops = q.hops ?? DEFAULT_HOPS;
    // focus is a workflow composite id wf:instance:id.
    const parsed = parseWorkflowNodeId(q.focus);
    if (!parsed) return empty('neighborhood', q.focus ?? null, hops, generatedAt);
    const start = `${parsed.instanceId}::${parsed.id}`;
    // Undirected adjacency over ALL edges to explore the local neighborhood.
    const adj = new Map<string, StoredEdge[]>();
    const nk = (i: string, id: string) => `${i}::${id}`;
    for (const e of edges) {
      if (e.src.kind === 'workflow') push(adj, nk(e.src.instanceId, e.src.id), e);
      if (e.dst.kind === 'workflow') push(adj, nk(e.dst.instanceId, e.dst.id), e);
    }
    const seen = new Set<string>([start]);
    const kept: StoredEdge[] = [];
    let frontier = [start];
    for (let h = 0; h < hops && frontier.length; h++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const e of adj.get(node) ?? []) {
          kept.push(e);
          for (const end of [e.src, e.dst]) {
            if (end.kind !== 'workflow') continue;
            const key = nk(end.instanceId, end.id);
            if (!seen.has(key)) {
              seen.add(key);
              next.push(key);
            }
          }
        }
      }
      frontier = next;
    }
    return assemble('neighborhood', q.focus ?? null, hops, dedupe(kept), seen, wfByKey, instanceLabels, false, seen.size, generatedAt);
  }

  if (q.scope === 'instance') {
    const instanceId = q.focus ?? null;
    const seed = new Set<string>();
    for (const w of workflows) if (w.instanceId === instanceId) seed.add(`${w.instanceId}::${w.id}`);
    const kept = edges.filter((e) => e.src.instanceId === instanceId && e.dst.instanceId === instanceId);
    return assemble('instance', instanceId, null, kept, seed, wfByKey, instanceLabels, false, seed.size, generatedAt);
  }

  if (q.scope === 'system') {
    const system = (q.focus ?? '').toLowerCase();
    const seed = new Set<string>();
    for (const w of workflows) {
      if ((w.facts?.systems ?? []).some((s) => (s.system ?? '').toLowerCase() === system)) {
        seed.add(`${w.instanceId}::${w.id}`);
      }
    }
    const kept = edges.filter((e) => seed.has(`${e.src.instanceId}::${e.src.id}`) && seed.has(`${e.dst.instanceId}::${e.dst.id}`));
    return assemble('system', q.focus ?? null, null, kept, seed, wfByKey, instanceLabels, false, seed.size, generatedAt);
  }

  // estate: bounded. Always keep cross-instance edges + their endpoints; fill the rest
  // with the highest-degree workflow nodes per instance up to the cap.
  const degree = new Map<string, number>();
  for (const e of edges) {
    if (e.src.kind === 'workflow') degree.set(`${e.src.instanceId}::${e.src.id}`, (degree.get(`${e.src.instanceId}::${e.src.id}`) ?? 0) + 1);
    if (e.dst.kind === 'workflow') degree.set(`${e.dst.instanceId}::${e.dst.id}`, (degree.get(`${e.dst.instanceId}::${e.dst.id}`) ?? 0) + 1);
  }
  const seed = new Set<string>();
  // Cross-instance endpoints are non-negotiable — the point of the estate view.
  for (const e of edges) {
    if (!e.crossInstance) continue;
    if (e.src.kind === 'workflow') seed.add(`${e.src.instanceId}::${e.src.id}`);
    if (e.dst.kind === 'workflow') seed.add(`${e.dst.instanceId}::${e.dst.id}`);
  }
  const ranked = workflows
    .map((w) => `${w.instanceId}::${w.id}`)
    .filter((k) => !seed.has(k))
    .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0));
  const truncated = seed.size + ranked.length > ESTATE_NODE_CAP;
  for (const k of ranked) {
    if (seed.size >= ESTATE_NODE_CAP) break;
    seed.add(k);
  }
  const kept = edges.filter((e) => {
    const s = e.src.kind === 'workflow' ? seed.has(`${e.src.instanceId}::${e.src.id}`) : true;
    const d = e.dst.kind === 'workflow' ? seed.has(`${e.dst.instanceId}::${e.dst.id}`) : true;
    // keep an edge if both its workflow endpoints are in the seed (resource endpoints always ok)
    return s && d;
  });
  return assemble('estate', null, null, kept, seed, wfByKey, instanceLabels, truncated, workflows.length, generatedAt);
}

function empty(scope: GraphScope, focus: string | null, hops: number | null, generatedAt: string): DependencyGraph {
  return { scope, focus, hops, nodes: [], edges: [], truncated: false, nodeTotal: 0, generatedAt };
}

function parseWorkflowNodeId(focus: string | null | undefined): { instanceId: string; id: string } | null {
  if (!focus) return null;
  // wf:<instanceId>:<workflowId> — instanceId is a UUID with no colons, workflowId n8n id has none either.
  const m = focus.match(/^wf:([^:]+):(.+)$/);
  if (!m || !m[1] || !m[2]) return null;
  return { instanceId: m[1], id: m[2] };
}

function push(map: Map<string, StoredEdge[]>, key: string, e: StoredEdge): void {
  const arr = map.get(key) ?? [];
  arr.push(e);
  map.set(key, arr);
}

function dedupe(edges: StoredEdge[]): StoredEdge[] {
  const seen = new Set<string>();
  const out: StoredEdge[] = [];
  for (const e of edges) {
    const k = `${nodeIdOf(e.src)}->${nodeIdOf(e.dst)}:${e.type}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
