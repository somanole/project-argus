import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  dependencyGraphSchema,
  impactResultSchema,
  mcpReachSchema,
  type DependencyGraph,
  type GraphNode,
  type GraphScope,
  type ImpactResult,
  type McpReach,
} from '@argus/shared';
import { api } from '../lib/api';

/**
 * The S5 dependency-graph store. Loads a scoped graph view and, on selecting a node,
 * the edge-type-aware blast radius (confirmed-only totals — the trust spine lives in
 * the server; the UI just renders the honest answer). Honest states only (rule 5):
 * an error holds a plain-English reason and we never invent edges the server didn't send.
 */
export const useGraphStore = defineStore('graph', () => {
  const graph = ref<DependencyGraph | null>(null);
  const state = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const error = ref<string | null>(null);

  const scope = ref<GraphScope>('estate');
  const focus = ref<string | null>(null);

  const selectedNode = ref<GraphNode | null>(null);
  const impact = ref<ImpactResult | null>(null);
  const impactState = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');

  const mcpReach = ref<McpReach | null>(null);

  async function load(next?: { scope?: GraphScope; focus?: string | null; hops?: number }): Promise<void> {
    if (next?.scope) scope.value = next.scope;
    if (next && 'focus' in next) focus.value = next.focus ?? null;
    if (state.value === 'idle' || state.value === 'error') state.value = 'loading';
    try {
      const qs = new URLSearchParams({ scope: scope.value });
      if (focus.value) qs.set('focus', focus.value);
      if (next?.hops) qs.set('hops', String(next.hops));
      graph.value = await api(`/api/graph?${qs.toString()}`, {}, dependencyGraphSchema);
      state.value = 'ok';
      error.value = null;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not load the graph';
    }
  }

  /** Select a node and compute its blast radius (workflow → failure; credential → rotation). */
  async function selectNode(node: GraphNode): Promise<void> {
    selectedNode.value = node;
    mcpReach.value = null;
    const mode = node.kind === 'credential' ? 'credential_rotation' : node.kind === 'workflow' ? 'failure' : null;
    if (!mode) {
      impact.value = null;
      impactState.value = 'idle';
      return;
    }
    impactState.value = 'loading';
    try {
      const qs = new URLSearchParams({ mode, instanceId: node.instanceId, id: node.resourceId });
      impact.value = await api(`/api/graph/impact?${qs.toString()}`, {}, impactResultSchema);
      impactState.value = 'ok';
    } catch {
      impactState.value = 'error';
      impact.value = null;
    }
  }

  /** For MCP-exposure highlight: what an exposed workflow can reach. */
  async function loadMcpReach(node: GraphNode): Promise<void> {
    if (node.kind !== 'workflow' || !node.workflowId) return;
    try {
      const qs = new URLSearchParams({ instanceId: node.instanceId, id: node.workflowId });
      mcpReach.value = await api(`/api/graph/mcp-reach?${qs.toString()}`, {}, mcpReachSchema);
    } catch {
      mcpReach.value = null;
    }
  }

  function clearSelection(): void {
    selectedNode.value = null;
    impact.value = null;
    impactState.value = 'idle';
    mcpReach.value = null;
  }

  return {
    graph,
    state,
    error,
    scope,
    focus,
    selectedNode,
    impact,
    impactState,
    mcpReach,
    load,
    selectNode,
    loadMcpReach,
    clearSelection,
  };
});
