import type { McpReach, ImpactedWorkflow } from '@argus/shared';
import type { StoredEdge, GraphWorkflowMeta } from './repo.js';

/**
 * MCP exposure-reach (S5): what an external caller can touch THROUGH an MCP-exposed
 * workflow. Forward reachability over confirmed call edges, unioning the external
 * systems and credentials of every workflow reached. Feeds the "highlight MCP
 * exposure" graph mode and the S4 mcp_exposed_sensitive signal.
 */

const CALL_EDGE_TYPES = new Set(['call', 'tool', 'agent_tool', 'error_workflow']);

/** Systems/credentials considered sensitive when exposed to external agents. */
const SENSITIVE_SYSTEMS = new Set(['stripe', 'salesforce', 'postgres', 'postgresql', 'mysql', 'snowflake']);
export function isSensitiveSystem(name: string): boolean {
  const n = name.toLowerCase();
  return SENSITIVE_SYSTEMS.has(n) || n.includes('postgres') || n.includes('payment') || n.includes('production');
}

const wfKey = (instanceId: string, id: string) => `${instanceId}::${id}`;

export function computeMcpReach(
  edges: StoredEdge[],
  workflows: GraphWorkflowMeta[],
  focus: { instanceId: string; workflowId: string },
  generatedAt: string,
): McpReach {
  const wfByKey = new Map(workflows.map((w) => [wfKey(w.instanceId, w.id), w]));
  const root = wfByKey.get(wfKey(focus.instanceId, focus.workflowId));

  // Forward adjacency over confirmed call edges: caller → callees.
  const forward = new Map<string, StoredEdge[]>();
  for (const e of edges) {
    if (e.confidence !== 'confirmed' || !CALL_EDGE_TYPES.has(e.type)) continue;
    if (e.src.kind !== 'workflow') continue;
    const k = wfKey(e.src.instanceId, e.src.id);
    const arr = forward.get(k) ?? [];
    arr.push(e);
    forward.set(k, arr);
  }

  const reachedWfKeys = new Set<string>([wfKey(focus.instanceId, focus.workflowId)]);
  const reachableWorkflows: ImpactedWorkflow[] = [];
  let frontier = [wfKey(focus.instanceId, focus.workflowId)];
  let hops = 0;
  while (frontier.length) {
    hops += 1;
    const next: string[] = [];
    for (const node of frontier) {
      for (const e of forward.get(node) ?? []) {
        if (e.dst.kind !== 'workflow') continue;
        const key = wfKey(e.dst.instanceId, e.dst.id);
        if (reachedWfKeys.has(key)) continue;
        reachedWfKeys.add(key);
        const w = wfByKey.get(key);
        reachableWorkflows.push({
          instanceId: e.dst.instanceId,
          instanceLabel: w?.instanceLabel ?? e.dst.instanceId,
          workflowId: e.dst.id,
          name: w?.name ?? e.dst.label,
          hops,
        });
        next.push(key);
      }
    }
    frontier = next;
  }

  // Union systems + credentials over the root AND everything it can reach.
  const systems = new Set<string>();
  const credentials = new Set<string>();
  for (const key of reachedWfKeys) {
    const w = wfByKey.get(key);
    if (!w?.facts) continue;
    for (const s of w.facts.systems) if (s.system) systems.add(s.system);
    for (const c of w.facts.credentialRefs) if (c.credentialName) credentials.add(c.credentialName);
  }
  const reachableSystems = [...systems].sort();
  const reachesSensitive = reachableSystems.some(isSensitiveSystem);

  return {
    instanceId: focus.instanceId,
    workflowId: focus.workflowId,
    workflowName: root?.name ?? focus.workflowId,
    reachableWorkflows,
    reachableSystems,
    reachableCredentials: [...credentials].sort(),
    reachesSensitive,
    generatedAt,
  };
}
