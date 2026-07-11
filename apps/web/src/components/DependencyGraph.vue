<script setup lang="ts">
import { computed, shallowRef, markRaw, watch, nextTick } from 'vue';
import { VueFlow, Handle, Position, MarkerType, type NodeMouseEvent, type VueFlowStore } from '@vue-flow/core';
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
  // Lens emphasis (optional): when set, these nodes stay lit and the rest dim — e.g.
  // the Health lens lights up failing/degraded nodes. Empty/undefined = no emphasis.
  emphasisIds?: Set<string>;
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

/**
 * The node's left accent tells its kind apart at a glance: a workflow shows its health
 * color, a credential shows the secondary (purple) accent, a data table stays neutral.
 * The kind icons (key / database) reinforce it up close.
 */
function accentColor(node: GraphNode): string {
  if (node.kind === 'credential') return 'var(--color--secondary)';
  if (node.kind !== 'workflow') return 'var(--border-color--strong)';
  return healthToken(node.health);
}

const visibleNodes = computed<GraphNode[]>(() =>
  props.archivedHidden ? props.graph.nodes.filter((n) => n.archived !== true) : props.graph.nodes,
);
const visibleIds = computed(() => new Set(visibleNodes.value.map((n) => n.id)));
const visibleEdges = computed<GraphEdge[]>(() =>
  props.graph.edges.filter((e) => visibleIds.value.has(e.source) && visibleIds.value.has(e.target)),
);

const positioned = computed(() => layoutGraph(visibleNodes.value, visibleEdges.value));

const hasHighlight = computed(
  () => props.impactedIds.size > 0 || (props.mcpHighlight && props.reachIds.size > 0) || (props.emphasisIds?.size ?? 0) > 0,
);

const flowNodes = computed(() =>
  positioned.value.map((n) => {
    const impacted = props.impactedIds.has(n.id);
    const reach = props.mcpHighlight && props.reachIds.has(n.id);
    const emphasized = props.emphasisIds?.has(n.id) ?? false;
    const selected = n.id === props.selectedId;
    const dimmed = hasHighlight.value && !impacted && !reach && !emphasized && !selected;
    return {
      id: n.id,
      type: 'argus',
      position: { x: n.x, y: n.y },
      data: { node: n, impacted, reach, emphasized, selected, dimmed },
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

// Zoom / pan affordance — a dense estate needs navigating. Scroll-to-zoom and
// drag-to-pan are native to vue-flow; these buttons make it discoverable and give a
// one-click "fit everything back in view" escape hatch. We capture the live flow
// instance from `pane-ready` so the buttons drive the SAME store vue-flow renders with.
// It MUST be held raw (shallowRef + markRaw): a reactive proxy over the store breaks
// d3-zoom's internal transform, silently no-op'ing zoomIn/zoomOut.
const flow = shallowRef<VueFlowStore | null>(null);

/** The exact bounding box of the laid-out graph — computed, not DOM-measured. */
const graphBounds = computed(() => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of positioned.value) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_WIDTH);
    maxY = Math.max(maxY, n.y + NODE_HEIGHT);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
});

// Custom nodes report their DOM size only after first paint, so vue-flow's
// `fit-view-on-init` races that measurement and sometimes lands at scale 1. We instead
// frame the graph by its *computed* bounds — deterministic, no measurement race — on
// first render and whenever a new scope loads.
function fitAll(): void {
  const b = graphBounds.value;
  if (b && flow.value) flow.value.fitBounds(b, { padding: 0.12 });
}
function onPaneReady(instance: VueFlowStore): void { flow.value = markRaw(instance); nextTick(fitAll); }
watch(() => props.graph, () => nextTick(fitAll));

// Zoom instantly (no transition): a timed d3-zoom transition on a dense graph stalls
// mid-flight and the zoom never lands, so a click would silently do nothing.
function onZoomIn(): void { flow.value?.zoomIn(); }
function onZoomOut(): void { flow.value?.zoomOut(); }
function onFit(): void { fitAll(); }
</script>

<template>
  <div class="graph-canvas" data-testid="graph-canvas">
    <VueFlow
      :nodes="flowNodes"
      :edges="flowEdges"
      :min-zoom="0.05"
      :max-zoom="2"
      :nodes-draggable="false"
      @node-click="onNodeClick"
      @pane-ready="onPaneReady"
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
          <span class="wf-accent" :style="{ background: accentColor(data.node) }" />
          <span class="wf-body">
            <span class="wf-label">
              <svg v-if="data.node.kind === 'credential'" class="wf-kind-ic wf-kind-ic--cred" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6" /><path d="m15.5 7.5 3 3" />
              </svg>
              <svg v-else-if="data.node.kind === 'datatable'" class="wf-kind-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" />
              </svg>
              <span class="wf-label-text">{{ data.node.label }}</span>
            </span>
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

    <div class="graph-controls" role="group" aria-label="Zoom and pan" data-testid="graph-zoom-controls">
      <button type="button" class="gc-btn" aria-label="Zoom in" title="Zoom in" @click="onZoomIn">+</button>
      <button type="button" class="gc-btn" aria-label="Zoom out" title="Zoom out" @click="onZoomOut">&minus;</button>
      <button type="button" class="gc-btn gc-btn--fit" aria-label="Fit graph to view" title="Fit to view" @click="onFit">Fit</button>
    </div>
  </div>
</template>

<style scoped>
.graph-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  /* A definite floor so the canvas never collapses to 0 when an ancestor is height:auto
     (mobile) — a percentage height with no definite parent otherwise resolves to zero. */
  min-height: 420px;
  background: var(--background--subtle);
  border-radius: var(--radius--md);
}

/* Zoom/pan controls — overlaid, token-styled, out of the way bottom-left. */
.graph-controls {
  position: absolute;
  left: var(--spacing--2xs);
  bottom: var(--spacing--2xs);
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: var(--spacing--5xs);
}
.gc-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--border-color);
  background: var(--background--surface);
  color: var(--color--text--shade-1);
  border-radius: var(--radius--md);
  box-shadow: var(--shadow);
  font-size: var(--font-size--sm);
  font-weight: var(--font-weight--bold);
  line-height: 1;
  cursor: pointer;
}
.gc-btn:hover { background: var(--background--hover); }
.gc-btn--fit { font-size: var(--font-size--3xs); font-weight: var(--font-weight--medium); }

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
  display: flex;
  align-items: center;
  gap: var(--spacing--5xs);
  min-width: 0;
  font-weight: var(--font-weight--medium);
  color: var(--color--text--shade-1);
}
.wf-label-text { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Kind marker: a key for credentials, a database for data tables — instantly not-a-flow. */
.wf-kind-ic { width: 13px; height: 13px; flex: 0 0 auto; color: var(--color--text--shade-2, var(--color--text--shade-1)); }
.wf-kind-ic--cred { color: var(--color--secondary); }
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
