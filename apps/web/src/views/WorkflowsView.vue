<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useWorkflowsStore, type StateFilter } from '../stores/workflows';
import { useConnectionsStore } from '../stores/connections';
import type { WorkflowListItem } from '@argus/shared';
import StateBadge from '../components/StateBadge.vue';
import FactBadge from '../components/FactBadge.vue';
import EnrichmentBadges from '../components/EnrichmentBadges.vue';
import WorkflowHealthBadge from '../components/WorkflowHealthBadge.vue';
import OwnerBadge from '../components/OwnerBadge.vue';
import WorkflowDetailDrawer from '../components/WorkflowDetailDrawer.vue';
import { instanceColor } from '../lib/instanceColor';
import { relativeTime } from '../lib/time';

const store = useWorkflowsStore();
const connections = useConnectionsStore();
const { workflows, facets, coverage, enrichmentProgress, state, error, lastUpdated, instanceId, systems, triggers, criticality, health, mcpOnly, brokenOnly, stateFilter, activeFilterCount, triggerLabels } =
  storeToRefs(store);

// Criticality filter levels, most-severe first (from the enrichment enum).
const CRITICALITY_LEVELS = ['critical', 'high', 'medium', 'low'];
// Health filter levels, most-urgent first (the S3 status enum).
const HEALTH_LEVELS = ['failing', 'degraded', 'healthy', 'idle', 'unknown'];

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;

// The selected workflow for the detail drawer.
const selected = ref<WorkflowListItem | null>(null);

// Instance is the primary axis and stays out front (the scope control); every other
// facet lives in the "Filters" panel, and whatever's applied surfaces as removable
// tokens. The panel opens on demand and closes on an outside click.
const panelOpen = ref(false);
const sysSearch = ref('');
const filterRoot = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent): void {
  if (panelOpen.value && filterRoot.value && !filterRoot.value.contains(e.target as Node)) panelOpen.value = false;
}

// Count of applied facets BEHIND the panel (instance + search live out front, so
// they don't count toward the panel badge).
const panelFilterCount = computed(
  () =>
    systems.value.length + triggers.value.length + criticality.value.length + health.value.length +
    (mcpOnly.value ? 1 : 0) + (brokenOnly.value ? 1 : 0) + (stateFilter.value !== 'all' ? 1 : 0),
);

// The System facet is long (25+) — a search field narrows it in place.
const filteredSystems = computed(() => {
  const needle = sysSearch.value.trim().toLowerCase();
  return needle ? facets.value.systems.filter((s) => s.value.toLowerCase().includes(needle)) : facets.value.systems;
});

// The "here's what's applied" strip: one removable token per active facet (instance
// is shown in the scope control and search in its box, so neither becomes a token).
const STATE_LABEL: Record<StateFilter, string> = { all: '', active: 'Active', archived: 'Archived' };
const joinVals = (vals: string[]): string =>
  vals.length <= 2 ? vals.join(', ') : `${vals.slice(0, 2).join(', ')} +${vals.length - 2}`;
const appliedTokens = computed(() => {
  const t: { key: string; label: string; text: string; remove: () => void }[] = [];
  if (criticality.value.length) t.push({ key: 'criticality', label: 'Criticality', text: joinVals(criticality.value), remove: () => store.clearCriticality() });
  if (health.value.length) t.push({ key: 'health', label: 'Health', text: joinVals(health.value), remove: () => store.clearHealth() });
  if (systems.value.length) t.push({ key: 'system', label: 'System', text: joinVals(systems.value), remove: () => store.clearSystems() });
  if (triggers.value.length) t.push({ key: 'trigger', label: 'Trigger', text: joinVals(triggers.value.map((v) => triggerLabels.value[v] ?? v)), remove: () => store.clearTriggers() });
  if (stateFilter.value !== 'all') t.push({ key: 'state', label: 'Status', text: STATE_LABEL[stateFilter.value], remove: () => store.setStateFilter('all') });
  if (mcpOnly.value) t.push({ key: 'mcp', label: '', text: 'MCP-exposed', remove: () => store.setMcpOnly(false) });
  if (brokenOnly.value) t.push({ key: 'broken', label: '', text: 'Broken refs', remove: () => store.setBrokenOnly(false) });
  return t;
});

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

