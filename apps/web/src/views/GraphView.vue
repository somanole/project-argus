<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { GraphNode, GraphScope } from '@argus/shared';
import { useGraphStore } from '../stores/graph';
import { api } from '../lib/api';
import DependencyGraph from '../components/DependencyGraph.vue';

/**
 * S5 hero view: the fleet-wide dependency graph + blast-radius highlight. Scoped
 * views keep it navigable at fleet scale; nodes are health-colored, cross-instance
 * edges are prominent, `possible` edges are dashed, and clicking a node shows the
 * edge-type-aware impact answer with an explicit total (rule 5 — no invented numbers).
 */
const graph = useGraphStore();

const archivedHidden = ref(true);
const mcpHighlight = ref(false);
const hops = ref(2);

const instanceOptions = ref<{ id: string; label: string }[]>([]);
const systemOptions = ref<string[]>([]);
const instancePick = ref<string>('');
const systemPick = ref<string>('');

const scopes: { value: GraphScope; label: string }[] = [
  { value: 'estate', label: 'Estate' },
  { value: 'instance', label: 'Instance' },
  { value: 'system', label: 'System' },
  { value: 'neighborhood', label: 'Neighborhood' },
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
  // neighborhood: needs a selected node.
  if (scope === 'neighborhood') {
    const n = graph.selectedNode;
    if (n) return graph.load({ scope, focus: n.id, hops: hops.value });
    graph.scope = 'neighborhood'; // reflect the choice; view prompts for a node
  }
}

function onSelect(node: GraphNode): void {
  graph.selectNode(node);
  if (mcpHighlight.value && node.kind === 'workflow' && node.mcpExposed) graph.loadMcpReach(node);
}

async function focusNeighborhood(): Promise<void> {
  if (graph.selectedNode) await graph.load({ scope: 'neighborhood', focus: graph.selectedNode.id, hops: hops.value });
}

const impactedIds = computed(() => {
  const s = new Set<string>();
  if (graph.impact && graph.selectedNode) {
    s.add(graph.selectedNode.id);
    for (const a of graph.impact.affected) s.add(`wf:${a.instanceId}:${a.workflowId}`);
  }
  return s;
});
const reachIds = computed(() => {
  const s = new Set<string>();
  const r = graph.mcpReach;
  if (mcpHighlight.value && r) {
    s.add(`wf:${r.instanceId}:${r.workflowId}`);
    for (const w of r.reachableWorkflows) s.add(`wf:${w.instanceId}:${w.workflowId}`);
  }
  return s;
});

const sel = computed(() => graph.selectedNode);
</script>

