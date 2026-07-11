<script setup lang="ts">
// The Ownership Estate view (S4) — the estate's accountability REGISTER. Consistent with
// Explore/Health: a crisp subtitle, a clickable summary strip, and one clickable table of
// workflows focused on ownership (owner · backup · risk), server-paginated. Rows open the
// shared detail drawer, where the assign-owner dialog lives — so this is where you FIX
// accountability, not just view gaps. Honest by construction (rule 5 + rule 12): factual
// ownership = an assigned owner; an inferred owner is advisory and reads "no confirmed owner".
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useOwnershipRegisterStore, type RegisterView } from '../stores/ownership-register';
import { useConnectionsStore } from '../stores/connections';
import type { OwnershipRisk, WorkflowListItem } from '@argus/shared';
import EnrichmentBadges from '../components/EnrichmentBadges.vue';
import OwnerBadge from '../components/OwnerBadge.vue';
import FactBadge from '../components/FactBadge.vue';
import WorkflowDetailDrawer from '../components/WorkflowDetailDrawer.vue';
import ListPager from '../components/ListPager.vue';
import { instanceColor } from '../lib/instanceColor';

const store = useOwnershipRegisterStore();
const connections = useConnectionsStore();
const { rows, summary, total, state, error, page, view, instanceId } = storeToRefs(store);
const pageSize = store.pageSize;
const route = useRoute();

// Clicking a row opens the shared detail drawer (owner section + assign dialog).
const selected = ref<WorkflowListItem | null>(null);

// The summary strip doubles as the primary filter — each tile switches the working set.
// Literal testids (not built) so the verify presence-grep finds them in the bundle.
const TILES: { view: RegisterView; testid: string; label: string; tone: 'danger' | 'warn' | 'muted' | 'ok'; count: (s: NonNullable<typeof summary.value>) => number }[] = [
  { view: 'needs-owner', testid: 'ownership-filter-needs-owner', label: 'Needs a confirmed owner', tone: 'warn', count: (s) => s.inferred + s.unowned },
  { view: 'unowned', testid: 'ownership-filter-unowned', label: 'No owner at all', tone: 'danger', count: (s) => s.unowned },
  { view: 'critical-at-risk', testid: 'ownership-filter-critical-at-risk', label: 'Critical at risk', tone: 'danger', count: (s) => s.criticalAtRisk },
  { view: 'no-backup', testid: 'ownership-filter-no-backup', label: 'No backup', tone: 'muted', count: (s) => s.noBackup },
];

const RISK_LABEL: Record<OwnershipRisk, string> = {
  'no-confirmed-owner': 'no confirmed owner',
  spof: 'single point of failure',
  'personal-space': 'personal space',
  'no-backup': 'no backup',
};
const RISK_TONE: Record<OwnershipRisk, 'danger' | 'warn' | 'muted'> = {
  'no-confirmed-owner': 'warn',
  spof: 'danger',
  'personal-space': 'warn',
  'no-backup': 'muted',
};

const backupName = (w: WorkflowListItem): string =>
  w.owner?.backupOwner?.name ?? w.owner?.backupOwner?.email ?? '—';

const instances = computed(() => connections.connections.map((c) => ({ id: c.id, label: c.label })));

// Debounced search.
const qInput = ref('');
let qTimer: ReturnType<typeof setTimeout> | undefined;
watch(qInput, (v) => {
  if (qTimer) clearTimeout(qTimer);
  qTimer = setTimeout(() => store.setQuery(v), 250);
});

async function refresh(): Promise<void> {
  await Promise.all([store.refresh(), connections.refresh()]);
}

onMounted(async () => {
  // Deep-links (e.g. Overview tiles) carry ?view=… — apply before the first load.
  store.applyFromQuery(route?.query ?? {});
  qInput.value = store.q;
  await refresh();
});
</script>

