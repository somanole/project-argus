<script setup lang="ts">
// The Governance overview (S6) — the one screen that says "here's the state of our
// estate". PURE COMPOSITION: every figure is the same read the individual views
// show (server-composed), and every number drills to the exact workflows behind it.
// Honest to the estate's uncertainty (rule 5): inferred owners are badged advisory,
// unavailable health is shown as unavailable (never "healthy"), and possible edges
// are excluded from exposure — none of it laundered into false precision.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useOverviewStore } from '../stores/overview';
import type { Criticality, ScorePillar } from '@argus/shared';
import FactBadge from '../components/FactBadge.vue';
import { instanceColor } from '../lib/instanceColor';
import { relativeTime } from '../lib/time';

const store = useOverviewStore();
const { data, state, error } = storeToRefs(store);

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

const CRIT_TONE: Record<Criticality, 'danger' | 'warn' | 'muted'> = { critical: 'danger', high: 'warn', medium: 'muted', low: 'muted' };
const critTone = (c: Criticality | null): 'danger' | 'warn' | 'muted' => (c ? CRIT_TONE[c] : 'muted');

const o = computed(() => data.value);
const score = computed(() => o.value?.score ?? null);
const unavailableInstances = computed(() => o.value?.health.windows.filter((w) => !w.available) ?? []);
// How many "no confirmed owner" workflows have an advisory inferred owner Argus can
// suggest (a lead to confirm — not counted as ownership by the score).
const advisoryCovered = computed(() => o.value?.unowned.workflows.filter((w) => w.inferred?.status === 'inferred').length ?? 0);
// Total failing + degraded (for context beside the confirmed-owner incident count).
const totalUnhealthy = computed(() => (o.value ? o.value.health.summary.failing + o.value.health.summary.degraded : 0));

/** Score → a semantic tone (drives the hero + pillar-bar color, tokens only). */
function scoreTone(n: number | null): 'ok' | 'warn' | 'danger' | 'muted' {
  if (n == null) return 'muted';
  if (n >= 80) return 'ok';
  if (n >= 50) return 'warn';
  return 'danger';
}
const pct = (n: number | null): string => (n == null ? '0%' : `${n}%`);
const weightPct = (p: ScorePillar): string => `${Math.round(p.weight * 100)}%`;

// Inline drill-down: each figure expands in place to its exact workflow set.
const expanded = ref<Set<string>>(new Set());
function toggle(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}
const isOpen = (key: string): boolean => expanded.value.has(key);

async function refresh(): Promise<void> {
  await store.refresh();
}

onMounted(async () => {
  await refresh();
  clock = setInterval(() => (now.value = Date.now()), 1_000);
});
onUnmounted(() => { if (clock) clearInterval(clock); });
</script>