// Honest freshness (rule 5): the catalog serves last-known data even when an
// instance stops syncing, so the pill must reflect the *connections'* health — a
// rejected key or unreachable instance means the estate is silently going stale,
// and that must be surfaced here, not shown as a healthy green poll.
const syncFailures = computed(() =>
  connections.connections.filter((c) => c.health.status === 'unauthorized' || c.health.status === 'unreachable'));
const syncOk = computed(() => syncFailures.value.length === 0);
const syncFailureTitle = computed(() =>
  syncFailures.value.map((c) => `${c.label}: ${c.health.lastError ?? c.health.status}`).join(' · '));

async function refreshAll(): Promise<void> {
  await Promise.all([store.refresh(), store.refreshCoverage(), store.refreshEnrichmentProgress(), connections.refresh()]);
}

// "enriched X/Y" — only shown when enrichment is enabled + configured.
const enrichmentLabel = computed(() => {
  const p = enrichmentProgress.value;
  if (!p || !p.enabled) return null;
  return `${p.analyzed}/${p.total}`;
});

onMounted(async () => {
  document.addEventListener('click', onDocClick);
  await refreshAll();
  poll = setInterval(() => void refreshAll(), 15_000);
  clock = setInterval(() => (now.value = Date.now()), 1_000);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
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
        <span
          v-if="enrichmentLabel"
          class="coverage"
          data-testid="enrichment-progress"
          :title="`${enrichmentProgress?.analyzed} analyzed, ${enrichmentProgress?.stub} couldn't analyze, ${enrichmentProgress?.stale} stale, ${enrichmentProgress?.pending} pending`"
        >
          <span class="cov-pct">{{ enrichmentLabel }}</span>
          <span class="cov-label muted">enriched</span>
        </span>
        <span
          v-if="syncOk"
          class="badge badge--muted"
          data-testid="freshness-pill"
        ><span class="dot dot--ok" /> Polling — updates within ~30s</span>
        <span
          v-else
          class="badge badge--danger"
          data-testid="freshness-pill"
          data-state="failing"
          :title="syncFailureTitle"
        ><span class="dot dot--danger" /> {{ syncFailures.length }} of {{ connections.connections.length }} instances not syncing</span>
        <span class="muted synced" data-testid="synced-indicator">synced {{ syncedAgo }}</span>
        <button class="btn btn--secondary btn--sm" data-testid="refresh-button" @click="refreshAll">Refresh</button>
      </div>
    </header>

    <!-- Filter toolbar: instance scope stays out front; every other facet lives in
         the Filters panel and surfaces as a removable token below. -->
    <div ref="filterRoot" class="toolbar">
      <div class="bar">
        <!-- Scope: which instance (the primary axis). -->
        <div class="seg scope" role="group" aria-label="Filter by instance" data-testid="filter-instance">
          <button :class="{ on: instanceId === 'all' }" @click="store.setInstance('all')">All estate</button>
          <button
            v-for="i in facets.instances"
            :key="i.id"
            :class="{ on: instanceId === i.id }"
            @click="store.setInstance(i.id)"
          >
            <span class="dot" :style="{ background: instanceColor(i.id) }" />{{ i.label }} <span class="count">{{ i.count }}</span>
          </button>
        </div>

        <input v-model="qInput" class="input search" type="search" placeholder="Search by name…" aria-label="Search workflows by name" data-testid="filter-search">

        <!-- Filters panel: everything except instance + search. -->
        <div class="filters-anchor">
          <button
            class="btn btn--secondary btn--sm filters-btn"
            :class="{ 'is-open': panelOpen }"
            :aria-expanded="panelOpen"
            @click.stop="panelOpen = !panelOpen"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="fico" aria-hidden="true"><path d="M3 6h18M6 12h12M10 18h4" /></svg>
            Filters
            <span v-if="panelFilterCount" class="fcount">{{ panelFilterCount }}</span>
            <span class="caret" aria-hidden="true">{{ panelOpen ? '▲' : '▾' }}</span>
          </button>

          <div v-show="panelOpen" class="filters-panel" @click.stop>
            <div class="panel-scroll">
              <div class="facet-sec">
                <span class="facet-h">Status</span>
                <div class="seg seg--sm" role="group" aria-label="Filter by state" data-testid="filter-state">
                  <button :class="{ on: stateFilter === 'all' }" @click="store.setStateFilter('all')">All</button>
                  <button :class="{ on: stateFilter === 'active' }" @click="store.setStateFilter('active')">Active</button>
                  <button :class="{ on: stateFilter === 'archived' }" @click="store.setStateFilter('archived')">Archived</button>
                </div>
              </div>

              <div class="facet-sec" role="group" aria-label="Filter by external system" data-testid="filter-system">
                <span class="facet-h">System</span>
                <input
                  v-if="facets.systems.length > 8"
                  v-model="sysSearch"
                  class="input input--sm sys-search"
                  type="search"
                  :placeholder="`Search ${facets.systems.length} systems…`"
                  aria-label="Search systems"
                >
                <div class="checklist">
                  <button
                    v-for="s in filteredSystems"
                    :key="s.value"
                    class="opt"
                    :class="{ sel: systems.includes(s.value) }"
                    @click="store.toggleSystem(s.value)"
                  >
                    <span class="box" /><span class="opt-t">{{ s.value }}</span><span class="opt-c">{{ s.count }}</span>
                  </button>
                  <p v-if="filteredSystems.length === 0" class="muted small pad-s">No systems match.</p>
                </div>
              </div>

              <div class="facet-sec" role="group" aria-label="Filter by criticality" data-testid="filter-criticality">
                <span class="facet-h">Criticality</span>
                <div class="checklist wrap">
                  <button v-for="c in CRITICALITY_LEVELS" :key="c" class="opt opt--chip" :class="{ sel: criticality.includes(c) }" @click="store.toggleCriticality(c)"><span class="box" />{{ c }}</button>
                </div>
              </div>

              <div class="facet-sec" role="group" aria-label="Filter by health" data-testid="filter-health">
                <span class="facet-h">Health</span>
                <div class="checklist wrap">
                  <button v-for="h in HEALTH_LEVELS" :key="h" class="opt opt--chip" :class="{ sel: health.includes(h) }" @click="store.toggleHealth(h)"><span class="box" />{{ h }}</button>
                </div>
              </div>

              <div class="facet-sec" role="group" aria-label="Filter by trigger" data-testid="filter-trigger">
                <span class="facet-h">Trigger</span>
                <div class="checklist">
                  <button v-for="t in facets.triggers" :key="t.value" class="opt" :class="{ sel: triggers.includes(t.value) }" @click="store.toggleTrigger(t.value)"><span class="box" /><span class="opt-t">{{ t.label }}</span><span class="opt-c">{{ t.count }}</span></button>
                </div>
              </div>

              <div class="facet-sec">
                <span class="facet-h">Flags</span>
                <div class="checklist wrap">
                  <button class="opt opt--chip" :class="{ sel: mcpOnly }" data-testid="filter-mcp" @click="store.setMcpOnly(!mcpOnly)"><span class="box" />MCP-exposed</button>
                  <button class="opt opt--chip" :class="{ sel: brokenOnly }" data-testid="filter-broken" @click="store.setBrokenOnly(!brokenOnly)"><span class="box" />Broken refs</button>
                </div>
              </div>
            </div>

            <div class="panel-foot">
              <button class="linkish" :disabled="activeFilterCount === 0" @click="store.clearFilters()">Clear all</button>
              <button class="btn btn--primary btn--sm" @click="panelOpen = false">Done</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Applied-filter tokens: a calm "here's what's applied", each removable. -->
      <div v-if="appliedTokens.length" class="applied" data-testid="applied-filters">
        <span class="applied-lbl muted">Filtered:</span>
        <span v-for="tok in appliedTokens" :key="tok.key" class="token">
          <span v-if="tok.label" class="token-dim">{{ tok.label }}</span>
          <span class="token-val">{{ tok.text }}</span>
          <button class="token-x" :aria-label="`Remove ${tok.label || tok.text} filter`" @click="tok.remove()">✕</button>
        </span>
        <button class="linkish clear-tokens" @click="store.clearFilters()">Clear all</button>
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
            <th class="c-health">Health</th>
            <th class="c-owner">Owner</th>
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
                <EnrichmentBadges :enrichment="w.enrichment" />
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
            <td class="c-health" data-label="Health"><WorkflowHealthBadge :health="w.health" /></td>
            <td class="c-owner" data-label="Owner"><OwnerBadge :owner="w.owner" /></td>
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

.search { max-width: 18rem; flex: 1 1 12rem; }

/* Filter toolbar: scope + search + Filters button on one row, applied tokens below. */
.toolbar { display: flex; flex-direction: column; gap: var(--spacing--2xs); }
.bar { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; align-items: center; }

/* Segmented control — the instance scope and the panel's Status control. */
.seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--radius--md); overflow: hidden; flex-wrap: wrap; }
.seg button {
  appearance: none; border: 0; background: var(--background--surface); color: var(--color--text--shade-1);
  font: inherit; font-size: var(--font-size--2xs); font-weight: var(--font-weight--medium);
  padding: var(--spacing--4xs) var(--spacing--sm); cursor: pointer; border-right: 1px solid var(--border-color);
  display: inline-flex; align-items: center; gap: var(--spacing--4xs); white-space: nowrap;
}
.seg button:last-child { border-right: 0; }
.seg button:hover:not(.on) { background: var(--background--subtle); }
.seg button.on { background: var(--background--brand); color: var(--color--neutral-white); }
.seg .count { opacity: 0.7; font-variant-numeric: tabular-nums; }
.seg .dot { width: 0.5rem; height: 0.5rem; border-radius: var(--radius--full); flex: none; }
.seg--sm button { font-size: var(--font-size--3xs); padding: var(--spacing--5xs) var(--spacing--2xs); }

