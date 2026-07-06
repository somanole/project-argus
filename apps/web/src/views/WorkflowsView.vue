<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useWorkflowsStore } from '../stores/workflows';
import { useConnectionsStore } from '../stores/connections';
import type { WorkflowListItem } from '@argus/shared';
import StateBadge from '../components/StateBadge.vue';
import FactBadge from '../components/FactBadge.vue';
import WorkflowDetailDrawer from '../components/WorkflowDetailDrawer.vue';
import { instanceColor } from '../lib/instanceColor';
import { relativeTime } from '../lib/time';

const store = useWorkflowsStore();
const connections = useConnectionsStore();
const { workflows, facets, coverage, state, error, lastUpdated, instanceId, systems, triggers, mcpOnly, stateFilter, activeFilterCount, triggerLabels } =
  storeToRefs(store);

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;

// The selected workflow for the detail drawer.
const selected = ref<WorkflowListItem | null>(null);

// On narrow widths the facet chips collapse behind a "Filters" control (desktop
// always shows them — the CSS only honours this below the mobile breakpoint).
const filtersOpen = ref(false);

// Debounced search box (server-side query on each change).
const qInput = ref('');
let qTimer: ReturnType<typeof setTimeout> | undefined;
watch(qInput, (v) => {
  if (qTimer) clearTimeout(qTimer);
  qTimer = setTimeout(() => store.setQuery(v), 250);
});

const total = computed(() => workflows.value.length);
const estateSize = computed(() => coverage.value?.total ?? null);
// "synced Ns ago", advancing between refreshes via the ticking clock.
const syncedAgo = computed(() => relativeTime(lastUpdated.value, now.value));

async function refreshAll(): Promise<void> {
  await Promise.all([store.refresh(), store.refreshCoverage(), connections.refresh()]);
}

onMounted(async () => {
  await refreshAll();
  poll = setInterval(() => void refreshAll(), 15_000);
  clock = setInterval(() => (now.value = Date.now()), 1_000);
});
onUnmounted(() => {
  if (poll) clearInterval(poll);
  if (clock) clearInterval(clock);
});
</script>