<template>
  <section class="ov" data-testid="overview-view">
    <header class="head">
      <div>
        <h1>Governance overview</h1>
        <p class="muted sub">The state of the estate at a glance — ownership, health, resilience, hygiene and exposure, composed from every view. Every number drills to the workflows behind it.</p>
      </div>
      <div class="actions">
        <a class="btn btn--secondary btn--sm" data-testid="overview-export" :href="store.exportUrl()">Export report</a>
        <button class="btn btn--secondary btn--sm" data-testid="refresh-button" @click="refresh">Refresh</button>
      </div>
    </header>

    <p v-if="state === 'loading'" class="muted pad">Composing the estate’s governance state…</p>
    <p v-else-if="state === 'error'" class="err pad" role="alert">Couldn’t load the governance overview — {{ error }}.</p>

    <template v-else-if="o">
      <!-- Honest freshness: any instance whose health couldn't be read is surfaced, never hidden. -->
      <div v-if="unavailableInstances.length" class="warnbar" data-testid="overview-health-unavailable" role="status">
        Health is unavailable for {{ unavailableInstances.map((w) => w.instanceLabel).join(', ') }} — those workflows are excluded from the reliability score, never counted as healthy.
      </div>

      <!-- ── Governance score (the one composed computation) ─────────────── -->
      <div class="card score" data-testid="overview-score">
        <div class="score-hero">
          <div class="score-num" :class="`t-${scoreTone(score?.score ?? null)}`">
            {{ score?.score ?? '—' }}<span class="score-max">/100</span>
          </div>
          <div class="score-cap">
            <strong>Governance score</strong>
            <p class="muted small">A deterministic, explainable weighted average — every pillar shows what drove it. Not a black box.</p>
          </div>
        </div>
        <ul class="pillars" data-testid="overview-score-breakdown">
          <li v-for="p in score?.pillars ?? []" :key="p.key" class="pillar">
            <div class="pillar-top">
              <span class="pillar-label">{{ p.label }}</span>
              <span class="pillar-weight muted small">weight {{ weightPct(p) }}</span>
              <span class="pillar-score" :class="`t-${scoreTone(p.scored ? p.score : null)}`">
                {{ p.scored ? p.score : 'couldn’t score' }}
              </span>
            </div>
            <div class="bar"><div class="bar-fill" :class="`b-${scoreTone(p.scored ? p.score : null)}`" :style="{ width: p.scored ? pct(p.score) : '0%' }" /></div>
            <p class="pillar-why muted small">{{ p.reason }}</p>
          </li>
        </ul>
      </div>

      <div class="grid">
        <!-- ── Unowned by criticality ───────────────────────────────────── -->
        <section class="card fig" data-testid="overview-unowned">
          <button class="fig-head" :aria-expanded="isOpen('unowned')" @click="toggle('unowned')">
            <span class="fig-title">No assigned owner</span>
            <span class="fig-count" :class="{ 'is-bad': o.unowned.total > 0 }">{{ o.unowned.total }}</span>
          </button>
          <p class="fig-why muted small">
            Workflows with no <em>confirmed</em> owner — the accountability gap that drives the ownership score.
            <template v-if="advisoryCovered > 0">Argus can <strong>suggest</strong> an owner for {{ advisoryCovered }} of them from n8n membership, but inference is a lead to confirm — not ownership. Assign a person to actually close the gap.</template>
          </p>
          <div class="chips">
            <FactBadge v-if="o.unowned.byCriticality.critical" :label="`${o.unowned.byCriticality.critical} critical`" tone="danger" />
            <FactBadge v-if="o.unowned.byCriticality.high" :label="`${o.unowned.byCriticality.high} high`" tone="warn" />
            <FactBadge v-if="o.unowned.byCriticality.medium" :label="`${o.unowned.byCriticality.medium} medium`" tone="muted" />
            <FactBadge v-if="o.unowned.byCriticality.low" :label="`${o.unowned.byCriticality.low} low`" tone="muted" />
            <FactBadge v-if="o.unowned.byCriticality.none" :label="`${o.unowned.byCriticality.none} unlabeled`" tone="muted" />
            <span v-if="o.unowned.total === 0" class="muted small">Every workflow has an answerable owner.</span>
          </div>
          <ul v-if="isOpen('unowned')" class="drill" data-testid="overview-unowned-drill">
            <li v-for="w in o.unowned.workflows" :key="w.instanceId + '/' + w.workflowId">
              <FactBadge :label="w.criticality ?? 'unlabeled'" :tone="critTone(w.criticality)" />
              <span class="wf">{{ w.name }}</span>
              <span class="inst muted"><span class="dot" :style="{ background: instanceColor(w.instanceId) }" />{{ w.instanceLabel }}</span>
              <span v-if="w.inferred?.status === 'inferred'" class="advisory" data-testid="overview-advisory">advisory: {{ w.inferred.owner?.name ?? w.inferred.owner?.email }}</span>
            </li>
          </ul>
        </section>

        <!-- ── Single-point-of-failure owners ───────────────────────────── -->
        <section class="card fig" data-testid="overview-spof">
          <button class="fig-head" :aria-expanded="isOpen('spof')" @click="toggle('spof')">
            <span class="fig-title">Single-point-of-failure owners</span>
            <span class="fig-count" :class="{ 'is-bad': o.spofOwners.length > 0 }">{{ o.spofOwners.length }}</span>
          </button>
          <p class="fig-why muted small">One person is the sole owner of several critical workflows (exact-email — cross-instance identity is a later slice).</p>
          <ul v-if="isOpen('spof')" class="drill" data-testid="overview-spof-drill">
            <li v-for="(g, i) in o.spofOwners" :key="i" class="spof">
              <div class="spof-head">
                <strong>{{ g.owner.name ?? g.owner.email }}</strong>
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
            <li v-if="o.spofOwners.length === 0" class="muted small">No single-owner critical clusters.</li>
          </ul>
        </section>

        <!-- ── Failing-with-owner incidents ─────────────────────────────── -->
        <section class="card fig" data-testid="overview-incidents">
          <button class="fig-head" :aria-expanded="isOpen('incidents')" @click="toggle('incidents')">
            <span class="fig-title">Failing / degraded with a confirmed owner</span>
            <span class="fig-count" :class="{ 'is-bad': o.failingWithOwner.count > 0 }">{{ o.failingWithOwner.count }}</span>
          </button>
          <p class="fig-why muted small">
            The actionable incidents — a failing workflow and a real person to page.
            <template v-if="totalUnhealthy > 0">{{ totalUnhealthy }} failing/degraded in all; <strong>{{ totalUnhealthy - o.failingWithOwner.count }}</strong> have no confirmed owner to escalate to.</template>
            <router-link to="/health">Open Health →</router-link>
          </p>
          <ul v-if="isOpen('incidents')" class="drill" data-testid="overview-incidents-drill">
            <li v-for="w in o.failingWithOwner.workflows" :key="w.instanceId + '/' + w.id">
              <FactBadge v-if="w.enrichment?.criticality" :label="w.enrichment.criticality" :tone="critTone(w.enrichment.criticality)" />
              <span class="wf">{{ w.name }}</span>
              <span class="inst muted"><span class="dot" :style="{ background: instanceColor(w.instanceId) }" />{{ w.instanceLabel }}</span>
              <span v-if="w.health" class="rate" data-testid="overview-incident-rate">{{ Math.round((w.health.failureRate ?? 0) * 100) }}% failing</span>
              <span class="muted small">owner: {{ w.owner?.owner?.name ?? w.owner?.owner?.email }}</span>
            </li>
            <li v-if="o.failingWithOwner.count === 0" class="muted small">No owned workflow is failing.</li>
          </ul>
        </section>

        <!-- ── Hygiene ──────────────────────────────────────────────────── -->
        <section class="card fig" data-testid="overview-hygiene">
          <div class="fig-head static"><span class="fig-title">Hygiene</span></div>
          <ul class="subfigs">
            <li>
              <button class="subfig" :aria-expanded="isOpen('broken')" @click="toggle('broken')">
                <span>Broken references</span><span class="fig-count" :class="{ 'is-bad': o.hygiene.brokenRefs.count > 0 }">{{ o.hygiene.brokenRefs.count }}</span>
              </button>
              <ul v-if="isOpen('broken')" class="drill">
                <li v-for="w in o.hygiene.brokenRefs.workflows" :key="w.instanceId + '/' + w.id"><span class="wf">{{ w.name }}</span><span class="inst muted">{{ w.instanceLabel }}</span></li>
              </ul>
            </li>
            <li>
              <button class="subfig" :aria-expanded="isOpen('stale')" @click="toggle('stale')">
                <span>Stale analysis</span><span class="fig-count" :class="{ 'is-bad': o.hygiene.staleEnrichment.count > 0 }">{{ o.hygiene.staleEnrichment.count }}</span>
              </button>
              <ul v-if="isOpen('stale')" class="drill">
                <li v-for="w in o.hygiene.staleEnrichment.workflows" :key="w.instanceId + '/' + w.id"><span class="wf">{{ w.name }}</span><span class="inst muted">{{ w.instanceLabel }}</span></li>
              </ul>
            </li>
            <li>
              <button class="subfig" :aria-expanded="isOpen('noexec')" @click="toggle('noexec')">
                <span>Active, no executions</span><span class="fig-count" :class="{ 'is-bad': o.hygiene.activeNoExecutions.count > 0 }">{{ o.hygiene.activeNoExecutions.count }}</span>
              </button>
              <ul v-if="isOpen('noexec')" class="drill">
                <li v-for="w in o.hygiene.activeNoExecutions.workflows" :key="w.instanceId + '/' + w.id"><span class="wf">{{ w.name }}</span><span class="inst muted">{{ w.instanceLabel }}</span></li>
              </ul>
            </li>
          </ul>
        </section>

        <!-- ── MCP exposure surface ─────────────────────────────────────── -->
        <section class="card fig" data-testid="overview-exposure">
          <button class="fig-head" :aria-expanded="isOpen('exposure')" @click="toggle('exposure')">
            <span class="fig-title">MCP exposure surface</span>
            <span class="fig-count" :class="{ 'is-bad': o.exposure.reachingSensitive > 0 }">{{ o.exposure.mcpExposed }}</span>
          </button>
          <p class="fig-why muted small">
            {{ o.exposure.reachingSensitive }} reach a sensitive system ({{ o.exposure.reachingSensitiveUnowned }} unowned).
            <span data-testid="overview-possible-note">Confirmed reach only — inferred edges excluded.</span>
            <router-link to="/graph">Open Graph →</router-link>
          </p>
          <ul v-if="isOpen('exposure')" class="drill" data-testid="overview-exposure-drill">
            <li v-for="s in o.exposure.surfaces" :key="s.instanceId + '/' + s.workflowId">
              <FactBadge v-if="s.reachesSensitive" label="sensitive" tone="danger" />
              <span class="wf">{{ s.name }}</span>
              <span class="inst muted"><span class="dot" :style="{ background: instanceColor(s.instanceId) }" />{{ s.instanceLabel }}</span>
              <FactBadge v-if="!s.owned" label="unowned" tone="warn" />
              <span v-if="s.sensitiveSystems.length" class="muted small">→ {{ s.sensitiveSystems.join(', ') }}</span>
            </li>
            <li v-if="o.exposure.mcpExposed === 0" class="muted small">No MCP-exposed workflows — no external exposure surface.</li>
          </ul>
        </section>

        <!-- ── Personal-space-critical ──────────────────────────────────── -->
        <section class="card fig" data-testid="overview-personal-space">
          <button class="fig-head" :aria-expanded="isOpen('personal')" @click="toggle('personal')">
            <span class="fig-title">Critical work in personal space</span>
            <span class="fig-count" :class="{ 'is-bad': o.personalSpaceCritical.length > 0 }">{{ o.personalSpaceCritical.length }}</span>
          </button>
          <p class="fig-why muted small">Business-critical workflows in a personal project, not a shared team project.</p>
          <ul v-if="isOpen('personal')" class="drill" data-testid="overview-personal-space-drill">
            <li v-for="w in o.personalSpaceCritical" :key="w.instanceId + '/' + w.workflowId">
              <FactBadge :label="w.criticality ?? 'critical'" :tone="critTone(w.criticality)" />
              <span class="wf">{{ w.name }}</span>
              <span class="inst muted"><span class="dot" :style="{ background: instanceColor(w.instanceId) }" />{{ w.instanceLabel }}</span>
              <span v-if="w.person" class="muted small">{{ w.person.name ?? w.person.email }}’s space</span>
            </li>
            <li v-if="o.personalSpaceCritical.length === 0" class="muted small">None.</li>
          </ul>
        </section>
      </div>

      <!-- ── Changelog / audit timeline ─────────────────────────────────── -->
      <section class="card fig" data-testid="overview-changelog">
        <div class="fig-head static">
          <span class="fig-title">Recent changes</span>
          <router-link class="muted small" to="/governance">Full audit timeline →</router-link>
        </div>
        <p class="fig-why muted small">The latest governance actions Argus has recorded — append-only, tamper-evident.</p>
        <ul class="changelog">
          <li v-for="e in o.changelog" :key="e.id">
            <span class="c-when muted small" :title="e.ts">{{ relativeTime(e.ts, now) }}</span>
            <span class="mono small">{{ e.action }}</span>
            <span class="muted small">{{ e.actorName }}</span>
            <span class="c-entity muted small mono">{{ e.entityId ?? e.entityType }}</span>
          </li>
          <li v-if="o.changelog.length === 0" class="muted small">No governance actions recorded yet.</li>
        </ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.ov { display: flex; flex-direction: column; gap: var(--spacing--md); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--md); flex-wrap: wrap; }