<template>
  <section class="graph-view" data-testid="graph-view">
    <header class="head">
      <div class="titles">
        <h1>Relationships &amp; blast radius</h1>
        <p class="muted">
          One estate. Nodes are workflows (health-colored) and shared resources; edges are dependencies.
          <strong>Solid</strong> = confirmed, <strong>dashed</strong> = possible (never counted), <strong>accent</strong> = cross-instance.
        </p>
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
      <label v-if="graph.scope === 'neighborhood'" class="hops">
        hops
        <select v-model.number="hops" class="input input--sm" @change="focusNeighborhood">
          <option :value="1">1</option><option :value="2">2</option><option :value="3">3</option>
        </select>
      </label>

      <div class="spacer" />

      <label class="toggle" data-testid="graph-archived-toggle">
        <input v-model="archivedHidden" type="checkbox">
        Hide archived
      </label>
      <label class="toggle" data-testid="graph-mcp-toggle">
        <input v-model="mcpHighlight" type="checkbox">
        Highlight MCP exposure
      </label>
    </div>

    <div class="legend" data-testid="graph-legend">
      <span class="lg"><span class="swatch swatch--ok" /> healthy</span>
      <span class="lg"><span class="swatch swatch--warn" /> degraded</span>
      <span class="lg"><span class="swatch swatch--danger" /> failing</span>
      <span class="lg"><span class="swatch swatch--muted" /> idle / resource</span>
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
          <template v-if="graph.scope === 'neighborhood' && !graph.focus"> Click a node in the estate view, then choose Neighborhood.</template>
        </p>
        <DependencyGraph
          v-else-if="graph.graph"
          :graph="graph.graph"
          :selected-id="sel?.id ?? null"
          :impacted-ids="impactedIds"
          :archived-hidden="archivedHidden"
          :mcp-highlight="mcpHighlight"
          :reach-ids="reachIds"
          @select="onSelect"
        />
      </div>

      <aside class="panel" data-testid="graph-impact-panel">
        <template v-if="sel">
          <h2 class="p-title">{{ sel.label }}</h2>
          <p class="p-sub muted">
            {{ sel.kind === 'workflow' ? 'workflow' : sel.kind === 'credential' ? 'credential' : 'data table' }} · {{ sel.instanceLabel }}
          </p>

          <div v-if="graph.impactState === 'loading'" class="muted">Computing blast radius…</div>
          <div v-else-if="graph.impact" class="impact">
            <p class="impact-headline" data-testid="graph-impact-statement">
              {{ graph.impact.mode === 'credential_rotation' ? 'Rotating this credential affects' : 'If this fails' }}:
              <strong data-testid="graph-impact-total">{{ graph.impact.total }}</strong>
              {{ graph.impact.total === 1 ? 'workflow' : 'workflows' }}.
            </p>
            <p class="muted small">{{ graph.impact.statement }}</p>
            <p v-if="graph.impact.possibleExcluded > 0" class="muted small">
              ({{ graph.impact.possibleExcluded }} possible edge{{ graph.impact.possibleExcluded === 1 ? '' : 's' }} not counted)
            </p>
            <ul class="affected">
              <li v-for="a in graph.impact.affected.slice(0, 40)" :key="`${a.instanceId}:${a.workflowId}`">
                {{ a.name }} <span class="muted small">· {{ a.instanceLabel }} · {{ a.hops }} hop{{ a.hops === 1 ? '' : 's' }}</span>
              </li>
            </ul>
            <button class="btn btn--secondary btn--sm btn--block" @click="focusNeighborhood">Focus its neighborhood</button>
          </div>
          <p v-else-if="sel.kind === 'datatable'" class="muted small">A shared data table — select a workflow or credential to see a blast radius.</p>

          <div v-if="mcpHighlight && graph.mcpReach" class="reach">
            <h3>MCP exposure reach</h3>
            <p class="small" :class="graph.mcpReach.reachesSensitive ? 'reach--danger' : 'muted'">
              {{ graph.mcpReach.reachesSensitive ? 'Reaches sensitive systems.' : 'No sensitive systems reached.' }}
            </p>
            <p class="small muted">Systems: {{ graph.mcpReach.reachableSystems.join(', ') || '—' }}</p>
          </div>
        </template>
        <p v-else class="muted small">Click a node to see what it depends on — and what breaks if it fails.</p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.graph-view { display: flex; flex-direction: column; gap: var(--spacing--2xs); padding: var(--spacing--md); height: calc(100vh - 56px); box-sizing: border-box; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--spacing--md); flex-wrap: wrap; }
.titles h1 { font-size: var(--font-size--lg); font-weight: var(--font-weight--bold); margin: 0; }
.titles .muted { font-size: var(--font-size--2xs); margin: var(--spacing--5xs) 0 0; max-width: 60ch; }
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
.hops { display: inline-flex; align-items: center; gap: var(--spacing--4xs); font-size: var(--font-size--3xs); }
.toggle { display: inline-flex; align-items: center; gap: var(--spacing--4xs); font-size: var(--font-size--3xs); cursor: pointer; }

.legend { display: flex; gap: var(--spacing--sm); flex-wrap: wrap; font-size: var(--font-size--3xs); color: var(--color--text--shade-1); }
.lg { display: inline-flex; align-items: center; gap: var(--spacing--4xs); }
.swatch { width: 10px; height: 10px; border-radius: var(--radius--2xs, 3px); display: inline-block; }
.swatch--ok { background: var(--color--success); }
.swatch--warn { background: var(--color--warning); }
.swatch--danger { background: var(--color--danger); }
.swatch--muted { background: var(--border-color--strong); }
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
.p-title { font-size: var(--font-size--sm); font-weight: var(--font-weight--bold); margin: 0; word-break: break-word; }
.p-sub { margin: var(--spacing--5xs) 0 var(--spacing--2xs); font-size: var(--font-size--3xs); }
.impact-headline { font-size: var(--font-size--sm); margin: var(--spacing--2xs) 0; }
.impact-headline strong { color: var(--color--danger); font-size: var(--font-size--md); }
.small { font-size: var(--font-size--3xs); }
.affected { list-style: none; margin: var(--spacing--2xs) 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--5xs); font-size: var(--font-size--2xs); max-height: 40vh; overflow-y: auto; }
.reach { margin-top: var(--spacing--sm); border-top: 1px solid var(--border-color--subtle); padding-top: var(--spacing--2xs); }
.reach h3 { font-size: var(--font-size--2xs); margin: 0 0 var(--spacing--4xs); }
.reach--danger { color: var(--color--danger); font-weight: var(--font-weight--medium); }

@media (max-width: 900px) {
  .graph-view { height: auto; }
  .stage { flex-direction: column; }
  .canvas-wrap { min-height: 60vh; }
  .panel { flex: 1 1 auto; }
}
</style>
