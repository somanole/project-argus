<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { workflowDetailSchema, type GraphNode, type GraphScope, type WorkflowListItem } from '@argus/shared';
import { useGraphStore } from '../stores/graph';
import { api } from '../lib/api';
import DependencyGraph from '../components/DependencyGraph.vue';
import WorkflowDetailDrawer from '../components/WorkflowDetailDrawer.vue';

/**
 * S5 hero view: the fleet-wide dependency graph + blast-radius highlight. Scoped
 * views keep it navigable at fleet scale; nodes are health-colored, cross-instance
 * edges are prominent, `possible` edges are dashed, and clicking a node shows the
 * edge-type-aware impact answer with an explicit total (rule 5 — no invented numbers).
 */
// Rendered standalone at /graph OR embedded as the Estate's "graph" representation. When
// embedded the Estate's lens tabs are the header (so the h1 is hidden) and the current
// lens can emphasize a subset of nodes.
const props = withDefaults(defineProps<{ embedded?: boolean; lens?: 'explore' | 'health' | 'ownership' }>(), {
  embedded: false,
  lens: 'explore',
});

const graph = useGraphStore();

const archivedHidden = ref(true);

// Lens emphasis: the Health lens lights up failing/degraded nodes ("blast radius of what's
// broken") and dims the rest; other lenses show the full map. (Ownership emphasis would
// need owner data on the graph nodes — a follow-up.)
const emphasisIds = computed(() => {
  const s = new Set<string>();
  if (props.lens === 'health' && graph.graph) {
    for (const n of graph.graph.nodes) {
      if (n.kind === 'workflow' && (n.health === 'failing' || n.health === 'degraded')) s.add(n.id);
    }
  }
  return s;
});

const instanceOptions = ref<{ id: string; label: string }[]>([]);
const systemOptions = ref<string[]>([]);
const instancePick = ref<string>('');
const systemPick = ref<string>('');

const scopes: { value: GraphScope; label: string }[] = [
  { value: 'estate', label: 'Estate' },
  { value: 'instance', label: 'Instance' },
  { value: 'system', label: 'System' },
];

onMounted(async () => {
  await graph.load({ scope: 'estate', focus: null });
  try {
    const conns = await api<{ connections: { id: string; label: string }[] }>('/api/connections');
    instanceOptions.value = conns.connections.map((c) => ({ id: c.id, label: c.label }));
    instancePick.value = instanceOptions.value[0]?.id ?? '';
  } catch { /* dropdown simply stays empty */ }
  try {
    const wf = await api<{ facets: { systems: { value: string }[] } }>('/api/workflows');
    systemOptions.value = wf.facets.systems.map((s) => s.value);
    systemPick.value = systemOptions.value[0] ?? '';
  } catch { /* dropdown simply stays empty */ }
});

async function pickScope(scope: GraphScope): Promise<void> {
  graph.clearSelection();
  if (scope === 'estate') return graph.load({ scope, focus: null });
  if (scope === 'instance') return graph.load({ scope, focus: instancePick.value });
  if (scope === 'system') return graph.load({ scope, focus: systemPick.value });
}