h1 { margin: 0; font-size: var(--font-size--xl); font-weight: var(--font-weight--bold); }
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--sm); max-width: 46rem; }
.actions { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; }
.actions a { text-decoration: none; }
.small { font-size: var(--font-size--2xs); }

.warnbar {
  padding: var(--spacing--2xs) var(--spacing--sm);
  border: 1px solid var(--border-color--danger, var(--color--danger)); border-radius: var(--radius--md);
  background: var(--background--danger, var(--background--subtle));
  color: var(--text-color--danger, var(--color--danger)); font-size: var(--font-size--2xs);
}

/* Score hero */
.score { display: flex; flex-direction: column; gap: var(--spacing--md); }
.score-hero { display: flex; align-items: center; gap: var(--spacing--md); flex-wrap: wrap; }
.score-num { font-size: 3.5rem; font-weight: var(--font-weight--bold); line-height: 1; font-variant-numeric: tabular-nums; }
.score-max { font-size: var(--font-size--md); font-weight: var(--font-weight--medium); opacity: 0.5; }
.score-cap strong { font-size: var(--font-size--md); }
.score-cap p { margin: var(--spacing--5xs) 0 0; max-width: 34rem; }

.pillars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--sm); }
.pillar { display: flex; flex-direction: column; gap: var(--spacing--5xs); }
.pillar-top { display: flex; align-items: baseline; gap: var(--spacing--2xs); }
.pillar-label { font-weight: var(--font-weight--medium); font-size: var(--font-size--sm); }
.pillar-weight { margin-left: auto; }
.pillar-score { font-variant-numeric: tabular-nums; font-weight: var(--font-weight--bold); font-size: var(--font-size--sm); min-width: 3rem; text-align: right; }
.pillar-why { margin: 0; }
.bar { height: 0.4rem; border-radius: var(--radius--full); background: var(--background--subtle); overflow: hidden; }
.bar-fill { height: 100%; border-radius: var(--radius--full); transition: width var(--duration--slow, 0.3s) var(--easing--ease-out, ease); }

