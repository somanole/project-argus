<script setup lang="ts">
// The Governance overview (S6) — the one screen that says "here's the state of our
// estate". A glanceable dashboard, not a place that reproduces detail: the score panel
// composes every pillar, then a uniform grid of metric tiles each NAVIGATE to the exact
// workflow set on the page that owns it (Ownership / Health / Estate / Graph). Longer
// prose lives in ⓘ tooltips, not on the surface. Honest to the estate's uncertainty
// (rule 5): inferred owners are advisory, unavailable health is shown as unavailable,
// possible edges are excluded — the caveats move into tooltips, never removed.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useOverviewStore } from '../stores/overview';
import type { ScorePillar } from '@argus/shared';
import InfoTip from '../components/InfoTip.vue';
import OverviewTile, { type OverviewTileData } from '../components/OverviewTile.vue';
import { relativeTime } from '../lib/time';

const store = useOverviewStore();
const { data, state, error, lastUpdated } = storeToRefs(store);

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

const o = computed(() => data.value);
const score = computed(() => o.value?.score ?? null);
const unavailableInstances = computed(() => o.value?.health.windows.filter((w) => !w.available) ?? []);
const advisoryCovered = computed(() => o.value?.unowned.workflows.filter((w) => w.inferred?.status === 'inferred').length ?? 0);

type Tone = 'ok' | 'warn' | 'danger' | 'muted';
/** Score → semantic tone (tokens only, so both themes come for free). Also drives the tile tone. */
function scoreTone(n: number | null): Tone {
  if (n == null) return 'muted';
  if (n >= 80) return 'ok';
  if (n >= 50) return 'warn';
  return 'danger';
}
const scoreBand = (n: number | null): string => (n == null ? '—' : n >= 80 ? 'Good' : n >= 50 ? 'Fair' : 'Poor');
const pct = (n: number | null): string => (n == null ? '0%' : `${n}%`);
const weightPct = (p: ScorePillar): string => `${Math.round(p.weight * 100)}%`;

/**
 * The headline VALUE behind a pillar's score, surfaced inline so it's readable without
 * opening the ⓘ (which keeps the full sentence). Built from the pillar's structured
 * `inputs` (the explainability contract), never by parsing the prose. '' when unscored.
 */
function pillarValue(p: ScorePillar): string {
  if (!p.scored) return '';
  const n = (k: string): number => p.inputs[k] ?? 0;
  switch (p.key) {
    case 'ownership':
      return n('unowned') === 0 ? 'all workflows owned' : `${n('unowned')} of ${n('total')} unowned`;
    case 'reliability':
      return n('failing') + n('degraded') === 0
        ? `${n('healthy')} of ${n('evaluated')} healthy`
        : `${n('failing')} failing · ${n('degraded')} degraded of ${n('evaluated')}`;
    case 'resilience':
      return n('atRisk') === 0 ? `${n('criticalTotal')} criticals resilient` : `${n('atRisk')} of ${n('criticalTotal')} criticals at risk`;
    case 'hygiene':
      return n('issueWorkflows') === 0 ? `${n('total')} clean` : `${n('issueWorkflows')} of ${n('total')} with issues`;
    case 'exposure':
      return n('mcpExposed') === 0 ? 'no MCP exposure' : `${n('reachingSensitive')} of ${n('mcpExposed')} reach sensitive`;
    default:
      return '';
  }
}

