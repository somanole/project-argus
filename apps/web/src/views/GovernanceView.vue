<script setup lang="ts">
// The Governance view (S4): the ownership governance gaps + the Argus self-audit
// timeline. Read-only surfaces; assignment happens in the workflow drawer. Honest
// states only (rule 5): empty gaps read as "nothing here", errors show a reason.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useOwnershipStore } from '../stores/ownership';
import type { Criticality, GapWorkflow } from '@argus/shared';
import FactBadge from '../components/FactBadge.vue';
import { instanceColor } from '../lib/instanceColor';
import { relativeTime } from '../lib/time';

const store = useOwnershipStore();
const { gaps, gapsState, gapsError, audit, auditState, auditError, filters } = storeToRefs(store);

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

const CRIT_TONE: Record<Criticality, 'danger' | 'warn' | 'muted'> = { critical: 'danger', high: 'warn', medium: 'muted', low: 'muted' };
const critTone = (c: Criticality | null): 'danger' | 'warn' | 'muted' => (c ? CRIT_TONE[c] : 'muted');

const unowned = computed(() => gaps.value?.unowned ?? []);
const singleOwner = computed(() => gaps.value?.singleOwnerCritical ?? []);
const personalSpace = computed(() => gaps.value?.personalSpaceCritical ?? []);
const noBackup = computed(() => gaps.value?.noBackupOwner ?? []);
const gapTotal = computed(() => unowned.value.length + singleOwner.value.length + personalSpace.value.length + noBackup.value.length);

const wfLabel = (w: GapWorkflow): string => w.name;

async function refresh(): Promise<void> {
  await Promise.all([store.refreshGaps(), store.refreshAudit()]);
}
function applyFilters(): void {
  void store.refreshAudit();
}

onMounted(async () => {
  await refresh();
  clock = setInterval(() => (now.value = Date.now()), 1_000);
});
onUnmounted(() => { if (clock) clearInterval(clock); });
</script>

<template>
  <section class="gov" data-testid="governance-view">
    <header class="head">
      <div>
        <h1>Governance</h1>
        <p class="muted sub">Who is accountable across the estate — the ownership gaps, and every governance action Argus has taken.</p>
      </div>
      <button class="btn btn--secondary btn--sm" data-testid="refresh-button" @click="refresh">Refresh</button>
    </header>

    <!-- ── Governance gaps ─────────────────────────────────────────────── -->
    <div class="gaps" data-testid="governance-gaps">
      <p v-if="gapsState === 'loading'" class="muted pad">Assessing governance gaps…</p>
      <p v-else-if="gapsState === 'error'" class="err pad" role="alert">Couldn’t load governance gaps — {{ gapsError }}.</p>
      <div v-else-if="gapTotal === 0" class="card empty"><p>No governance gaps — every critical workflow has an accountable, backed-up owner.</p></div>

      <template v-else>
        <!-- What has no owner -->
        <section v-if="unowned.length" class="gap" data-testid="gap-unowned">
          <h2 class="gap-title">What has no owner <span class="count">{{ unowned.length }}</span></h2>
          <p class="gap-why muted">Workflows with no assigned owner — critical first. Assign one from the workflow drawer.</p>
          <ul class="rows">
            <li v-for="w in unowned" :key="w.instanceId + '/' + w.workflowId" class="grow">
              <FactBadge :label="w.criticality ?? 'unlabeled'" :tone="critTone(w.criticality)" />
              <span class="wf">{{ wfLabel(w) }}</span>
              <span class="inst muted"><span class="dot" :style="{ background: instanceColor(w.instanceId) }" />{{ w.instanceLabel }}</span>
              <span v-if="w.inferred?.status === 'inferred'" class="muted small">inferred: {{ w.inferred.owner?.name ?? w.inferred.owner?.email }}</span>
            </li>
          </ul>
        </section>

        <!-- Single-owner-critical (cross-instance SPOF) -->
        <section v-if="singleOwner.length" class="gap" data-testid="gap-single-owner">
          <h2 class="gap-title">Single owner of multiple criticals <span class="count">{{ singleOwner.length }}</span></h2>
          <p class="gap-why muted">One person is the sole owner of several critical workflows — a single point of failure.</p>
          <ul class="rows">
            <li v-for="(g, i) in singleOwner" :key="i" class="spof">
              <div class="spof-head">
                <strong>{{ g.owner.name ?? g.owner.email }}</strong>
                <span class="muted small">{{ g.owner.email }}</span>
                <FactBadge :label="`${g.workflows.length} critical`" tone="danger" />
                <FactBadge v-if="g.crossInstance" label="across instances" tone="warn" />
              </div>
              <ul class="spof-wfs">
                <li v-for="w in g.workflows" :key="w.instanceId + '/' + w.workflowId">
                  <span class="wf">{{ w.name }}</span>
                  <span class="inst muted"><span class="dot" :style="{ background: instanceColor(w.instanceId) }" />{{ w.instanceLabel }}</span>
                </li>
              </ul>
            </li>
          </ul>
        </section>

        <!-- Personal-space-critical -->
        <section v-if="personalSpace.length" class="gap" data-testid="gap-personal-space">
          <h2 class="gap-title">Critical work in a personal space <span class="count">{{ personalSpace.length }}</span></h2>
          <p class="gap-why muted">Business-critical workflows living in someone’s personal project, not a shared team project.</p>
          <ul class="rows">
            <li v-for="w in personalSpace" :key="w.instanceId + '/' + w.workflowId" class="grow">
              <FactBadge :label="w.criticality ?? 'critical'" :tone="critTone(w.criticality)" />
              <span class="wf">{{ w.name }}</span>
              <span class="inst muted"><span class="dot" :style="{ background: instanceColor(w.instanceId) }" />{{ w.instanceLabel }}</span>
              <span v-if="w.person" class="muted small">{{ w.person.name ?? w.person.email }}’s space</span>
            </li>
          </ul>
        </section>

        <!-- No backup owner -->
        <section v-if="noBackup.length" class="gap" data-testid="gap-no-backup">
          <h2 class="gap-title">Critical, no backup owner <span class="count">{{ noBackup.length }}</span></h2>
          <p class="gap-why muted">Assigned critical workflows with no backup owner — one person away from unowned.</p>
          <ul class="rows">
            <li v-for="w in noBackup" :key="w.instanceId + '/' + w.workflowId" class="grow">
              <FactBadge :label="w.criticality ?? 'critical'" :tone="critTone(w.criticality)" />
              <span class="wf">{{ w.name }}</span>
              <span class="inst muted"><span class="dot" :style="{ background: instanceColor(w.instanceId) }" />{{ w.instanceLabel }}</span>
              <span class="muted small">owner: {{ w.owner.name ?? w.owner.email }}</span>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <!-- ── Audit timeline ──────────────────────────────────────────────── -->
    <section class="audit">
      <div class="audit-head">
        <h2 class="gap-title">Audit timeline</h2>
        <a class="btn btn--secondary btn--sm" data-testid="governance-audit-export" :href="store.exportUrl()">Export CSV</a>
      </div>
      <p class="gap-why muted">Every governance action Argus has taken — append-only, tamper-evident.</p>

      <div class="filters">
        <select v-model="filters.action" class="input" aria-label="Filter by action" data-testid="audit-filter-action" @change="applyFilters">
          <option value="">All actions</option>
          <option v-for="a in audit?.actions ?? []" :key="a" :value="a">{{ a }}</option>
        </select>
        <input v-model="filters.actor" class="input" placeholder="Filter by actor email" aria-label="Filter by actor" data-testid="audit-filter-actor" @keydown.enter="applyFilters">
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
              <td class="c-entity muted" data-label="Entity"><span class="mono">{{ e.entityId ?? e.entityType }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>

<style scoped>
.gov { display: flex; flex-direction: column; gap: var(--spacing--md); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--md); flex-wrap: wrap; }
h1 { margin: 0; font-size: var(--font-size--xl); font-weight: var(--font-weight--bold); }
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--sm); }