<template>
  <section class="own" data-testid="governance-view">
    <header class="head">
      <div>
        <p class="muted sub">Who owns what across the estate — assign owners and close accountability gaps.</p>
      </div>
      <button class="btn btn--secondary btn--sm" data-testid="refresh-button" @click="refresh">Refresh</button>
    </header>

    <!-- ── Accountability posture (also the primary filter) ────────────────── -->
    <div v-if="summary" class="summary" data-testid="ownership-summary">
      <button
        class="stat stat--btn stat--ok"
        :class="{ on: view === 'confirmed' }"
        data-testid="ownership-confirmed"
        :aria-pressed="view === 'confirmed'"
        @click="store.setView('confirmed')"
      >
        <span class="n">{{ summary.confirmed }}</span><span class="lbl">confirmed of {{ summary.total }}</span>
      </button>
      <button
        v-for="t in TILES"
        :key="t.view"
        class="stat stat--btn"
        :class="[`stat--${t.tone}`, { on: view === t.view }]"
        :data-testid="t.testid"
        :aria-pressed="view === t.view"
        @click="store.setView(t.view)"
      >
        <span class="n">{{ t.count(summary) }}</span><span class="lbl">{{ t.label }}</span>
      </button>
    </div>

    <!-- ── Scope + search ─────────────────────────────────────────────────── -->
    <div class="bar">
      <div class="seg seg--sm" role="group" aria-label="Scope by instance" data-testid="ownership-scope">
        <button :class="{ on: instanceId === 'all' }" @click="store.setInstance('all')">All estate</button>
        <button v-for="i in instances" :key="i.id" :class="{ on: instanceId === i.id }" @click="store.setInstance(i.id)">
          <span class="dot" :style="{ background: instanceColor(i.id) }" />{{ i.label }}
        </button>
      </div>
      <input v-model="qInput" class="input search" type="search" placeholder="Search by name…" aria-label="Search workflows by name" data-testid="ownership-search">
      <button v-if="view !== 'all'" class="linkish" data-testid="ownership-show-all" @click="store.setView('all')">Show all {{ summary?.total ?? '' }}</button>
    </div>

    <!-- ── The register table ─────────────────────────────────────────────── -->
    <p v-if="state === 'loading'" class="muted pad">Assessing ownership across the estate…</p>
    <p v-else-if="state === 'error'" class="err pad" role="alert">Couldn’t load the ownership register — {{ error }}.</p>
    <div v-else-if="total === 0" class="card empty" data-testid="ownership-empty">
      <p>Nothing here — no workflows match this filter.</p>
    </div>

    <template v-else>
      <div class="table-wrap" data-testid="ownership-register">
        <table class="wf">
          <thead>
            <tr><th class="c-name">Workflow</th><th class="c-owner">Owner</th><th class="c-backup">Backup</th><th class="c-risk">Risk</th><th class="c-inst">Instance</th></tr>
          </thead>
          <tbody>
            <tr v-for="w in rows" :key="w.instanceId + '/' + w.id" class="row" tabindex="0" @click="selected = w" @keydown.enter="selected = w">
              <td class="c-name" data-label="Workflow">
                <span class="name-cell"><span class="name">{{ w.name }}</span><EnrichmentBadges :enrichment="w.enrichment" /></span>
              </td>
              <td class="c-owner" data-label="Owner"><OwnerBadge :owner="w.owner" /></td>
              <td class="c-backup muted" data-label="Backup">{{ backupName(w) }}</td>
              <td class="c-risk" data-label="Risk">
                <span v-if="w.risks.length" class="risks">
                  <FactBadge v-for="r in w.risks" :key="r" :label="RISK_LABEL[r]" :tone="RISK_TONE[r]" />
                </span>
                <span v-else class="muted">—</span>
              </td>
              <td class="c-inst" data-label="Instance"><span class="instance"><span class="dot" :style="{ background: instanceColor(w.instanceId) }" />{{ w.instanceLabel }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <ListPager :page="page" :page-size="pageSize" :total="total" label="Ownership pages" @go="store.goToPage($event)" />
    </template>

    <WorkflowDetailDrawer :selected="selected" @close="selected = null" />
  </section>
</template>

<style scoped>
.own { display: flex; flex-direction: column; gap: var(--spacing--sm); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--md); flex-wrap: wrap; }
.sub { margin: 0; font-size: var(--font-size--sm); }

/* Summary strip = posture + the primary filter (tiles are buttons). */
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
.linkish { appearance: none; border: 0; background: none; color: var(--background--brand); font: inherit; font-size: var(--font-size--2xs); cursor: pointer; padding: 0; }

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
.row:hover td { background: var(--background--hover, var(--background--subtle)); }
.row:focus-visible { outline: 2px solid var(--background--brand); outline-offset: -2px; }
.c-name { font-weight: var(--font-weight--medium); min-width: 13rem; }
.name-cell { display: flex; align-items: center; gap: var(--spacing--4xs); flex-wrap: wrap; }
.name-cell .name { flex: 0 0 100%; }
.c-backup { font-size: var(--font-size--2xs); }
.risks { display: inline-flex; gap: var(--spacing--4xs); flex-wrap: wrap; }
.instance { display: inline-flex; align-items: center; gap: var(--spacing--4xs); white-space: nowrap; }
.dot { width: 0.5rem; height: 0.5rem; border-radius: var(--radius--full); flex: none; }

.card.empty { text-align: center; }
.card.empty p { margin: 0; }
.pad { padding: var(--spacing--md); }
.err { color: var(--color--danger); }

/* Mobile (≤720px): the register reflows to stacked cards; no horizontal scroll. */
@media (max-width: 720px) {
  .table-wrap { border: 0; overflow: visible; }
  .wf, .wf tbody, .wf tr, .wf td { display: block; width: 100%; }
  .wf thead { display: none; }
  .wf tbody tr {
    border: 1px solid var(--border-color--subtle); border-radius: var(--radius--md);
    margin-bottom: var(--spacing--2xs); padding: var(--spacing--2xs) var(--spacing--sm);
    background: var(--background--surface);
  }
  .wf tbody td { border: 0; padding: var(--spacing--4xs) 0; display: flex; gap: var(--spacing--sm); align-items: baseline; }
  .wf tbody td[data-label]::before {
    content: attr(data-label); flex: 0 0 5rem;
    color: var(--color--text--shade-1); opacity: 0.6;
    font-size: var(--font-size--3xs); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide);
  }
  .c-name { min-width: 0; }
  .name-cell .name { flex: 1; }
  .search { max-width: none; flex: 1 1 100%; }
}
</style>
