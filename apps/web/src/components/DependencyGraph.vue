<script setup lang="ts">
import { computed } from 'vue';
import { VueFlow, Handle, Position, MarkerType, type NodeMouseEvent } from '@vue-flow/core';
import '@vue-flow/core/dist/style.css';
import type { DependencyGraph, GraphNode, GraphEdge } from '@argus/shared';
import { instanceColor } from '../lib/instanceColor';
import { layoutGraph, NODE_WIDTH, NODE_HEIGHT } from '../lib/graphLayout';

const props = defineProps<{
  graph: DependencyGraph;
  selectedId: string | null;
  impactedIds: Set<string>;
  archivedHidden: boolean;
  mcpHighlight: boolean;
  reachIds: Set<string>;
}>();
const emit = defineEmits<{ (e: 'select', node: GraphNode): void }>();

/** Health status → a semantic token background for the node dot / accent. */
function healthToken(health: string | null): string {
  switch (health) {
    case 'failing': return 'var(--color--danger)';
    case 'degraded': return 'var(--color--warning)';
    case 'healthy': return 'var(--color--success)';
    default: return 'var(--border-color--strong)'; // idle / unknown / resource
  }
}

const visibleNodes = computed<GraphNode[]>(() =>
  props.archivedHidden ? props.graph.nodes.filter((n) => n.archived !== true) : props.graph.nodes,
);
const visibleIds = computed(() => new Set(visibleNodes.value.map((n) => n.id)));
const visibleEdges = computed<GraphEdge[]>(() =>
  props.graph.edges.filter((e) => visibleIds.value.has(e.source) && visibleIds.value.has(e.target)),
);

const positioned = computed(() => layoutGraph(visibleNodes.value, visibleEdges.value));

const hasHighlight = computed(() => props.impactedIds.size > 0 || (props.mcpHighlight && props.reachIds.size > 0));

const flowNodes = computed(() =>
  positioned.value.map((n) => {
    const impacted = props.impactedIds.has(n.id);
    const reach = props.mcpHighlight && props.reachIds.has(n.id);
    const selected = n.id === props.selectedId;
    const dimmed = hasHighlight.value && !impacted && !reach && !selected;
    return {
      id: n.id,
      type: 'argus',
      position: { x: n.x, y: n.y },
      data: { node: n, impacted, reach, selected, dimmed },
      draggable: false,
    };
  }),
);

const flowEdges = computed(() =>
  visibleEdges.value.map((e) => {
    const possible = e.confidence === 'possible';
    // A `possible` edge is NEVER highlighted as part of a blast radius (the trust
    // spine): only confirmed edges whose both endpoints are impacted go danger-red.
    const impacted = !possible && props.impactedIds.has(e.source) && props.impactedIds.has(e.target);
    const stroke = e.crossInstance
      ? 'var(--color--primary)'
      : impacted
        ? 'var(--color--danger)'
        : 'var(--border-color--strong)';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      class: `edge edge--${e.type} ${possible ? 'edge--possible' : 'edge--confirmed'} ${e.crossInstance ? 'edge--cross' : ''}`,
      animated: e.crossInstance,
      markerEnd: MarkerType.ArrowClosed,
      style: {
        stroke,
        strokeWidth: e.crossInstance ? 2.5 : impacted ? 2 : 1.2,
        strokeDasharray: possible ? '5 4' : undefined,
      },
      data: e,
    };
  }),
);

function onNodeClick(evt: NodeMouseEvent): void {
  const gn = (evt.node.data as { node: GraphNode } | undefined)?.node;
  if (gn) emit('select', gn);
}
</script>