const panelRef = ref<HTMLElement | null>(null);
function onSelect(node: GraphNode): void {
  graph.selectNode(node);
  // On stacked (mobile) layouts the detail panel sits below the canvas — bring it into
  // view so the selection's blast radius is visible without a manual scroll.
  if (window.matchMedia('(max-width: 900px)').matches) {
    void nextTick(() => panelRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
}

// Clicking the selected workflow or any workflow in its blast radius opens the shared
// detail drawer. We fetch the authoritative list item (`detail.workflow`) rather than
// fabricate one from the lean graph node — the drawer then loads full facts itself.
const drawerSelected = ref<WorkflowListItem | null>(null);
const drawerError = ref<string | null>(null);
async function openWorkflowDetail(instanceId: string, workflowId: string | null): Promise<void> {
  if (!workflowId) return;
  drawerError.value = null;
  try {
    const path = `/api/workflows/${encodeURIComponent(instanceId)}/${encodeURIComponent(workflowId)}`;
    const detail = await api(path, {}, workflowDetailSchema);
    drawerSelected.value = detail.workflow;
  } catch {
    drawerError.value = 'Couldn’t open workflow details.';
  }
}

const impactedIds = computed(() => {
  const s = new Set<string>();
  if (graph.impact && graph.selectedNode) {
    s.add(graph.selectedNode.id);
    for (const a of graph.impact.affected) s.add(`wf:${a.instanceId}:${a.workflowId}`);
  }
  return s;
});
const sel = computed(() => graph.selectedNode);
</script>

<template>
  <section class="graph-view" :class="{ embedded }" data-testid="graph-view">
    <header class="head">
      <div v-if="!embedded" class="titles">
        <h1>Relationships &amp; blast radius</h1>
      </div>
      <div v-if="graph.graph" class="counts">
        <span>{{ graph.graph.nodeTotal }} workflows</span>
        <span v-if="graph.graph.truncated" class="muted" title="Estate view is capped for scale; cross-instance edges always shown.">· view capped</span>
      </div>
    </header>

    <div class="controls">
      <div class="scope-switch" role="group" aria-label="Graph scope" data-testid="graph-scope-switcher">
        <button
          v-for="s in scopes"
          :key="s.value"
          type="button"
          class="chip"
          :class="{ 'chip--active': graph.scope === s.value }"
          :data-testid="`graph-scope-${s.value}`"
          @click="pickScope(s.value)"
        >
          {{ s.label }}
        </button>
      </div>

      <select v-if="graph.scope === 'instance'" v-model="instancePick" class="input input--sm" data-testid="graph-instance-pick" @change="graph.load({ scope: 'instance', focus: instancePick })">
        <option v-for="o in instanceOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
      </select>
      <select v-if="graph.scope === 'system'" v-model="systemPick" class="input input--sm" data-testid="graph-system-pick" @change="graph.load({ scope: 'system', focus: systemPick })">
        <option v-for="o in systemOptions" :key="o" :value="o">{{ o }}</option>
      </select>

      <div class="spacer" />

      <label class="toggle" data-testid="graph-archived-toggle">
        <input v-model="archivedHidden" type="checkbox">
        Hide archived
      </label>
    </div>

    <div class="legend" data-testid="graph-legend">
      <span class="lg"><span class="swatch swatch--ok" /> healthy</span>
      <span class="lg"><span class="swatch swatch--warn" /> degraded</span>
      <span class="lg"><span class="swatch swatch--danger" /> failing</span>
      <span class="lg"><span class="swatch swatch--muted" /> idle</span>
      <span class="lg">
        <svg class="lg-key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6" /><path d="m15.5 7.5 3 3" />
        </svg> credential
      </span>
      <span class="lg"><span class="line line--confirmed" /> confirmed</span>
      <span class="lg"><span class="line line--possible" /> possible</span>
      <span class="lg"><span class="line line--cross" /> cross-instance</span>
    </div>

    <div class="stage">
      <div class="canvas-wrap">
        <p v-if="graph.state === 'loading'" class="state muted">Loading the graph…</p>
        <p v-else-if="graph.state === 'error'" class="state err">Couldn't load the graph — {{ graph.error }}</p>
        <p v-else-if="graph.graph && graph.graph.nodes.length === 0" class="state muted">
          Nothing to show here yet.
        </p>
        <DependencyGraph
          v-else-if="graph.graph"
          :graph="graph.graph"
          :selected-id="sel?.id ?? null"
          :impacted-ids="impactedIds"
          :archived-hidden="archivedHidden"
          :emphasis-ids="emphasisIds"
          @select="onSelect"
          @deselect="graph.clearSelection()"
        />
      </div>

      <aside ref="panelRef" class="panel" data-testid="graph-impact-panel">
        <template v-if="sel">
          <div class="p-head">
            <button
              v-if="sel.kind === 'workflow'"
              type="button"
              class="p-title p-title--link"
              data-testid="graph-panel-open-detail"
              title="Open workflow details"
              @click="openWorkflowDetail(sel.instanceId, sel.workflowId)"
            >
              {{ sel.label }}<span class="ext" aria-hidden="true"> ↗</span>
            </button>
            <h2 v-else class="p-title">{{ sel.label }}</h2>
            <button type="button" class="p-clear" data-testid="graph-panel-clear" title="Clear selection" @click="graph.clearSelection()">Unselect</button>
          </div>
          <p class="p-sub muted">
            {{ sel.kind === 'workflow' ? 'workflow' : sel.kind === 'credential' ? 'credential' : 'data table' }} · {{ sel.instanceLabel }}
          </p>
          <p v-if="drawerError" class="drawer-err small" data-testid="graph-detail-error">{{ drawerError }}</p>

          <div v-if="graph.impactState === 'loading'" class="muted">Computing blast radius…</div>
          <div v-else-if="graph.impact" class="impact">
            <p class="impact-headline" data-testid="graph-impact-statement">
              {{ graph.impact.mode === 'credential_rotation' ? 'Rotating this credential affects' : 'If this fails' }}:
              <strong data-testid="graph-impact-total">{{ graph.impact.total }}</strong>
              {{ graph.impact.total === 1 ? 'workflow' : 'workflows' }}.
            </p>
            <p v-if="graph.impact.possibleExcluded > 0" class="muted small">
              ({{ graph.impact.possibleExcluded }} possible edge{{ graph.impact.possibleExcluded === 1 ? '' : 's' }} not counted)
            </p>
            <ul class="affected" data-testid="graph-affected-list">
              <li v-for="a in graph.impact.affected" :key="`${a.instanceId}:${a.workflowId}`">
                <button type="button" class="affected-item" title="Open workflow details" @click="openWorkflowDetail(a.instanceId, a.workflowId)">
                  <span class="affected-name">{{ a.name }}<span class="ext" aria-hidden="true"> ↗</span></span>
                  <span class="muted small">{{ a.instanceLabel }} · {{ a.hops }} hop{{ a.hops === 1 ? '' : 's' }}</span>
                </button>
              </li>
            </ul>
          </div>
          <p v-else-if="sel.kind === 'datatable'" class="muted small">A shared data table — select a workflow or credential to see a blast radius.</p>
        </template>
        <p v-else class="muted small">Click a node to see what it depends on — and what breaks if it fails.</p>
      </aside>
    </div>

    <WorkflowDetailDrawer :selected="drawerSelected" @close="drawerSelected = null" />
  </section>
</template>

<style scoped>
.graph-view { display: flex; flex-direction: column; gap: var(--spacing--2xs); padding: var(--spacing--md); height: calc(100vh - 56px); box-sizing: border-box; }
/* Embedded as the Estate's graph representation: the Estate owns the outer chrome, so
   drop the standalone page padding and fit under the lens tabs + view toggle. */
.graph-view.embedded { padding: 0; height: calc(100vh - 13rem); min-height: 28rem; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--spacing--md); flex-wrap: wrap; }
.titles h1 { font-size: var(--font-size--lg); font-weight: var(--font-weight--bold); margin: 0; }
.counts { font-size: var(--font-size--2xs); display: flex; gap: var(--spacing--3xs); white-space: nowrap; }

.controls { display: flex; align-items: center; gap: var(--spacing--2xs); flex-wrap: wrap; }
.spacer { flex: 1 1 auto; }
.scope-switch { display: inline-flex; gap: var(--spacing--5xs); flex-wrap: wrap; }
.chip {
  appearance: none; border: 1px solid var(--border-color); background: var(--background--surface);
  color: var(--color--text--shade-1); font: inherit; font-size: var(--font-size--3xs);
  padding: var(--spacing--5xs) var(--spacing--2xs); border-radius: var(--radius--md); cursor: pointer;
}
.chip--active { background: var(--background--subtle); border-color: var(--background--brand); color: var(--background--brand); }
.input--sm { font-size: var(--font-size--3xs); padding: var(--spacing--5xs) var(--spacing--2xs); }
.toggle { display: inline-flex; align-items: center; gap: var(--spacing--4xs); font-size: var(--font-size--3xs); cursor: pointer; }

.legend { display: flex; gap: var(--spacing--sm); flex-wrap: wrap; font-size: var(--font-size--3xs); color: var(--color--text--shade-1); }
.lg { display: inline-flex; align-items: center; gap: var(--spacing--4xs); }
.swatch { width: 10px; height: 10px; border-radius: var(--radius--2xs, 3px); display: inline-block; }
.swatch--ok { background: var(--color--success); }
.swatch--warn { background: var(--color--warning); }
.swatch--danger { background: var(--color--danger); }
.swatch--muted { background: var(--border-color--strong); }
.lg-key { width: 13px; height: 13px; color: var(--color--secondary); flex: 0 0 auto; }
.line { width: 18px; height: 0; border-top-width: 2px; border-top-style: solid; display: inline-block; }
.line--confirmed { border-top-color: var(--border-color--strong); }
.line--possible { border-top-style: dashed; border-top-color: var(--border-color--strong); }
.line--cross { border-top-color: var(--color--primary); border-top-width: 3px; }

.stage { flex: 1 1 auto; display: flex; gap: var(--spacing--2xs); min-height: 0; }
.canvas-wrap { flex: 1 1 auto; min-width: 0; position: relative; }
.state { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }
.err { color: var(--color--danger); }

.panel {
  flex: 0 0 300px; overflow-y: auto; background: var(--background--surface);
  border: 1px solid var(--border-color--subtle); border-radius: var(--radius--md); padding: var(--spacing--sm);
}
/* Header row: the flow name + an Unselect control to clear the selection. */
.p-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--2xs); }
.p-title { font-size: var(--font-size--sm); font-weight: var(--font-weight--bold); margin: 0; word-break: break-word; min-width: 0; }
.p-clear {
  appearance: none; flex: none; cursor: pointer; font: inherit; font-size: var(--font-size--3xs); font-weight: var(--font-weight--medium);
  color: var(--color--text--shade-1); background: var(--background--surface);
  border: 1px solid var(--border-color); border-radius: var(--radius--md);
  padding: var(--spacing--5xs) var(--spacing--2xs); white-space: nowrap;
}
.p-clear:hover { border-color: var(--border-color--strong); background: var(--background--subtle); }
/* The selected workflow name doubles as a link into its detail drawer. */
.p-title--link {
  appearance: none; border: 0; background: none; padding: 0; text-align: left;
  color: var(--background--brand); cursor: pointer; font-family: inherit;
}
.p-title--link:hover { text-decoration: underline; }
/* The "open" glyph (matches chat's workflow refs) — signals the name is clickable. */
.ext { font-size: 0.8em; opacity: 0.7; }
.p-sub { margin: var(--spacing--5xs) 0 var(--spacing--2xs); font-size: var(--font-size--3xs); }
.drawer-err { color: var(--color--danger); margin: 0 0 var(--spacing--2xs); }
.impact-headline { font-size: var(--font-size--sm); margin: var(--spacing--2xs) 0; }
.impact-headline strong { color: var(--color--danger); font-size: var(--font-size--md); }
.small { font-size: var(--font-size--3xs); }
/* The blast-radius list grows with its content; the panel (its container) scrolls. */
.affected { list-style: none; margin: var(--spacing--2xs) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--2xs); }
/* Each row is a link (brand name + ↗), not a card — no separate hover background. */
.affected-item {
  appearance: none; width: 100%; text-align: left; border: 0;
  background: none; cursor: pointer; font: inherit; font-size: var(--font-size--2xs);
  color: var(--color--text--shade-1); display: flex; flex-direction: column; gap: 1px; padding: 0;
}
.affected-name { font-weight: var(--font-weight--medium); word-break: break-word; color: var(--background--brand); }
.affected-item:hover .affected-name { text-decoration: underline; }

@media (max-width: 900px) {
  .graph-view, .graph-view.embedded { height: auto; }
  .stage { flex-direction: column; }
  .canvas-wrap { min-height: 60vh; }
  .panel { flex: 1 1 auto; }
}
</style>