<template>
  <section class="catalog">
    <header class="head">
      <div>
        <h1>Catalog</h1>
        <p class="muted sub">
          {{ total }} workflow<span v-if="total !== 1">s</span>
          <span v-if="activeFilterCount > 0"> match · </span>
          <span v-else> across </span>
          <template v-if="activeFilterCount === 0">
            {{ connections.connections.length }} instance<span v-if="connections.connections.length !== 1">s</span>
          </template>
          <button v-if="activeFilterCount > 0" class="linkish" @click="store.clearFilters()">
            clear {{ activeFilterCount }} filter{{ activeFilterCount > 1 ? 's' : '' }}
          </button>
        </p>
      </div>
      <div class="head-right">
        <div
          v-if="coverage"
          class="coverage"
          data-testid="coverage-indicator"
          :title="`${coverage.understood}/${coverage.total} workflows fully understood; ${coverage.brokenRefTotal} broken reference(s)`"
        >
          <span class="cov-pct">{{ coverage.understoodPct }}%</span>
          <span class="cov-label muted">understood</span>
          <FactBadge v-if="coverage.brokenRefTotal > 0" :label="`${coverage.brokenRefTotal} broken`" tone="danger" />
        </div>
        <span class="badge badge--muted" data-testid="freshness-pill"><span class="dot dot--ok" /> Polling — updates within ~30s</span>
        <span class="muted synced" data-testid="synced-indicator">synced {{ syncedAgo }}</span>
        <button class="btn btn--secondary btn--sm" data-testid="refresh-button" @click="refreshAll">Refresh</button>
      </div>
    </header>

    <!-- Filter bar -->
    <div class="filterbar">
      <input v-model="qInput" class="input search" type="search" placeholder="Search by name…" aria-label="Search workflows by name" data-testid="filter-search">
      <div class="seg" role="group" aria-label="State" data-testid="filter-state">
        <button :class="{ on: stateFilter === 'all' }" @click="store.setStateFilter('all')">All</button>
        <button :class="{ on: stateFilter === 'active' }" @click="store.setStateFilter('active')">Active</button>
        <button :class="{ on: stateFilter === 'archived' }" @click="store.setStateFilter('archived')">Archived</button>
      </div>
      <button class="chip" :class="{ 'chip--active': mcpOnly }" data-testid="filter-mcp" @click="store.setMcpOnly(!mcpOnly)">MCP-exposed</button>
      <button class="btn btn--secondary btn--sm filters-toggle" :aria-expanded="filtersOpen" @click="filtersOpen = !filtersOpen">
        Filters<span v-if="activeFilterCount"> ({{ activeFilterCount }})</span> {{ filtersOpen ? '▲' : '▾' }}
      </button>
    </div>

    <div class="facets" :class="{ 'facets--collapsed': !filtersOpen }">
      <!-- Instance facet -->
      <div class="facet" role="group" aria-label="Filter by instance" data-testid="filter-instance">
        <span class="facet-label muted">Instance</span>
        <button class="chip" :class="{ 'chip--active': instanceId === 'all' }" @click="store.setInstance('all')">All estate</button>
        <button
          v-for="i in facets.instances"
          :key="i.id"
          class="chip"
          :class="{ 'chip--active': instanceId === i.id }"
          @click="store.setInstance(i.id)"
        >
          <span class="dot" :style="{ background: instanceColor(i.id) }" />
          {{ i.label }} <span class="count">{{ i.count }}</span>
        </button>
      </div>

      <!-- System facet -->
      <div v-if="facets.systems.length" class="facet" role="group" aria-label="Filter by external system" data-testid="filter-system">
        <span class="facet-label muted">System</span>
        <button
          v-for="s in facets.systems"
          :key="s.value"
          class="chip"
          :class="{ 'chip--active': systems.includes(s.value) }"
          @click="store.toggleSystem(s.value)"
        >
          {{ s.value }} <span class="count">{{ s.count }}</span>
        </button>
      </div>

      <!-- Trigger facet -->
      <div v-if="facets.triggers.length" class="facet" role="group" aria-label="Filter by trigger" data-testid="filter-trigger">
        <span class="facet-label muted">Trigger</span>
        <button
          v-for="t in facets.triggers"
          :key="t.value"
          class="chip"
          :class="{ 'chip--active': triggers.includes(t.value) }"
          @click="store.toggleTrigger(t.value)"
        >
          {{ t.label }} <span class="count">{{ t.count }}</span>
        </button>
      </div>
    </div>

    <p v-if="state === 'loading'" class="muted pad">Loading the catalog…</p>
    <p v-else-if="state === 'error'" class="err pad" role="alert">Couldn’t load the catalog — {{ error }}.</p>

    <div v-else-if="total === 0" class="card empty">
      <p v-if="estateSize === 0">No workflows yet. <router-link to="/connections">Register a connection</router-link> to see your estate.</p>
      <p v-else class="muted">No workflows match these filters.</p>
    </div>

    <div v-else class="table-wrap">
      <table class="wf">
        <thead>
          <tr>
            <th class="c-name">Name</th>
            <th class="c-inst">Instance</th>
            <th class="c-sys">Systems</th>
            <th class="c-trig">Triggers</th>
            <th class="c-state">Status</th>
            <th class="c-upd">Updated</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="w in workflows"
            :key="w.instanceId + '/' + w.id"
            class="row"
            tabindex="0"
            @click="selected = w"
            @keydown.enter="selected = w"
          >
            <td class="c-name">
              <span class="name-cell">
                <span class="name">{{ w.name }}</span>
                <FactBadge v-if="w.mcpExposed" label="MCP" tone="mcp" title="Published to n8n's MCP server" />
                <FactBadge v-if="w.brokenRefCount > 0" :label="`${w.brokenRefCount} broken`" tone="danger" title="Broken workflow reference" />
                <FactBadge v-if="w.understood === false" label="?" tone="warn" title="Some nodes couldn't be analysed" />
              </span>
            </td>
            <td class="c-inst" data-label="Instance">
              <span class="instance"><span class="dot" :style="{ background: instanceColor(w.instanceId) }" />{{ w.instanceLabel }}</span>
            </td>
            <td class="c-sys" data-label="Systems">
              <span v-if="w.systems.length === 0" class="muted">—</span>
              <span v-else class="badges"><FactBadge v-for="s in w.systems" :key="s" :label="s" tone="system" /></span>
            </td>
            <td class="c-trig" data-label="Triggers">
              <span v-if="w.triggers.length === 0" class="muted">—</span>
              <span v-else class="badges">
                <FactBadge v-for="t in w.triggers" :key="t" :label="triggerLabels[t] ?? t" tone="trigger" :title="t" />
              </span>
            </td>
            <td class="c-state" data-label="Status"><StateBadge :active="w.active" :is-archived="w.isArchived" /></td>
            <td class="c-upd muted" data-label="Updated">{{ relativeTime(w.updatedAt, now) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <WorkflowDetailDrawer :selected="selected" @close="selected = null" />
  </section>
</template>

<style scoped>
.catalog { display: flex; flex-direction: column; gap: var(--spacing--sm); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--md); flex-wrap: wrap; }
h1 { margin: 0; font-size: var(--font-size--xl); font-weight: var(--font-weight--bold); }
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--sm); }
.head-right { display: flex; align-items: center; gap: var(--spacing--sm); flex-wrap: wrap; }
.coverage { display: inline-flex; align-items: baseline; gap: var(--spacing--4xs); }
.cov-pct { font-size: var(--font-size--md); font-weight: var(--font-weight--bold); font-variant-numeric: tabular-nums; }
.cov-label { font-size: var(--font-size--2xs); }
.synced { font-size: var(--font-size--2xs); }
.linkish {
  appearance: none; border: 0; background: none; color: var(--color--primary, var(--background--brand));
  font: inherit; font-size: var(--font-size--sm); cursor: pointer; padding: 0;
}