/* Semantic tones — tokens only, so both themes come for free. */
.t-ok { color: var(--text-color--success, var(--color--success)); }
.t-warn { color: var(--text-color--warning, var(--color--warning)); }
.t-danger { color: var(--text-color--danger, var(--color--danger)); }
.t-muted { color: var(--color--text--shade-1); opacity: 0.6; }
.b-ok { background: var(--color--success); }
.b-warn { background: var(--color--warning); }
.b-danger { background: var(--color--danger); }
.b-muted { background: var(--border-color--strong, var(--border-color)); }

/* Figure grid */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: var(--spacing--md); }
.fig { display: flex; flex-direction: column; gap: var(--spacing--2xs); }
.fig-head {
  appearance: none; background: none; border: 0; font: inherit; color: inherit; cursor: pointer;
  display: flex; align-items: center; gap: var(--spacing--sm); width: 100%; text-align: left; padding: 0;
}
.fig-head.static { cursor: default; }
.fig-title { font-size: var(--font-size--md); font-weight: var(--font-weight--bold); }
.fig-count { margin-left: auto; font-size: var(--font-size--lg); font-weight: var(--font-weight--bold); font-variant-numeric: tabular-nums; opacity: 0.7; }
.fig-count.is-bad { color: var(--text-color--danger, var(--color--danger)); opacity: 1; }
.fig-why { margin: 0; }
.fig-why a, .fig-head a { color: var(--background--brand); text-decoration: none; }
.chips { display: flex; gap: var(--spacing--4xs); flex-wrap: wrap; }