/* Filters button + popover panel. */
.filters-anchor { position: relative; }
.filters-btn { display: inline-flex; align-items: center; gap: var(--spacing--4xs); }
.filters-btn.is-open { border-color: var(--border-color--strong); background: var(--background--subtle); }
.fico { width: 0.9rem; height: 0.9rem; }
.fcount {
  display: inline-flex; align-items: center; justify-content: center; min-width: 1.1rem; height: 1.1rem; padding: 0 var(--spacing--5xs);
  border-radius: var(--radius--full); background: var(--background--brand); color: var(--color--neutral-white);
  font-size: var(--font-size--3xs); font-weight: var(--font-weight--bold); font-variant-numeric: tabular-nums;
}
.caret { font-size: 0.65em; opacity: 0.7; }

.filters-panel {
  position: absolute; z-index: 20; top: calc(100% + var(--spacing--4xs)); right: 0;
  width: 22rem; max-width: calc(100vw - 2rem);
  background: var(--background--surface); border: 1px solid var(--border-color);
  border-radius: var(--radius--lg); box-shadow: var(--shadow); display: flex; flex-direction: column;
}
.panel-scroll { max-height: min(60vh, 30rem); overflow-y: auto; padding: var(--spacing--2xs); display: flex; flex-direction: column; gap: var(--spacing--2xs); }
.facet-sec { display: flex; flex-direction: column; gap: var(--spacing--4xs); border-top: 1px solid var(--border-color--subtle); padding-top: var(--spacing--2xs); }
.facet-sec:first-child { border-top: 0; padding-top: 0; }
.facet-h { font-size: var(--font-size--3xs); font-weight: var(--font-weight--bold); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide); color: var(--color--text--shade-1); opacity: 0.65; }
.sys-search { margin: var(--spacing--5xs) 0; }
.input--sm { padding: var(--spacing--5xs) var(--spacing--xs); font-size: var(--font-size--2xs); }

