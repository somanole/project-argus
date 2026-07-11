<script setup lang="ts">
// The Governance view (S4): the ownership governance gaps. Read-only surface;
// assignment happens in the workflow drawer. Honest states only (rule 5): empty gaps
// read as "nothing here", errors show a reason. (The Argus self-audit timeline lives
// in its own Activity view.)
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useOwnershipStore } from '../stores/ownership';
import type { Criticality, GapWorkflow } from '@argus/shared';
import FactBadge from '../components/FactBadge.vue';
import { instanceColor } from '../lib/instanceColor';

const store = useOwnershipStore();
const { gaps, gapsState, gapsError } = storeToRefs(store);
const route = useRoute();

const CRIT_TONE: Record<Criticality, 'danger' | 'warn' | 'muted' | 'faint'> = { critical: 'danger', high: 'warn', medium: 'muted', low: 'faint' };
const critTone = (c: Criticality | null): 'danger' | 'warn' | 'muted' | 'faint' => (c ? CRIT_TONE[c] : 'muted');

const unowned = computed(() => gaps.value?.unowned ?? []);
// The unowned list can be the whole estate (hundreds). Show the most-critical first
// N and let the owner expand — so the audit timeline below stays reachable without a
// 20,000px scroll. Nothing is hidden: the full count sits in the section header.
const UNOWNED_PREVIEW = 25;
const showAllUnowned = ref(false);
const unownedShown = computed(() => (showAllUnowned.value ? unowned.value : unowned.value.slice(0, UNOWNED_PREVIEW)));
const singleOwner = computed(() => gaps.value?.singleOwnerCritical ?? []);
const personalSpace = computed(() => gaps.value?.personalSpaceCritical ?? []);
const noBackup = computed(() => gaps.value?.noBackupOwner ?? []);
const gapTotal = computed(() => unowned.value.length + singleOwner.value.length + personalSpace.value.length + noBackup.value.length);

const wfLabel = (w: GapWorkflow): string => w.name;

async function refresh(): Promise<void> {
  await store.refreshGaps();
}

/** Deep-link support: scroll to the gap section named in the URL hash (e.g. #gap-unowned). */
async function scrollToHash(): Promise<void> {
  const id = (route?.hash ?? '').replace(/^#/, '');
  if (!id) return;
  await nextTick();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

onMounted(async () => {
  await refresh();
  await scrollToHash();
});
</script>

<template>
  <section class="gov" data-testid="governance-view">
    <header class="head">
      <div>
        <p class="muted sub">Who is accountable across the estate — the ownership gaps that need a human owner.</p>
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
        <section v-if="unowned.length" id="gap-unowned" class="gap" data-testid="gap-unowned">
          <h2 class="gap-title">What has no owner <span class="count">{{ unowned.length }}</span></h2>
          <p class="gap-why muted">Workflows with no assigned owner — critical first. Assign one from the workflow drawer.</p>
          <ul class="rows">
            <li v-for="w in unownedShown" :key="w.instanceId + '/' + w.workflowId" class="grow">
              <FactBadge :label="w.criticality ?? 'unlabeled'" :tone="critTone(w.criticality)" />
              <span class="wf">{{ wfLabel(w) }}</span>
              <span class="inst muted"><span class="dot" :style="{ background: instanceColor(w.instanceId) }" />{{ w.instanceLabel }}</span>
              <span v-if="w.inferred?.status === 'inferred'" class="muted small">{{ w.inferred.owner?.name ?? w.inferred.owner?.email }} · inferred</span>
            </li>
          </ul>
          <button
            v-if="unowned.length > UNOWNED_PREVIEW"
            class="btn btn--secondary btn--sm show-more"
            data-testid="gap-unowned-toggle"
            @click="showAllUnowned = !showAllUnowned"
          >
            {{ showAllUnowned ? 'Show fewer' : `Show all ${unowned.length}` }}
          </button>
        </section>

        <!-- Single-owner-critical (cross-instance SPOF) -->
        <section v-if="singleOwner.length" id="gap-single-owner" class="gap" data-testid="gap-single-owner">
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
        <section v-if="personalSpace.length" id="gap-personal-space" class="gap" data-testid="gap-personal-space">
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
.show-more { align-self: flex-start; margin-top: var(--spacing--3xs); }

.card.empty { text-align: center; }
.card.empty p { margin: 0; }
.pad { padding: var(--spacing--md); }
.err { color: var(--color--danger); }
</style>
