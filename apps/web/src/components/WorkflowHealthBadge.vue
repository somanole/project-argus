<script setup lang="ts">
import { computed } from 'vue';
import type { WorkflowHealth } from '@argus/shared';

/**
 * Per-workflow execution health (S3). Honest by construction (rule 5): `idle` is
 * phrased against the retention window (never "never runs"), and `unknown` shows
 * "health unavailable" with the reason — never a green healthy poll. null = not yet
 * computed (freshly synced / pending).
 */
const props = defineProps<{ health: WorkflowHealth | null }>();

const windowDays = computed(() => (props.health ? Math.round(props.health.windowHours / 24) : 14));
const pct = computed(() =>
  props.health?.failureRate != null ? Math.round(props.health.failureRate * 100) : null,
);

/** S6.3 Layer 2 — an ADDITIVE overlay (never replaces the status pill): the run was green
 * but a node errored-and-continued. Factual, node-named; absent ≠ "verified clean". */
const silent = computed(() => {
  const sf = props.health?.silentFailures;
  if (!sf || sf.runsAffected <= 0) return null;
  const cls = [sf.lastErrorType, sf.lastErrorCode].filter(Boolean).join(' · ');
  const node = sf.lastNode ?? 'a node';
  return {
    title: `${node} errored but the run was marked success, ${sf.runsAffected} of ${sf.runsInspected} inspected run(s)${cls ? ` — ${cls}` : ''}`,
  };
});

const view = computed(() => {
  const h = props.health;
  if (!h) return { cls: 'badge--muted', dot: 'dot--muted', label: 'checking…', title: 'health not computed yet' };
  switch (h.status) {
    case 'failing':
      return { cls: 'badge--danger', dot: 'dot--danger', label: 'failing',
        title: `${pct.value}% of ${h.runsInWindow} run(s) failed in the last ~${windowDays.value} days` };
    case 'degraded':
      return { cls: 'badge--warn', dot: 'dot--warn', label: 'degraded',
        title: `${pct.value}% of ${h.runsInWindow} run(s) failed in the last ~${windowDays.value} days` };
    case 'healthy':
      return { cls: 'badge--ok', dot: 'dot--ok', label: 'healthy',
        title: `${h.runsInWindow} run(s), ${pct.value}% failed in the last ~${windowDays.value} days` };
    case 'idle':
      return { cls: 'badge--muted', dot: 'dot--muted', label: 'idle',
        title: `no runs in the last ~${windowDays.value} days` };
    default:
      return { cls: 'badge--muted', dot: 'dot--muted', label: 'health unavailable',
        title: h.unavailableReason ?? 'executions could not be read' };
  }
});
</script>

<template>
  <span class="hb">
    <span class="badge" :class="view.cls" data-testid="health-badge" :data-status="health?.status ?? 'pending'" :title="view.title">
      <span class="dot" :class="view.dot" />
      {{ view.label }}
    </span>
    <span v-if="silent" class="badge badge--warn silent" data-testid="health-silent-badge" :title="silent.title">
      ⚠ silently failing
    </span>
  </span>
</template>

<style scoped>
.hb {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing--4xs);
}
.silent {
  font-size: var(--font-size--3xs);
}
</style>
