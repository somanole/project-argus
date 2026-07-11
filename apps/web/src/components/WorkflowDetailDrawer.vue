<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { workflowDetailSchema, workflowExecutionsResponseSchema, type WorkflowDetail, type WorkflowExecutionsResponse, type WorkflowListItem, type DirectDep, type RefKind, type Criticality } from '@argus/shared';
import { api } from '../lib/api';
import { instanceColor } from '../lib/instanceColor';
import { relativeTime } from '../lib/time';
import StateBadge from './StateBadge.vue';
import FactBadge from './FactBadge.vue';
import WorkflowHealthBadge from './WorkflowHealthBadge.vue';
import OwnerBadge from './OwnerBadge.vue';
import EnrichmentSection from './EnrichmentSection.vue';
import OwnershipSection from './OwnershipSection.vue';

// The detail drawer: fetches the selected workflow's full facts + direct deps +
// n8n deep-link. Everything is deterministic ground truth; unknowns say so.
const props = defineProps<{ selected: WorkflowListItem | null }>();
const emit = defineEmits<{ close: [] }>();

const detail = ref<WorkflowDetail | null>(null);
const state = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
const error = ref<string | null>(null);

// S3: on-demand execution debug (recent runs + redacted failure). Fetched live from
// n8n only while the drawer is open — never persisted, never on the health poll.
const runs = ref<WorkflowExecutionsResponse | null>(null);
const runsState = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');

watch(
  () => props.selected,
  async (sel) => {
    detail.value = null;
    runs.value = null;
    if (!sel) {
      state.value = 'idle';
      runsState.value = 'idle';
      return;
    }
    state.value = 'loading';
    runsState.value = 'loading';
    const encPath = `${encodeURIComponent(sel.instanceId)}/${encodeURIComponent(sel.id)}`;
    try {
      detail.value = await api(`/api/workflows/${encPath}`, {}, workflowDetailSchema);
      state.value = 'ok';
      error.value = null;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not load workflow facts';
    }
    // Runs load independently — a failure here never blocks the facts view (rule 5).
    try {
      runs.value = await api(`/api/workflows/${encPath}/executions`, {}, workflowExecutionsResponseSchema);
      runsState.value = 'ok';
    } catch {
      runsState.value = 'error';
    }
  },
  { immediate: true },
);

const RUN_TONE: Record<string, 'ok' | 'danger' | 'warn' | 'muted'> = {
  success: 'ok', error: 'danger', crashed: 'danger', canceled: 'muted', waiting: 'warn', running: 'warn', new: 'muted',
};

const KIND_LABEL: Record<RefKind, string> = {
  subWorkflow: 'Sub-workflow',
  toolWorkflow: 'Tool workflow',
  agentTool: 'Agent tool',
  errorWorkflow: 'Error workflow',
};

function depView(d: DirectDep): { tone: 'ok' | 'danger' | 'muted'; text: string } {
  switch (d.resolution) {
    case 'resolved':
      return { tone: 'ok', text: d.resolvedName ?? '(resolved)' };
    case 'broken':
      return { tone: 'danger', text: `missing — id ${d.rawValue ?? '?'}` };
    case 'dynamic':
      return { tone: 'muted', text: 'dynamic — set at run time' };
    case 'unresolved':
      return { tone: 'muted', text: `couldn’t resolve${d.cachedName ? ` — “${d.cachedName}”` : ''}` };
  }
}