.checklist { display: flex; flex-direction: column; gap: 1px; }
.checklist.wrap { flex-direction: row; flex-wrap: wrap; gap: var(--spacing--4xs); }
.opt {
  appearance: none; border: 0; background: none; font: inherit; color: var(--color--text--shade-1); cursor: pointer; text-align: left;
  display: flex; align-items: center; gap: var(--spacing--2xs); padding: var(--spacing--4xs) var(--spacing--3xs);
  border-radius: var(--radius--2xs); font-size: var(--font-size--2xs);
}
.opt:hover { background: var(--background--hover, var(--background--subtle)); }
.opt .box {
  width: 0.95rem; height: 0.95rem; flex: none; border: 1.5px solid var(--border-color--strong, var(--border-color));
  border-radius: var(--radius--2xs); display: grid; place-items: center;
}
.opt.sel .box { background: var(--background--brand); border-color: var(--background--brand); }
.opt.sel .box::after { content: '✓'; color: var(--color--neutral-white); font-size: 0.6rem; font-weight: var(--font-weight--bold); line-height: 1; }
.opt-t { flex: 1; min-width: 0; }
.opt-c { color: var(--color--text--shade-1); opacity: 0.5; font-variant-numeric: tabular-nums; font-size: var(--font-size--3xs); }
.opt--chip { border: 1px solid var(--border-color); border-radius: var(--radius--full); padding: var(--spacing--4xs) var(--spacing--2xs); }
.opt--chip.sel { background: var(--background--brand); border-color: var(--background--brand); color: var(--color--neutral-white); }
.opt--chip.sel .box { border-color: var(--color--neutral-white); }
.opt--chip .box { width: 0.8rem; height: 0.8rem; }
.pad-s { padding: var(--spacing--3xs); margin: 0; }
.small { font-size: var(--font-size--2xs); }

