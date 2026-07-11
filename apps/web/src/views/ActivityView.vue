<script setup lang="ts">
// The Activity view: the Argus self-audit timeline — every governance action Argus
// has taken, append-only and tamper-evident. Filterable by action + actor, and
// CSV-exportable. Read-only; honest states only (rule 5): empty reads as "nothing
// matches", errors show a plain-English reason. (Split out of the Ownership lens so
// the audit trail has its own home in the side panel.)
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useOwnershipStore } from '../stores/ownership';
import { relativeTime } from '../lib/time';

const store = useOwnershipStore();
const { audit, auditState, auditError, filters, auditPage } = storeToRefs(store);
const pageSize = store.auditPageSize;

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

// Pagination readouts — a plain-English "Showing X–Y of N" plus prev/next gating.
const total = computed(() => audit.value?.total ?? 0);
const shown = computed(() => audit.value?.entries.length ?? 0);
const rangeStart = computed(() => (total.value === 0 ? 0 : auditPage.value * pageSize + 1));
const rangeEnd = computed(() => auditPage.value * pageSize + shown.value);
const hasPrev = computed(() => auditPage.value > 0);
const hasNext = computed(() => rangeEnd.value < total.value);

async function refresh(): Promise<void> {
  await store.applyAuditFilters();
}
function applyFilters(): void {
  void store.applyAuditFilters();
}
function prevPage(): void {
  void store.goToAuditPage(auditPage.value - 1);
}
function nextPage(): void {
  void store.goToAuditPage(auditPage.value + 1);
}

onMounted(async () => {
  await refresh();
  clock = setInterval(() => (now.value = Date.now()), 1_000);
});
onUnmounted(() => { if (clock) clearInterval(clock); });
</script>

<template>
  <section class="activity" data-testid="activity-view">
    <header class="head">
      <div>
        <h1>Activity</h1>
        <p class="muted sub">Every governance action Argus has taken — append-only, tamper-evident.</p>
      </div>
      <div class="head-actions">
        <a class="btn btn--secondary btn--sm" data-testid="governance-audit-export" :href="store.exportUrl()">Export CSV</a>
        <button class="btn btn--secondary btn--sm" data-testid="refresh-button" @click="refresh">Refresh</button>
      </div>
    </header>

    <div class="filters">
      <select v-model="filters.action" class="input" aria-label="Filter by action" data-testid="audit-filter-action" @change="applyFilters">
        <option value="">All actions</option>
        <option v-for="a in audit?.actions ?? []" :key="a" :value="a">{{ a }}</option>
      </select>
      <input v-model="filters.actor" class="input" placeholder="Filter by actor name or email" aria-label="Filter by actor name or email" data-testid="audit-filter-actor" @keydown.enter="applyFilters">
      <button class="btn btn--secondary btn--sm" @click="applyFilters">Apply</button>
    </div>

    <div class="table-wrap" data-testid="governance-audit-timeline">
      <p v-if="auditState === 'loading'" class="muted pad">Loading the audit timeline…</p>
      <p v-else-if="auditState === 'error'" class="err pad" role="alert">Couldn’t load the audit timeline — {{ auditError }}.</p>
      <p v-else-if="(audit?.entries.length ?? 0) === 0" class="muted pad">No audit entries match.</p>
      <table v-else class="wf">
        <thead>
          <tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr>
        </thead>
        <tbody>
          <tr v-for="e in audit?.entries ?? []" :key="e.id">
            <td class="c-when muted" data-label="When" :title="e.ts">{{ relativeTime(e.ts, now) }}</td>
            <td data-label="Actor"><span class="actor">{{ e.actorName }}</span> <span class="muted small">{{ e.actorEmail }}</span></td>
            <td data-label="Action"><span class="mono">{{ e.action }}</span></td>
            <td class="c-entity muted" data-label="Entity" :title="e.entityId ?? e.entityType"><span class="mono">{{ e.entityId ?? e.entityType }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <nav v-if="auditState === 'ok' && total > 0" class="pager" aria-label="Audit timeline pages" data-testid="audit-pager">
      <span class="muted range" data-testid="audit-pager-range">{{ rangeStart }}–{{ rangeEnd }} of {{ total }}</span>
      <div class="pager-btns">
        <button class="btn btn--secondary btn--sm" :disabled="!hasPrev" data-testid="audit-pager-prev" @click="prevPage">Previous</button>
        <button class="btn btn--secondary btn--sm" :disabled="!hasNext" data-testid="audit-pager-next" @click="nextPage">Next</button>
      </div>
    </nav>
  </section>
</template>

<style scoped>
.activity { display: flex; flex-direction: column; gap: var(--spacing--md); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--md); flex-wrap: wrap; }
.head-actions { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; align-items: center; }
.head-actions a { text-decoration: none; }
h1 { margin: 0; font-size: var(--font-size--xl); font-weight: var(--font-weight--bold); }
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--sm); }

.filters { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; align-items: center; }
.filters .input { max-width: 16rem; }

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
.c-when { white-space: nowrap; font-size: var(--font-size--2xs); }
.actor { font-weight: var(--font-weight--medium); }
.small { font-size: var(--font-size--2xs); }
/* Entity is often a long uuid — truncate with an ellipsis (full value on hover) so it
   never widens the column into a horizontal scroll. */
.c-entity { font-size: var(--font-size--2xs); max-width: 18rem; }
.c-entity .mono { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }

.pad { padding: var(--spacing--md); }
.err { color: var(--color--danger); }

.pager { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm); flex-wrap: wrap; }
.pager .range { font-size: var(--font-size--2xs); font-variant-numeric: tabular-nums; }
.pager-btns { display: flex; gap: var(--spacing--2xs); }
.pager-btns .btn:disabled { opacity: 0.45; cursor: not-allowed; }

/* Mobile (≤720px): the audit table reflows to stacked cards; no horizontal scroll. */
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
    content: attr(data-label); flex: 0 0 4rem;
    color: var(--color--text--shade-1); opacity: 0.6;
    font-size: var(--font-size--3xs); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide);
  }
  .filters .input { max-width: none; flex: 1 1 100%; }
}
</style>