/** Human duration for the health panel; null → honest "—", never fabricated. */
function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${Math.round(s / 60)} min`;
}

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') emit('close');
};

// ── At-a-glance strip ─────────────────────────────────────────────────────────
// The four governance questions in one scan. Every value is honest (rule 5): an
// un-enriched workflow reads "not analyzed", never a fabricated criticality/risk.
const CRIT_TONE: Record<Criticality, 'danger' | 'warn' | 'muted'> = { critical: 'danger', high: 'warn', medium: 'muted', low: 'muted' };
const criticality = computed(() => detail.value?.workflow.enrichment?.criticality ?? null);
const riskGlance = computed(() => {
  const e = detail.value?.workflow.enrichment;
  if (!e || e.status === 'stub') return { known: false, text: 'not analyzed' };
  const n = e.riskFlags.length;
  return { known: true, text: n === 0 ? 'none' : `${n} flag${n > 1 ? 's' : ''}` };
});
</script>

<template>
  <div v-if="selected" class="scrim" tabindex="-1" @click.self="emit('close')" @keydown="onKeydown">
    <aside class="drawer" role="dialog" aria-label="Workflow details">
      <header class="d-head">
        <div class="d-title">
          <h2>{{ selected.name }}</h2>
          <p class="sub">
            <span class="instance"><span class="dot" :style="{ background: instanceColor(selected.instanceId) }" />{{ selected.instanceLabel }}</span>
            <span v-if="selected.project" class="muted"> · {{ selected.project }}</span>
          </p>
          <div v-if="state === 'ok' && detail" class="d-status">
            <StateBadge :active="selected.active" :is-archived="selected.isArchived" />
            <FactBadge v-if="selected.mcpExposed" label="MCP-exposed" tone="mcp" />
            <FactBadge v-if="detail.facts && !detail.facts.coverage.understood" label="partly unparsed" tone="warn" />
            <FactBadge v-if="selected.brokenRefCount > 0" :label="`${selected.brokenRefCount} broken ref${selected.brokenRefCount > 1 ? 's' : ''}`" tone="danger" />
          </div>
        </div>
        <div class="d-head-actions">
          <a v-if="detail?.deepLink" class="btn btn--secondary btn--sm open" :href="detail.deepLink" target="_blank" rel="noopener">Open in n8n ↗</a>
          <button class="btn btn--ghost btn--sm close" aria-label="Close" @click="emit('close')">✕</button>
        </div>
      </header>

      <p v-if="state === 'loading'" class="muted pad">Analysing…</p>
      <p v-else-if="state === 'error'" class="err pad">Couldn’t load facts — {{ error }}.</p>

      <div v-else-if="state === 'ok' && detail" class="d-body">
        <!-- At-a-glance: the four governance questions, scannable, honest when unknown. -->
        <div class="glance" data-testid="drawer-glance">
          <div class="tile">
            <span class="tile-k">Criticality</span>
            <FactBadge v-if="criticality" :label="criticality" :tone="CRIT_TONE[criticality]" />
            <span v-else class="tile-v muted">not analyzed</span>
          </div>
          <div class="tile">
            <span class="tile-k">Health</span>
            <WorkflowHealthBadge v-if="detail.workflow.health" :health="detail.workflow.health" />
            <span v-else class="tile-v muted">—</span>
          </div>
          <div class="tile">
            <span class="tile-k">Owner</span>
            <OwnerBadge :owner="detail.workflow.owner" />
          </div>
          <div class="tile">
            <span class="tile-k">Risk</span>
            <span class="tile-v" :class="{ muted: !riskGlance.known }">{{ riskGlance.text }}</span>
          </div>
        </div>

        <div class="d-cols">
          <div class="col col--main">
            <!-- S2 sense-making: summary + criticality-with-reason + risk flags + correction. -->
            <EnrichmentSection
              :enrichment="detail.workflow.enrichment"
              :instance-id="selected.instanceId"
              :workflow-id="selected.id"
              @updated="detail = $event"
            />

            <template v-if="detail.facts">
              <!-- Facts -->
              <section class="d-sec">
                <h3>Facts</h3>
                <dl class="facts">
                  <dt>Nodes</dt>
                  <dd>{{ detail.facts.nodeCount }}</dd>
                  <dt>Triggers</dt>
                  <dd>
                    <span v-if="detail.facts.triggers.length === 0" class="muted">—</span>
                    <span v-else class="badges">
                      <FactBadge v-for="t in detail.facts.triggers" :key="t.type" :label="t.display ?? t.type" tone="trigger" :title="t.type" />
                    </span>
                  </dd>
                  <dt>Systems</dt>
                  <dd>
                    <span v-if="detail.facts.systems.filter((s) => s.system).length === 0" class="muted">—</span>
                    <span v-else class="badges">
                      <FactBadge v-for="s in detail.facts.systems.filter((s) => s.system)" :key="s.raw" :label="s.system!" tone="system" :title="`via ${s.via}: ${s.raw}`" />
                    </span>
                  </dd>
                  <dt>Credentials</dt>
                  <dd>
                    <span v-if="detail.facts.credentialTypes.length === 0" class="muted">—</span>
                    <span v-else class="badges">
                      <FactBadge v-for="c in detail.facts.credentialTypes" :key="c" :label="c" tone="muted" />
                    </span>
                  </dd>
                  <dt v-if="detail.facts.dataTableRefs.length">Data tables</dt>
                  <dd v-if="detail.facts.dataTableRefs.length">
                    <span class="badges">
                      <FactBadge v-for="(t, i) in detail.facts.dataTableRefs" :key="i" :label="t.cachedName ?? t.rawValue ?? '(dynamic)'" tone="muted" />
                    </span>
                  </dd>
                </dl>
              </section>

              <!-- Direct dependencies (outbound) -->
              <section class="d-sec">
                <h3>Directly connects to</h3>
                <p v-if="detail.facts.directDeps.length === 0" class="muted">Nothing — this workflow references no other workflow.</p>
                <ul v-else class="deps">
                  <li v-for="(d, i) in detail.facts.directDeps" :key="i" class="dep">
                    <span class="dep-kind muted">{{ KIND_LABEL[d.kind] }}</span>
                    <span v-if="d.nodeName" class="dep-node mono">{{ d.nodeName }}</span>
                    <FactBadge :label="depView(d).text" :tone="depView(d).tone" />
                  </li>
                </ul>
              </section>

              <!-- Honest gaps -->
              <section v-if="!detail.facts.coverage.understood" class="d-sec">
                <h3>Couldn’t fully analyse</h3>
                <ul class="gaps muted">
                  <li v-for="t in detail.facts.coverage.unknownNodeTypes" :key="t">Unknown node type: <span class="mono">{{ t }}</span></li>
                  <li v-for="(d, i) in detail.facts.directDeps.filter((x) => x.resolution === 'unresolved')" :key="'u' + i">
                    Unresolved reference{{ d.cachedName ? ` (“${d.cachedName}”)` : '' }}
                  </li>
                </ul>
              </section>
            </template>
            <p v-else class="muted">This workflow couldn’t be analysed (no node data).</p>
          </div>

          <div class="col col--side">
            <!-- S4 ownership: who is accountable + the audited assign/reassign/remove controls,
                 with the advisory suggested-owner hint shown right where you assign. -->
            <OwnershipSection
              :instance-id="selected.instanceId"
              :workflow-id="selected.id"
              :owner="detail.workflow.owner"
              :suggested-owner-rationale="detail.workflow.enrichment?.suggestedOwnerRationale ?? null"
              @updated="detail.workflow.owner = $event"
            />

            <!-- S3 health: poll-fresh execution status + the numbers behind it. -->
            <section v-if="detail.workflow.health" class="d-sec" data-testid="health-section">
              <h3>Health</h3>
              <div class="health-head">
                <WorkflowHealthBadge :health="detail.workflow.health" />
                <span class="muted checked">
                  <template v-if="detail.workflow.health.computedAt">checked {{ relativeTime(detail.workflow.health.computedAt, Date.now()) }}</template>
                </span>
              </div>
              <dl class="facts">
                <dt>Failure rate</dt>
                <dd>
                  <template v-if="detail.workflow.health.failureRate != null">
                    {{ Math.round(detail.workflow.health.failureRate * 100) }}%
                    <span class="muted">({{ detail.workflow.health.failuresInWindow }}/{{ detail.workflow.health.runsInWindow }} runs)</span>
                  </template>
                  <span v-else class="muted">—</span>
                </dd>
                <dt>Last run</dt>
                <dd>
                  <template v-if="detail.workflow.health.lastRunAt">
                    {{ relativeTime(detail.workflow.health.lastRunAt, Date.now()) }}
                    <span v-if="detail.workflow.health.lastStatus" class="muted">· {{ detail.workflow.health.lastStatus }}</span>
                  </template>
                  <span v-else class="muted">no runs in the last ~{{ Math.round(detail.workflow.health.windowHours / 24) }} days</span>
                </dd>
                <dt>Avg duration</dt>
                <dd>{{ fmtDuration(detail.workflow.health.avgDurationMs) }}</dd>
                <dt>Window</dt>
                <dd class="muted">~{{ Math.round(detail.workflow.health.windowHours / 24) }} days (n8n default retention)</dd>
              </dl>

              <!-- On-demand execution debug: redacted failure summary + recent runs. Full
               logs/data stay in n8n (redacted server-side); we show the failing node +
               error class and deep-link to the exact run. -->
              <p v-if="runsState === 'loading'" class="muted small">Loading recent runs…</p>
              <template v-else-if="runs && !runs.unavailable">
                <div v-if="runs.failure" class="failbox" data-testid="execution-failure">
                  <span class="fail-title">Failing at <span class="mono">{{ runs.failure.failedNode ?? 'an unknown node' }}</span></span>
                  <span v-if="runs.failure.errorType || runs.failure.errorCode" class="fail-err mono">
                    {{ [runs.failure.errorType, runs.failure.errorCode].filter(Boolean).join(' · ') }}
                  </span>
                  <span v-else class="fail-err muted small">no error class exposed (redacted) — open the run in n8n</span>
                  <a class="run-link" :href="runs.failure.deepLink" target="_blank" rel="noopener">Open the failed run in n8n ↗</a>
                </div>
                <p class="runs-label muted">Recent runs</p>
                <ul v-if="runs.runs.length" class="runlist" data-testid="execution-runs">
                  <li v-for="r in runs.runs" :key="r.executionId" class="run">
                    <FactBadge :label="r.status" :tone="RUN_TONE[r.status] ?? 'muted'" />
                    <span class="run-time muted">{{ relativeTime(r.startedAt, Date.now()) }}</span>
                    <span class="run-dur muted">{{ fmtDuration(r.durationMs) }}</span>
                    <span v-if="r.mode" class="run-mode muted">{{ r.mode }}</span>
                    <a class="run-link" :href="r.deepLink" target="_blank" rel="noopener">open ↗</a>
                  </li>
                </ul>
                <p v-else class="muted small">No runs in the last ~14 days.</p>
                <p class="runs-note muted small">Full logs &amp; data stay in n8n — open a run to inspect.</p>
              </template>
              <p v-else-if="runs && runs.unavailable" class="muted small">{{ runs.unavailableReason ?? 'executions unavailable' }}</p>
            </section>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--color--text--shade-1) 32%, transparent);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}
.drawer {
  width: min(45rem, 94vw);
  height: 100%;
  overflow-y: auto;
  background: var(--background--surface);
  border-left: 1px solid var(--border-color);
  padding: 0;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow--lg, none);
}
/* Sticky header keeps identity + the "Open in n8n" action in view while the body scrolls. */
.d-head {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--sm);
  padding: var(--spacing--md) var(--spacing--lg);
  background: var(--background--surface);
  border-bottom: 1px solid var(--border-color--subtle);
}
.d-title { min-width: 0; }
.d-title h2 { margin: 0; font-size: var(--font-size--lg); font-weight: var(--font-weight--bold); }
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--2xs); display: flex; gap: var(--spacing--4xs); align-items: center; }
.instance { display: inline-flex; align-items: center; gap: var(--spacing--4xs); }
.d-head-actions { display: flex; align-items: center; gap: var(--spacing--2xs); flex: none; }
.close { font-size: var(--font-size--md); line-height: 1; }
.d-body { display: flex; flex-direction: column; gap: var(--spacing--md); padding: var(--spacing--md) var(--spacing--lg) var(--spacing--lg); }
.d-status { display: flex; flex-wrap: wrap; gap: var(--spacing--4xs); margin-top: var(--spacing--2xs); }

/* At-a-glance strip — four honest metric tiles. */
.glance { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--spacing--2xs); }
.tile {
  display: flex; flex-direction: column; gap: var(--spacing--5xs); align-items: flex-start;
  min-width: 0; overflow: hidden;
  padding: var(--spacing--2xs) var(--spacing--sm);
  background: var(--background--subtle);
  border: 1px solid var(--border-color--subtle);
  border-radius: var(--radius--md);
}
.tile-k { font-size: var(--font-size--3xs); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide); color: var(--color--text--shade-1); opacity: 0.6; }
.tile-v { font-size: var(--font-size--sm); font-weight: var(--font-weight--medium); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile :deep(.badge) { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.tile :deep(.fbadge) { max-width: 100%; }

/* Two-column body: left = what & why, right = who & how it's doing. */
.d-cols { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: var(--spacing--lg); align-items: start; }
.col { display: flex; flex-direction: column; gap: var(--spacing--md); min-width: 0; }
.d-sec h3 {
  margin: 0 0 var(--spacing--2xs);
  font-size: var(--font-size--3xs);
  text-transform: uppercase;
  letter-spacing: var(--letter-spacing--wide);
  font-weight: var(--font-weight--bold);
  color: var(--color--text--shade-1);
  opacity: 0.6;
}
.health-head { display: flex; align-items: center; gap: var(--spacing--sm); flex-wrap: wrap; margin-bottom: var(--spacing--2xs); }
.checked { font-size: var(--font-size--2xs); }
.small { font-size: var(--font-size--2xs); }
.failbox {
  display: flex; flex-direction: column; gap: var(--spacing--5xs);
  margin: var(--spacing--2xs) 0;
  padding: var(--spacing--2xs) var(--spacing--sm);
  border: 1px solid var(--border-color--danger, var(--border-color));
  border-radius: var(--radius--md);
  background: var(--background--danger, var(--background--subtle));
}
.fail-title { font-size: var(--font-size--sm); font-weight: var(--font-weight--medium); color: var(--color--danger); }
.fail-err { font-size: var(--font-size--2xs); color: var(--color--danger); }
.runs-label { margin: var(--spacing--2xs) 0 var(--spacing--4xs); font-size: var(--font-size--3xs); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide); }
.runlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--4xs); }
.run { display: flex; align-items: center; gap: var(--spacing--2xs); flex-wrap: wrap; font-size: var(--font-size--2xs); }
.run-time { min-width: 5rem; }
.run-link { color: var(--color--primary, var(--background--brand)); text-decoration: none; white-space: nowrap; }
.run-link:hover { text-decoration: underline; }
.runs-note { margin-top: var(--spacing--4xs); font-style: italic; opacity: 0.8; }
.facts { display: grid; grid-template-columns: auto 1fr; gap: var(--spacing--2xs) var(--spacing--sm); margin: 0; align-items: baseline; }
.facts dt { font-size: var(--font-size--2xs); color: var(--color--text--shade-1); opacity: 0.7; }
.facts dd { margin: 0; font-size: var(--font-size--sm); }
.badges { display: flex; flex-wrap: wrap; gap: var(--spacing--4xs); }
.deps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--2xs); }
.dep { display: flex; align-items: center; gap: var(--spacing--2xs); flex-wrap: wrap; }
.dep-kind { font-size: var(--font-size--3xs); min-width: 6.5rem; }
.dep-node { font-size: var(--font-size--2xs); }
.gaps { margin: 0; padding-left: var(--spacing--md); font-size: var(--font-size--2xs); display: flex; flex-direction: column; gap: var(--spacing--5xs); }
.open { text-decoration: none; white-space: nowrap; }
.pad { padding: var(--spacing--md) var(--spacing--lg); }
.err { color: var(--color--danger); }

/* Columns stack before they get cramped; the estate list is still behind the scrim. */
@media (max-width: 760px) {
  .d-cols { grid-template-columns: 1fr; }
}
@media (max-width: 520px) {
  .glance { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/* Mobile (≤720px): the drawer goes full-width (off-canvas → full screen). */
@media (max-width: 720px) {
  .drawer { width: 100vw; border-left: 0; }
  .d-head { padding: var(--spacing--sm) var(--spacing--md); }
  .d-body { padding: var(--spacing--md); }
  .pad { padding: var(--spacing--md); }
}
</style>
