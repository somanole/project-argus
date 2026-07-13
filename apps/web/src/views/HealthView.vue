<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useEstateHealthStore, type HealthView } from '../stores/estate-health';
import { useConnectionsStore } from '../stores/connections';
import type { WorkflowListItem } from '@argus/shared';
import WorkflowHealthBadge from '../components/WorkflowHealthBadge.vue';
import EnrichmentBadges from '../components/EnrichmentBadges.vue';
import OwnerBadge from '../components/OwnerBadge.vue';
import WorkflowDetailDrawer from '../components/WorkflowDetailDrawer.vue';
import ListPager from '../components/ListPager.vue';
import { instanceColor } from '../lib/instanceColor';
import { relativeTime } from '../lib/time';
import { usePaged } from '../lib/paginate';

const store = useEstateHealthStore();
const connections = useConnectionsStore();
const route = useRoute();

// Deep-links (e.g. the Overview "Silently failing" tile) carry ?view=… — the tile whose
// list to show on arrival. Validated against the known views; anything else is ignored.
const VALID_VIEWS: HealthView[] = ['failing', 'degraded', 'healthy', 'idle', 'unknown', 'silentlyFailing', 'canMask'];
const { data, state, error, lastUpdated, windowDays, unavailableInstances, view, rows } = storeToRefs(store);

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;

const syncedAgo = computed(() => relativeTime(lastUpdated.value, now.value));

// Honest freshness (rule 5): the feed is served from cache; if a connection stops
// syncing, health is silently going stale — surface it, never a healthy green poll.
const syncFailures = computed(() =>
  connections.connections.filter((c) => c.health.status === 'unauthorized' || c.health.status === 'unreachable'));
const syncOk = computed(() => syncFailures.value.length === 0);
const syncFailureTitle = computed(() =>
  syncFailures.value.map((c) => `${c.label}: ${c.health.lastError ?? c.health.status}`).join(' · '));

// Clicking a row opens the shared detail drawer (facts + criticality + health +
// on-demand recent runs / redacted failure) — the debugging surface.
const selected = ref<WorkflowListItem | null>(null);

const summary = computed(() => data.value?.summary ?? { failing: 0, degraded: 0, healthy: 0, idle: 0, unknown: 0, silentlyFailing: 0, canMask: 0 });

// The summary tiles double as the primary filter (same pattern as the Ownership
// register): each tile switches the working set to that health state. Healthy / idle
// are browsable too; "unavailable" only appears when an instance's executions can't be read.
// Literal testids (not `health-tile-${view}`) so each survives as a static string in
// the built bundle for the rule-11 presence grep, mirroring the Ownership register.
type Tile = { view: HealthView; label: string; tone: 'danger' | 'warn' | 'ok' | 'muted'; testid: string; show: boolean };
const tiles = computed<Tile[]>(() =>
  [
    { view: 'failing', label: 'failing', tone: 'danger', testid: 'health-tile-failing', show: true },
    { view: 'degraded', label: 'degraded', tone: 'warn', testid: 'health-tile-degraded', show: true },
    // Silently failing: green runs that swallowed a node error — always shown so the estate
    // can see it went from 0 → N (its whole point is that you'd otherwise never notice).
    { view: 'silentlyFailing', label: 'silently failing', tone: 'warn', testid: 'health-tile-silent', show: true },
    { view: 'healthy', label: 'healthy', tone: 'ok', testid: 'health-tile-healthy', show: true },
    { view: 'idle', label: 'idle', tone: 'muted', testid: 'health-tile-idle', show: true },
    { view: 'unknown', label: 'unavailable', tone: 'muted', testid: 'health-tile-unknown', show: summary.value.unknown > 0 },
    // Config-risk, not a health state — kept last + muted so it reads as secondary to the
    // live health tiles (a workflow that CAN mask a failure, whether or not it has).
    { view: 'canMask', label: 'can mask failures', tone: 'muted', testid: 'health-tile-can-mask', show: true },
  ].filter((t) => t.show) as Tile[],
);