.gaps { display: flex; flex-direction: column; gap: var(--spacing--md); }
.gap { display: flex; flex-direction: column; gap: var(--spacing--2xs); }
.gap-title { margin: 0; font-size: var(--font-size--md); font-weight: var(--font-weight--bold); }
.gap-title .count { font-size: var(--font-size--2xs); font-weight: var(--font-weight--medium); opacity: 0.6; font-variant-numeric: tabular-nums; }
.gap-why { margin: 0; font-size: var(--font-size--2xs); }

.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--4xs); }
.grow, .spof {
  display: flex; align-items: center; gap: var(--spacing--sm); flex-wrap: wrap;
  padding: var(--spacing--2xs) var(--spacing--sm);
  border: 1px solid var(--border-color--subtle); border-radius: var(--radius--md);
  background: var(--background--surface); font-size: var(--font-size--sm);
}
.spof { flex-direction: column; align-items: stretch; gap: var(--spacing--4xs); }
.spof-head { display: flex; align-items: center; gap: var(--spacing--2xs); flex-wrap: wrap; }
.spof-wfs { list-style: none; margin: 0; padding: 0 0 0 var(--spacing--sm); display: flex; flex-direction: column; gap: var(--spacing--5xs); }
.spof-wfs li { display: flex; gap: var(--spacing--sm); align-items: center; flex-wrap: wrap; font-size: var(--font-size--2xs); }
.wf { font-weight: var(--font-weight--medium); }
.inst { display: inline-flex; align-items: center; gap: var(--spacing--4xs); white-space: nowrap; }
.dot { width: 0.5rem; height: 0.5rem; border-radius: var(--radius--full); flex: none; }
.small { font-size: var(--font-size--2xs); }

.audit { display: flex; flex-direction: column; gap: var(--spacing--2xs); }
.audit-head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm); flex-wrap: wrap; }
.audit-head a { text-decoration: none; }
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
.c-entity { font-size: var(--font-size--2xs); }

.card.empty { text-align: center; }
.card.empty p { margin: 0; }
.pad { padding: var(--spacing--md); }
.err { color: var(--text-color--danger, var(--color--danger)); }

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