.panel-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--2xs); padding: var(--spacing--2xs); border-top: 1px solid var(--border-color--subtle); }
.panel-foot .linkish:disabled { opacity: 0.4; cursor: default; }

/* Applied-filter tokens — the calm "here's what's applied" strip. */
.applied { display: flex; align-items: center; gap: var(--spacing--4xs); flex-wrap: wrap; }
.applied-lbl { font-size: var(--font-size--3xs); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide); font-weight: var(--font-weight--medium); }
.token {
  display: inline-flex; align-items: center; gap: var(--spacing--4xs);
  border: 1px solid var(--border-color); background: var(--background--subtle); border-radius: var(--radius--full);
  padding: var(--spacing--5xs) var(--spacing--2xs); font-size: var(--font-size--2xs);
}
.token-dim { color: var(--color--text--shade-1); opacity: 0.6; }
.token-val { font-weight: var(--font-weight--medium); }
.token-x { appearance: none; border: 0; background: none; color: var(--color--text--shade-1); opacity: 0.55; cursor: pointer; font-size: var(--font-size--3xs); padding: 0 0 0 var(--spacing--5xs); line-height: 1; }
.token-x:hover { opacity: 1; color: var(--color--danger); }
.clear-tokens { font-size: var(--font-size--2xs); }

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
.err { color: var(--color--danger); }
a { color: var(--color--primary, var(--background--brand)); }

/* Mobile (≤720px): the Filters panel becomes a bottom sheet (never overflowing the
   viewport), and the catalog table reflows to stacked cards — no horizontal page
   scroll, no clipped field (rule 10). */
@media (max-width: 720px) {
  .search { flex-basis: 100%; max-width: none; }
  .filters-panel {
    position: fixed; inset: auto 0 0 0; top: auto; width: auto; max-width: none;
    border-radius: var(--radius--lg) var(--radius--lg) 0 0;
  }
  .panel-scroll { max-height: 60vh; }

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