// Scope + search — consistent with the Ownership register. The active tile picks the
// health-state SET (estate-wide, like Ownership's summary); instance + name search then
// narrow the LIST client-side (the feed already holds each set in full). Tiles stay
// estate-wide, so their counts don't jump around as you scope — matching Ownership.
const instanceFilter = ref<string>('all');
const instances = computed(() => connections.connections.map((c) => ({ id: c.id, label: c.label })));
const qInput = ref('');
const q = ref('');
let qTimer: ReturnType<typeof setTimeout> | undefined;
watch(qInput, (v) => {
  if (qTimer) clearTimeout(qTimer);
  qTimer = setTimeout(() => (q.value = v), 250);
});
const filteredRows = computed<WorkflowListItem[]>(() => {
  const needle = q.value.trim().toLowerCase();
  return rows.value.filter(
    (w) =>
      (instanceFilter.value === 'all' || w.instanceId === instanceFilter.value) &&
      (!needle || w.name.toLowerCase().includes(needle)),
  );
});

// The list is the active tile's set (scoped + searched), paginated client-side.
const PAGE_SIZE = 50;
const paged = usePaged(filteredRows, PAGE_SIZE);
// Any scope/search/tile change lands on page 1 of the new set.
watch([instanceFilter, q, view], () => paged.go(0));

// Empty is reassuring for the problem views ("Nothing failing"), neutral otherwise.
const isProblemView = computed(() => view.value === 'failing' || view.value === 'degraded');

function pct(w: WorkflowListItem): string {
  const r = w.health?.failureRate;
  return r == null ? '—' : `${Math.round(r * 100)}%`;
}

async function refreshAll(): Promise<void> {
  await Promise.all([store.refresh(), connections.refresh()]);
}