/** Top two non-zero criticality buckets of the unowned set, e.g. "2 critical · 62 high". */
const unownedContext = computed<string>(() => {
  const u = o.value?.unowned;
  if (!u || u.total === 0) return 'every workflow has an owner';
  const b = u.byCriticality;
  const parts = ([['critical', b.critical], ['high', b.high], ['medium', b.medium], ['low', b.low], ['unlabeled', b.none]] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`);
  return parts.slice(0, 2).join(' · ');
});

const accountabilityTiles = computed<OverviewTileData[]>(() => {
  const v = o.value;
  if (!v) return [];
  return [
    {
      key: 'unowned', testid: 'overview-unowned', label: 'No assigned owner', count: v.unowned.total, tone: 'danger',
      context: unownedContext.value,
      info: `Workflows with no confirmed owner — the accountability gap that drives the ownership score.${advisoryCovered.value > 0 ? ` Argus can suggest an owner for ${advisoryCovered.value} of them from n8n membership, but inference is advisory — assign a person to actually close the gap.` : ''}`,
      to: { path: '/estate/ownership', query: { view: 'needs-owner' } }, dest: 'Ownership',
    },
    {
      key: 'spof', testid: 'overview-spof', label: 'Single-owner criticals', count: v.spofOwners.length, tone: 'danger',
      context: 'sole owner of ≥2 criticals',
      info: 'One person is the sole owner of several critical workflows — a single point of failure.',
      to: { path: '/estate/ownership', query: { view: 'spof' } }, dest: 'Ownership',
    },
    {
      key: 'personal-space', testid: 'overview-personal-space', label: 'Critical in personal space', count: v.personalSpaceCritical.length, tone: 'danger',
      context: 'not in a team project',
      info: 'Business-critical workflows living in someone’s personal project rather than a shared team project.',
      to: { path: '/estate/ownership', query: { view: 'personal-space' } }, dest: 'Ownership',
    },
  ];
});

const operationsTiles = computed<OverviewTileData[]>(() => {
  const v = o.value;
  if (!v) return [];
  return [
    {
      key: 'failing', testid: 'overview-failing', label: 'Failing', count: v.health.summary.failing, tone: 'danger',
      context: 'failure rate over 50%',
      info: 'Workflows whose runs are mostly failing (failure rate over 50%) in the health window. Opens the Health view.',
      to: '/estate/health', dest: 'Health',
    },
    {
      key: 'silently-failing', testid: 'overview-silently-failing', label: 'Silently failing', count: v.silentlyFailing.count, tone: 'warn',
      context: 'green runs, a node errored',
      info: 'Workflows n8n marked success while a node actually errored-and-continued — caught from the un-redacted run (node + error class only). Observed among the workflows inspected, not a full-fleet guarantee.',
      to: { path: '/estate/health', query: { view: 'silentlyFailing' } }, dest: 'Health',
    },
    {
      key: 'broken', testid: 'overview-broken', label: 'Broken references', count: v.hygiene.brokenRefs.count, tone: 'danger',
      context: 'unresolved node refs',
      info: 'Workflows referencing a node or credential that no longer resolves.',
      to: { path: '/estate', query: { broken: 'true' } }, dest: 'Estate',
    },
    {
      key: 'stale', testid: 'overview-stale', label: 'Stale analysis', count: v.hygiene.staleEnrichment.count, tone: 'warn',
      context: 'analysis has drifted',
      info: 'Workflows whose stored analysis no longer matches their current definition — the enrichment needs a re-run.',
      to: { path: '/estate', query: { stale: 'true' } }, dest: 'Estate',
    },
    {
      key: 'idle-active', testid: 'overview-idle-active', label: 'Idle but active', count: v.hygiene.activeNoExecutions.count, tone: 'warn',
      context: 'active, no recent runs',
      info: 'Workflows marked active that have not executed in the health window — candidates to archive or investigate.',
      to: { path: '/estate', query: { health: 'idle', active: 'true' } }, dest: 'Estate',
    },
    {
      key: 'exposure', testid: 'overview-exposure', label: 'MCP reaching sensitive', count: v.exposure.reachingSensitive, tone: 'warn',
      context: `of ${v.exposure.mcpExposed} exposed · ${v.exposure.reachingSensitiveUnowned} unowned`,
      info: 'MCP-exposed workflows whose confirmed dependency path reaches a sensitive system. Confirmed reach only — inferred edges are excluded.',
      to: { path: '/estate', query: { mcp: 'true' } }, dest: 'Estate',
    },
  ];
});

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
        <p class="muted sub">
          Estate-wide accountability, health and exposure
          <span v-if="lastUpdated"> · as of {{ relativeTime(lastUpdated, now) }}</span>
        </p>
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

      <!-- ── Governance score ────────────────────────────────────────────── -->
      <div class="card score" data-testid="overview-score">
        <div class="score-hero">
          <div class="score-figure">
            <div class="score-num" :class="`t-${scoreTone(score?.score ?? null)}`">
              {{ score?.score ?? '—' }}<span class="score-max">/100</span>
            </div>
            <div class="score-cap">
              <span class="score-band" :class="`band-${scoreTone(score?.score ?? null)}`">{{ scoreBand(score?.score ?? null) }}</span>
              <span class="score-label">Governance score</span>
              <InfoTip text="A deterministic, explainable weighted average of five pillars. Each pillar shows what drove it; hover its ⓘ for why." />
            </div>
          </div>
        </div>
        <ul class="pillars" data-testid="overview-score-breakdown">
          <li v-for="p in score?.pillars ?? []" :key="p.key" class="pillar">
            <div class="pillar-top">
              <span class="pillar-label">{{ p.label }}</span>
              <InfoTip :text="p.reason" :label="`Why ${p.label} scored this`" />
              <span class="pillar-weight muted small">{{ weightPct(p) }}</span>
              <span class="pillar-score" :class="`t-${scoreTone(p.scored ? p.score : null)}`">
                {{ p.scored ? p.score : 'couldn’t score' }}
              </span>
            </div>
            <div class="bar"><div class="bar-fill" :class="`b-${scoreTone(p.scored ? p.score : null)}`" :style="{ width: p.scored ? pct(p.score) : '0%' }" /></div>
            <p v-if="pillarValue(p)" class="pillar-value muted small" data-testid="pillar-value">{{ pillarValue(p) }}</p>
          </li>
        </ul>
      </div>

      <!-- ── Metric tiles: every number leads to its exact set (one shared tile) ── -->
      <div class="group">
        <p class="group-h">Accountability</p>
        <div class="tiles">
          <OverviewTile v-for="t in accountabilityTiles" :key="t.key" :tile="t" />
        </div>
      </div>

      <div class="group">
        <p class="group-h">Operations and exposure</p>
        <div class="tiles">
          <OverviewTile v-for="t in operationsTiles" :key="t.key" :tile="t" />
        </div>
      </div>

      <!-- ── Recent activity (a pulse; the full log lives in Activity) ────── -->
      <section class="card changelog-card" data-testid="overview-changelog">
        <div class="cl-head">
          <span class="cl-title">Recent activity</span>
          <router-link class="cl-link small" to="/activity">View all →</router-link>
        </div>
        <ul class="changelog">
          <li v-for="e in o.changelog.slice(0, 6)" :key="e.id">
            <span class="c-when muted small" :title="e.ts">{{ relativeTime(e.ts, now) }}</span>
            <span class="mono small">{{ e.action }}</span>
            <span class="muted small">{{ e.actorName }}</span>
            <span class="c-entity muted small mono" :title="e.entityId ?? e.entityType">{{ e.entityId ?? e.entityType }}</span>
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
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--sm); }
.actions { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; }
.actions a { text-decoration: none; }
.small { font-size: var(--font-size--2xs); }

.warnbar {
  padding: var(--spacing--2xs) var(--spacing--sm);
  border: 1px solid var(--border-color--danger, var(--color--danger)); border-radius: var(--radius--md);
  background: var(--background--danger, var(--background--subtle));
  color: var(--color--danger); font-size: var(--font-size--2xs);
}

/* ── Score panel ── */
.score { display: flex; flex-direction: column; gap: var(--spacing--md); }
.score-hero { display: flex; align-items: center; gap: var(--spacing--md); flex-wrap: wrap; }
.score-figure { display: flex; align-items: center; gap: var(--spacing--sm); flex-wrap: wrap; }
.score-num { font-size: 3.25rem; font-weight: var(--font-weight--bold); line-height: 1; font-variant-numeric: tabular-nums; }
.score-max { font-size: var(--font-size--md); font-weight: var(--font-weight--medium); opacity: 0.5; }
.score-cap { display: flex; align-items: center; gap: var(--spacing--2xs); flex-wrap: wrap; }
.score-band { font-size: var(--font-size--2xs); font-weight: var(--font-weight--bold); padding: var(--spacing--5xs) var(--spacing--2xs); border-radius: var(--radius--md); }
.band-ok { color: var(--color--success); background: var(--background--success, var(--background--subtle)); }
.band-warn { color: var(--color--warning); background: var(--background--warning, var(--background--subtle)); }
.band-danger { color: var(--color--danger); background: var(--background--danger, var(--background--subtle)); }
.band-muted { color: var(--color--text--shade-1); background: var(--background--subtle); }
.score-label { font-size: var(--font-size--sm); font-weight: var(--font-weight--medium); }

.pillars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--sm); }
.pillar { display: flex; flex-direction: column; gap: var(--spacing--5xs); }
.pillar-top { display: flex; align-items: center; gap: var(--spacing--2xs); }
.pillar-label { font-weight: var(--font-weight--medium); font-size: var(--font-size--sm); }
.pillar-weight { margin-left: auto; }
.pillar-score { font-variant-numeric: tabular-nums; font-weight: var(--font-weight--bold); font-size: var(--font-size--sm); min-width: 3rem; text-align: right; }
.bar { height: 0.5rem; border-radius: var(--radius--full); background: var(--border-color); overflow: hidden; }
.bar-fill { height: 100%; border-radius: var(--radius--full); transition: width var(--duration--slow, 0.3s) var(--easing--ease-out, ease); }
.pillar-value { margin: var(--spacing--5xs) 0 0; font-variant-numeric: tabular-nums; }

/* Semantic tones — tokens only. */
.t-ok { color: var(--color--success); }
.t-warn { color: var(--color--warning); }
.t-danger { color: var(--color--danger); }
.t-muted { color: var(--color--text--shade-1); opacity: 0.55; }
.b-ok { background: var(--color--success); }
.b-warn { background: var(--color--warning); }
.b-danger { background: var(--color--danger); }
.b-muted { background: var(--border-color--strong, var(--border-color)); }

/* ── Metric tile grid ── */
.group { display: flex; flex-direction: column; gap: var(--spacing--2xs); }
.group-h {
  margin: 0 0 0 var(--spacing--5xs); font-size: var(--font-size--3xs); font-weight: var(--font-weight--bold);
  text-transform: uppercase; letter-spacing: var(--letter-spacing--wide);
  color: var(--color--text--shade-1); opacity: 0.5;
}
/* Tiles are a shared component (OverviewTile.vue); this just lays out the grid. */
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); gap: var(--spacing--sm); }

/* ── Recent activity ── */
.changelog-card { display: flex; flex-direction: column; gap: var(--spacing--2xs); }
.cl-head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm); }
.cl-title { font-size: var(--font-size--md); font-weight: var(--font-weight--bold); }
.cl-link { color: var(--background--brand); text-decoration: none; }
.changelog { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--4xs); }
.changelog li { display: flex; gap: var(--spacing--sm); align-items: baseline; flex-wrap: wrap; }
.c-when { white-space: nowrap; min-width: 4.5rem; }
.c-entity { max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pad { padding: var(--spacing--md); }
.err { color: var(--color--danger); }

@media (max-width: 640px) {
  .tiles { grid-template-columns: 1fr; }
  .score-num { font-size: 2.75rem; }
}
</style>