.subfigs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--4xs); }
.subfig {
  appearance: none; background: none; border: 0; font: inherit; color: inherit; cursor: pointer;
  display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm); width: 100%; text-align: left;
  padding: var(--spacing--4xs) 0; font-size: var(--font-size--sm);
}
.subfig .fig-count { font-size: var(--font-size--sm); }

.drill { list-style: none; margin: var(--spacing--3xs) 0 0; padding: var(--spacing--2xs) 0 0; border-top: 1px solid var(--border-color--subtle); display: flex; flex-direction: column; gap: var(--spacing--4xs); }
.drill > li { display: flex; align-items: center; gap: var(--spacing--2xs); flex-wrap: wrap; font-size: var(--font-size--2xs); }
.wf { font-weight: var(--font-weight--medium); font-size: var(--font-size--sm); }
.inst { display: inline-flex; align-items: center; gap: var(--spacing--4xs); white-space: nowrap; }
.dot { width: 0.5rem; height: 0.5rem; border-radius: var(--radius--full); flex: none; }
.advisory, .rate { font-size: var(--font-size--3xs); padding: 0 var(--spacing--4xs); border-radius: var(--radius--2xs); background: var(--background--subtle); color: var(--color--text--shade-1); opacity: 0.8; }
.rate { color: var(--text-color--danger, var(--color--danger)); opacity: 1; }

.spof { flex-direction: column; align-items: stretch; gap: var(--spacing--4xs); width: 100%; }
.spof-head { display: flex; align-items: center; gap: var(--spacing--2xs); flex-wrap: wrap; }
.spof-wfs { list-style: none; margin: 0; padding: 0 0 0 var(--spacing--sm); display: flex; flex-direction: column; gap: var(--spacing--5xs); }
.spof-wfs li { display: flex; gap: var(--spacing--sm); align-items: center; flex-wrap: wrap; }

.changelog { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--4xs); }
.changelog li { display: flex; gap: var(--spacing--sm); align-items: baseline; flex-wrap: wrap; }
.c-when { white-space: nowrap; }
.c-entity { margin-left: auto; }

.pad { padding: var(--spacing--md); }
.err { color: var(--text-color--danger, var(--color--danger)); }

@media (max-width: 640px) {
  .grid { grid-template-columns: 1fr; }
  .score-num { font-size: 2.75rem; }
  .c-entity { margin-left: 0; }
}
</style>