onMounted(async () => {
  const qv = route?.query?.view;
  if (typeof qv === 'string' && (VALID_VIEWS as string[]).includes(qv)) store.setView(qv as HealthView);
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
  <section class="health" data-testid="health-view">
    <header class="head">
      <div>
        <p class="muted sub">
          What's failing across the estate — poll-fresh, over the last
          <span data-testid="health-window">~{{ windowDays }} days</span> of runs.
        </p>
      </div>
      <div class="head-right">
        <span
          v-if="syncOk"
          class="badge badge--muted"
          data-testid="health-freshness"
        ><span class="dot dot--ok" /> Polling — updates within ~30s</span>
        <span
          v-else
          class="badge badge--danger"
          data-testid="health-freshness"
          data-state="failing"
          :title="syncFailureTitle"
        ><span class="dot dot--danger" /> {{ syncFailures.length }} of {{ connections.connections.length }} instances not syncing</span>
        <span class="muted synced" data-testid="synced-indicator">synced {{ syncedAgo }}</span>
        <button class="btn btn--secondary btn--sm" data-testid="refresh-button" @click="refreshAll">Refresh</button>
      </div>
    </header>

    <!-- Honest: an instance whose executions can't be read has UNAVAILABLE health, not green. -->
    <div v-if="unavailableInstances.length" class="card warnbar" role="alert">
      Health unavailable for {{ unavailableInstances.map((w) => w.instanceLabel).join(', ') }} —
      the connection's API key may lack <code>execution:list</code>. Those workflows read “health unavailable”, never healthy.
    </div>

    <!-- Summary strip = every health state, and the primary filter (tiles are buttons). -->
    <div class="summary" data-testid="health-summary">
      <button
        v-for="t in tiles"
        :key="t.view"
        class="stat stat--btn"
        :class="[`stat--${t.tone}`, { on: view === t.view }]"
        :data-testid="t.testid"
        :aria-pressed="view === t.view"
        @click="store.setView(t.view)"
      >
        <span class="n">{{ summary[t.view] }}</span><span class="lbl">{{ t.label }}</span>
      </button>
    </div>

    <!-- ── Scope + search ─── narrows the active tile's list (tiles stay estate-wide,
         matching the Ownership register). Consistent instance + name filtering. ── -->
    <div class="bar">
      <div class="seg seg--sm" role="group" aria-label="Scope by instance" data-testid="health-scope">
        <button :class="{ on: instanceFilter === 'all' }" @click="instanceFilter = 'all'">All estate</button>
        <button v-for="i in instances" :key="i.id" :class="{ on: instanceFilter === i.id }" @click="instanceFilter = i.id">
          <span class="dot" :style="{ background: instanceColor(i.id) }" />{{ i.label }}
        </button>
      </div>
      <input v-model="qInput" class="input search" type="search" placeholder="Search by name…" aria-label="Search workflows by name" data-testid="health-search">
    </div>

    <p v-if="state === 'loading'" class="muted pad">Loading estate health…</p>
    <p v-else-if="state === 'error'" class="err pad" role="alert">Couldn’t load estate health — {{ error }}.</p>

    <div v-else-if="filteredRows.length === 0" class="card empty" data-testid="health-empty">
      <p v-if="rows.length > 0">No workflows match this scope or search.</p>
      <p v-else-if="view === 'silentlyFailing'">No silently-failing workflows observed — no green run swallowed a node error among those inspected. (Absence means “not observed”, not “verified clean”.)</p>
      <p v-else-if="view === 'canMask'">No workflows are configured to mask failures — none swallow a node error onto their normal output.</p>
      <p v-else-if="isProblemView">Nothing {{ view }} right now — {{ summary.healthy }} healthy, {{ summary.idle }} idle across the estate.</p>
      <p v-else>No {{ view === 'unknown' ? 'unavailable' : view }} workflows in the last ~{{ windowDays }} days.</p>
    </div>

    <!-- One table, filtered to the active tile's health state, most-critical first. -->
    <template v-else>
      <div class="table-wrap" :data-testid="view === 'silentlyFailing' ? 'health-silent-list' : 'health-failing-list'">
        <table class="wf">
          <thead>
            <tr><th class="c-name">Workflow</th><th class="c-crit">Criticality</th><th class="c-owner">Owner</th><th class="c-inst">Instance</th><th class="c-health">Health</th><th class="c-rate">Failure rate</th><th class="c-last">Last run</th></tr>
          </thead>
          <tbody>
            <tr v-for="w in paged.paged.value" :key="w.instanceId + '/' + w.id" class="row" tabindex="0" @click="selected = w" @keydown.enter="selected = w">
              <td class="c-name" data-label="Workflow">{{ w.name }}</td>
              <td class="c-crit" data-label="Criticality"><EnrichmentBadges :enrichment="w.enrichment" /><span v-if="!w.enrichment?.criticality" class="muted">—</span></td>
              <td class="c-owner" data-label="Owner" data-testid="incident-owner"><OwnerBadge :owner="w.owner" /></td>
              <td class="c-inst" data-label="Instance"><span class="instance"><span class="dot" :style="{ background: instanceColor(w.instanceId) }" />{{ w.instanceLabel }}</span></td>
              <td class="c-health" data-label="Health"><WorkflowHealthBadge :health="w.health" /></td>
              <td class="c-rate" data-label="Failure rate">{{ pct(w) }} <span class="muted">({{ w.health?.failuresInWindow ?? 0 }}/{{ w.health?.runsInWindow ?? 0 }})</span></td>
              <td class="c-last muted" data-label="Last run">{{ relativeTime(w.health?.lastRunAt ?? null, now) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ListPager :page="paged.page.value" :page-size="PAGE_SIZE" :total="paged.total.value" label="Health pages" @go="paged.go($event)" />
    </template>

    <WorkflowDetailDrawer :selected="selected" @close="selected = null" />
  </section>
</template>

<style scoped>
.health { display: flex; flex-direction: column; gap: var(--spacing--sm); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--md); flex-wrap: wrap; }
h1 { margin: 0; font-size: var(--font-size--xl); font-weight: var(--font-weight--bold); }
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--sm); }
.head-right { display: flex; align-items: center; gap: var(--spacing--sm); flex-wrap: wrap; }
.synced { font-size: var(--font-size--2xs); }