.filterbar { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; align-items: center; }
.search { max-width: 18rem; }
.seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--radius--md); overflow: hidden; }
.seg button {
  appearance: none; border: 0; background: var(--background--surface); color: var(--color--text--shade-1);
  font: inherit; font-size: var(--font-size--2xs); font-weight: var(--font-weight--medium);
  padding: var(--spacing--4xs) var(--spacing--sm); cursor: pointer; border-right: 1px solid var(--border-color);
}
.seg button:last-child { border-right: 0; }
.seg button.on { background: var(--background--brand); color: var(--color--neutral-white); }

.facet { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; align-items: center; }
.facet-label { font-size: var(--font-size--3xs); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide); min-width: 3.5rem; }
.chip {
  appearance: none; display: inline-flex; align-items: center; gap: var(--spacing--4xs);
  border: 1px solid var(--border-color); border-radius: var(--radius--full);
  background: var(--background--surface); color: var(--color--text--shade-1);
  font: inherit; font-size: var(--font-size--2xs); font-weight: var(--font-weight--medium);
  padding: var(--spacing--4xs) var(--spacing--sm); cursor: pointer;
}
.chip:hover { background: var(--background--subtle); }
.chip--active { background: var(--background--brand); color: var(--color--neutral-white); border-color: var(--background--brand); }
.chip .count { opacity: 0.7; font-variant-numeric: tabular-nums; }

.table-wrap { border: 1px solid var(--border-color--subtle); border-radius: var(--radius--lg); overflow-x: auto; }
.wf { width: 100%; border-collapse: collapse; font-size: var(--font-size--sm); }
.wf thead th {
  text-align: left; font-size: var(--font-size--3xs); font-weight: var(--font-weight--medium);
  text-transform: uppercase; letter-spacing: var(--letter-spacing--wide);
  color: var(--color--text--shade-1); opacity: 0.6;
  padding: var(--spacing--2xs) var(--spacing--sm); background: var(--background--subtle);
  border-bottom: 1px solid var(--border-color--subtle); white-space: nowrap;
}
.wf tbody td { padding: var(--spacing--2xs) var(--spacing--sm); border-bottom: 1px solid var(--border-color--subtle); vertical-align: middle; }
.wf tbody tr:last-child td { border-bottom: 0; }
.row { cursor: pointer; }
.row:hover td, .row:focus-visible td { background: var(--background--hover, var(--background--subtle)); }
.row:focus-visible { outline: 2px solid var(--focus--border-color, var(--color--primary)); outline-offset: -2px; }
.c-name { font-weight: var(--font-weight--medium); }
.name-cell { display: inline-flex; align-items: center; gap: var(--spacing--4xs); flex-wrap: wrap; }
.c-upd { white-space: nowrap; font-size: var(--font-size--2xs); }
.badges { display: flex; flex-wrap: wrap; gap: var(--spacing--4xs); max-width: 22rem; }
.instance { display: inline-flex; align-items: center; gap: var(--spacing--4xs); white-space: nowrap; }
.empty { text-align: center; }
.empty p { margin: 0; }
.pad { padding: var(--spacing--md) 0; }
.err { color: var(--text-color--danger, var(--color--danger)); }
a { color: var(--color--primary, var(--background--brand)); }

/* Filters collapse behind a control on narrow widths (desktop always shows them). */
.facets { display: flex; flex-direction: column; gap: var(--spacing--sm); }
.filters-toggle { display: none; }

/* Mobile (≤720px): filters collapse, and the catalog table reflows to stacked
   cards — never a horizontal page scroll, never a clipped field (rule 10). */
@media (max-width: 720px) {
  .filters-toggle { display: inline-flex; }
  .facets--collapsed { display: none; }

  .table-wrap { border: 0; overflow: visible; }
  .wf, .wf tbody, .wf tr, .wf td { display: block; width: 100%; }
  .wf thead { display: none; }
  .wf tbody tr {
    border: 1px solid var(--border-color--subtle);
    border-radius: var(--radius--md);
    margin-bottom: var(--spacing--2xs);
    padding: var(--spacing--2xs) var(--spacing--sm);
    background: var(--background--surface);
  }
  .wf tbody td { border: 0; padding: var(--spacing--4xs) 0; display: flex; gap: var(--spacing--sm); align-items: baseline; }
  .wf tbody td[data-label]::before {
    content: attr(data-label);
    flex: 0 0 5rem;
    color: var(--color--text--shade-1); opacity: 0.6;
    font-size: var(--font-size--3xs); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide);
  }
  .c-name { font-size: var(--font-size--md); }
  .badges { max-width: none; }
  /* Highlight the whole card, not individual cells. */
  .row:hover td, .row:focus-visible td { background: transparent; }
  .row:hover, .row:focus-visible { background: var(--background--hover, var(--background--subtle)); }
}
</style>
