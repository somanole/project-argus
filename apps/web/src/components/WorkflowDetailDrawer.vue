<script setup lang="ts">
import { ref, watch } from 'vue';
import { workflowDetailSchema, type WorkflowDetail, type WorkflowListItem, type DirectDep, type RefKind } from '@argus/shared';
import { api } from '../lib/api';
import { instanceColor } from '../lib/instanceColor';
import StateBadge from './StateBadge.vue';
import FactBadge from './FactBadge.vue';
import EnrichmentSection from './EnrichmentSection.vue';

// The detail drawer: fetches the selected workflow's full facts + direct deps +
// n8n deep-link. Everything is deterministic ground truth; unknowns say so.
const props = defineProps<{ selected: WorkflowListItem | null }>();
const emit = defineEmits<{ close: [] }>();

const detail = ref<WorkflowDetail | null>(null);
const state = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
const error = ref<string | null>(null);

watch(
  () => props.selected,
  async (sel) => {
    detail.value = null;
    if (!sel) {
      state.value = 'idle';
      return;
    }
    state.value = 'loading';
    try {
      detail.value = await api(
        `/api/workflows/${encodeURIComponent(sel.instanceId)}/${encodeURIComponent(sel.id)}`,
        {},
        workflowDetailSchema,
      );
      state.value = 'ok';
      error.value = null;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not load workflow facts';
    }
  },
  { immediate: true },
);

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

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') emit('close');
};
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
        </div>
        <button class="btn btn--ghost btn--sm close" aria-label="Close" @click="emit('close')">✕</button>
      </header>

      <p v-if="state === 'loading'" class="muted pad">Analysing…</p>
      <p v-else-if="state === 'error'" class="err pad">Couldn’t load facts — {{ error }}.</p>

      <div v-else-if="state === 'ok' && detail" class="d-body">
        <div class="d-status">
          <StateBadge :active="selected.active" :is-archived="selected.isArchived" />
          <FactBadge v-if="selected.mcpExposed" label="MCP-exposed" tone="mcp" />
          <FactBadge v-if="detail.facts && !detail.facts.coverage.understood" label="partly unparsed" tone="warn" />
          <FactBadge v-if="selected.brokenRefCount > 0" :label="`${selected.brokenRefCount} broken ref${selected.brokenRefCount > 1 ? 's' : ''}`" tone="danger" />
        </div>

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

        <a v-if="detail.deepLink" class="btn btn--secondary btn--block open" :href="detail.deepLink" target="_blank" rel="noopener">
          Open in n8n ↗
        </a>
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
  width: min(30rem, 92vw);
  height: 100%;
  overflow-y: auto;
  background: var(--background--surface);
  border-left: 1px solid var(--border-color);
  padding: var(--spacing--lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing--md);
  box-shadow: var(--shadow--lg, none);
}
.d-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--sm); }
.d-title h2 { margin: 0; font-size: var(--font-size--lg); font-weight: var(--font-weight--bold); }
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--2xs); display: flex; gap: var(--spacing--4xs); align-items: center; }
.instance { display: inline-flex; align-items: center; gap: var(--spacing--4xs); }
.close { font-size: var(--font-size--md); line-height: 1; }
.d-body { display: flex; flex-direction: column; gap: var(--spacing--md); }
.d-status { display: flex; flex-wrap: wrap; gap: var(--spacing--4xs); }
.d-sec h3 {
  margin: 0 0 var(--spacing--2xs);
  font-size: var(--font-size--3xs);
  text-transform: uppercase;
  letter-spacing: var(--letter-spacing--wide);
  font-weight: var(--font-weight--bold);
  color: var(--color--text--shade-1);
  opacity: 0.6;
}
.facts { display: grid; grid-template-columns: auto 1fr; gap: var(--spacing--2xs) var(--spacing--sm); margin: 0; align-items: baseline; }
.facts dt { font-size: var(--font-size--2xs); color: var(--color--text--shade-1); opacity: 0.7; }
.facts dd { margin: 0; font-size: var(--font-size--sm); }
.badges { display: flex; flex-wrap: wrap; gap: var(--spacing--4xs); }
.deps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--2xs); }
.dep { display: flex; align-items: center; gap: var(--spacing--2xs); flex-wrap: wrap; }
.dep-kind { font-size: var(--font-size--3xs); min-width: 6.5rem; }
.dep-node { font-size: var(--font-size--2xs); }
.gaps { margin: 0; padding-left: var(--spacing--md); font-size: var(--font-size--2xs); display: flex; flex-direction: column; gap: var(--spacing--5xs); }
.open { margin-top: var(--spacing--2xs); text-decoration: none; }
.pad { padding: var(--spacing--md) 0; }
.err { color: var(--text-color--danger, var(--color--danger)); }

/* Mobile (≤720px): the drawer goes full-width (off-canvas → full screen). */
@media (max-width: 720px) {
  .drawer { width: 100vw; border-left: 0; padding: var(--spacing--md); }
}
</style>