.warnbar {
  color: var(--color--danger);
  border-color: var(--border-color--danger, var(--border-color));
  font-size: var(--font-size--sm);
}
.warnbar code { font-family: var(--font-family--monospace); }

/* Summary strip = posture + the primary filter (tiles are buttons). Matches the
   Ownership register's stat tiles exactly, so the two Estate views read as one system. */
.summary { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; }
.stat {
  flex: 1 1 8rem; min-width: 7.5rem; display: flex; flex-direction: column; gap: var(--spacing--5xs);
  padding: var(--spacing--2xs) var(--spacing--sm);
  border: 1px solid var(--border-color--subtle); border-radius: var(--radius--lg);
  background: var(--background--surface); text-align: left;
}
.stat--btn { appearance: none; font: inherit; cursor: pointer; transition: border-color var(--duration--snappy, 0.12s) ease; }
.stat--btn:hover { border-color: var(--border-color--strong, var(--border-color)); }
.stat--btn.on { border-color: var(--background--brand); box-shadow: inset 0 0 0 1px var(--background--brand); }
.stat .n { font-size: var(--font-size--xl); font-weight: var(--font-weight--bold); line-height: 1; font-variant-numeric: tabular-nums; }
.stat .lbl { font-size: var(--font-size--3xs); color: var(--color--text--shade-1); opacity: 0.7; }
.stat--ok .n { color: var(--color--success); }
.stat--danger .n { color: var(--color--danger); }
.stat--warn .n { color: var(--color--warning); }
.stat--muted .n { color: var(--color--text--shade-1); opacity: 0.6; }

/* Scope + search — same markup/styles as the Ownership register (consistency). */
.bar { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; align-items: center; }
.seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--radius--md); overflow: hidden; flex-wrap: wrap; }
.seg button {
  appearance: none; border: 0; border-right: 1px solid var(--border-color); background: var(--background--surface);
  color: var(--color--text--shade-1); font: inherit; font-size: var(--font-size--2xs); padding: var(--spacing--4xs) var(--spacing--2xs);
  cursor: pointer; display: inline-flex; align-items: center; gap: var(--spacing--4xs); white-space: nowrap;
}
.seg button:last-child { border-right: 0; }
.seg button:hover:not(.on) { background: var(--background--subtle); }
.seg button.on { background: var(--background--brand); color: var(--color--neutral-white); }
.search { max-width: 18rem; flex: 1 1 12rem; }

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
.c-rate { font-variant-numeric: tabular-nums; white-space: nowrap; }
.c-last { white-space: nowrap; font-size: var(--font-size--2xs); }
.instance { display: inline-flex; align-items: center; gap: var(--spacing--4xs); white-space: nowrap; }
.dot { width: 0.5rem; height: 0.5rem; border-radius: var(--radius--full); flex: none; }
.empty { text-align: center; }
.empty p { margin: 0; }
.pad { padding: var(--spacing--md) 0; }
.err { color: var(--color--danger); }

/* Mobile (≤720px): tables reflow to stacked cards — never a horizontal page scroll. */
@media (max-width: 720px) {
  .search { max-width: none; flex: 1 1 100%; }
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
    flex: 0 0 6rem;
    color: var(--color--text--shade-1); opacity: 0.6;
    font-size: var(--font-size--3xs); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide);
  }
  .c-name { font-size: var(--font-size--md); }
  /* Highlight the whole card, not individual cells. */
  .row:hover td, .row:focus-visible td { background: transparent; }
  .row:hover, .row:focus-visible { background: var(--background--hover, var(--background--subtle)); }
}
</style>