<template>
  <div class="graph-canvas" data-testid="graph-canvas">
    <VueFlow
      :nodes="flowNodes"
      :edges="flowEdges"
      :min-zoom="0.05"
      :max-zoom="2"
      fit-view-on-init
      :nodes-draggable="false"
      @node-click="onNodeClick"
    >
      <template #node-argus="{ data }">
        <div
          class="wf-node"
          :class="{
            'wf-node--selected': data.selected,
            'wf-node--impacted': data.impacted,
            'wf-node--reach': data.reach,
            'wf-node--dimmed': data.dimmed,
            'wf-node--archived': data.node.archived,
            'wf-node--resource': data.node.kind !== 'workflow',
            'wf-node--mcp': mcpHighlight && data.node.mcpExposed,
          }"
          :style="{ width: `${NODE_WIDTH}px`, minHeight: `${NODE_HEIGHT}px` }"
          :data-testid="`graph-node-${data.node.kind}`"
          :data-node-id="data.node.id"
          :title="`${data.node.label} · ${data.node.instanceLabel}`"
        >
          <Handle type="target" :position="Position.Left" class="wf-handle" />
          <span class="wf-accent" :style="{ background: data.node.kind === 'workflow' ? healthToken(data.node.health) : 'var(--border-color--strong)' }" />
          <span class="wf-body">
            <span class="wf-label">{{ data.node.label }}</span>
            <span class="wf-meta">
              <span class="wf-inst-dot" :style="{ background: instanceColor(data.node.instanceId) }" />
              <span class="wf-inst">{{ data.node.instanceLabel }}</span>
              <span v-if="data.node.kind === 'credential'" class="wf-tag">credential</span>
              <span v-else-if="data.node.kind === 'datatable'" class="wf-tag">data&nbsp;table</span>
              <span v-if="data.node.isAgent" class="wf-tag wf-tag--agent">agent</span>
              <span v-if="data.node.mcpExposed" class="wf-tag wf-tag--mcp">MCP</span>
              <span v-if="data.node.brokenRef" class="wf-tag wf-tag--broken">broken&nbsp;ref</span>
              <span v-if="data.node.archived" class="wf-tag">archived</span>
            </span>
          </span>
          <Handle type="source" :position="Position.Right" class="wf-handle" />
        </div>
      </template>
    </VueFlow>
  </div>
</template>

<style scoped>
.graph-canvas {
  width: 100%;
  height: 100%;
  /* A definite floor so the canvas never collapses to 0 when an ancestor is height:auto
     (mobile) — a percentage height with no definite parent otherwise resolves to zero. */
  min-height: 420px;
  background: var(--background--subtle);
  border-radius: var(--radius--md);
}

/* vue-flow fills the canvas box; structural CSS is imported, colors overridden by tokens. */
:deep(.vue-flow) { width: 100%; height: 100%; min-height: 420px; }

/* vue-flow structural CSS is imported; we override colors with tokens (rule 10). */
:deep(.vue-flow__background) { background: var(--background--subtle); }
:deep(.vue-flow__edge-path) { transition: stroke 0.15s ease; }
:deep(.vue-flow__handle) { opacity: 0; pointer-events: none; }
:deep(.vue-flow__node) { cursor: pointer; }

.wf-node {
  display: flex;
  align-items: stretch;
  gap: 0;
  background: var(--background--surface);
  border: 1px solid var(--border-color);
  border-radius: var(--radius--md);
  overflow: hidden;
  box-shadow: var(--shadow);
  font-size: var(--font-size--3xs);
}
.wf-node--resource { border-style: dashed; background: var(--background--subtle); }
.wf-node--selected { border-color: var(--background--brand); box-shadow: 0 0 0 2px var(--background--brand); }
.wf-node--impacted { border-color: var(--color--danger); box-shadow: 0 0 0 2px var(--color--danger); }
.wf-node--reach { border-color: var(--color--primary); box-shadow: 0 0 0 2px var(--color--primary); }
.wf-node--mcp { border-color: var(--color--primary); }
.wf-node--archived { opacity: 0.5; }
.wf-node--dimmed { opacity: 0.28; }

.wf-accent { width: 5px; flex: 0 0 auto; }
.wf-body { display: flex; flex-direction: column; gap: 2px; padding: var(--spacing--4xs) var(--spacing--2xs); min-width: 0; justify-content: center; }
.wf-label {
  font-weight: var(--font-weight--medium);
  color: var(--color--text--shade-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}
.wf-meta { display: flex; align-items: center; gap: var(--spacing--4xs); flex-wrap: wrap; }
.wf-inst-dot { width: 7px; height: 7px; border-radius: var(--radius--full); flex: 0 0 auto; }
.wf-inst { color: var(--color--text--shade-2, var(--color--text--shade-1)); opacity: 0.75; }
.wf-tag {
  font-size: var(--font-size--4xs);
  padding: 0 var(--spacing--5xs);
  border-radius: var(--radius--2xs, var(--radius--md));
  background: var(--background--subtle);
  color: var(--color--text--shade-1);
  border: 1px solid var(--border-color--subtle);
}
.wf-tag--agent { background: var(--background--primary, var(--background--subtle)); }
.wf-tag--mcp { border-color: var(--color--primary); color: var(--color--primary); }
.wf-tag--broken { border-color: var(--color--danger); color: var(--color--danger); }
</style>
