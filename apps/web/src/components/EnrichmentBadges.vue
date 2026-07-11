<script setup lang="ts">
// Compact enrichment badges for the catalog list: category + criticality (with the
// reason on hover). Honest states (rule 5): a stub reads "couldn't analyze", a stale
// row is flagged, and nothing is shown when a workflow isn't enriched.
import { computed } from 'vue';
import type { WorkflowEnrichment, Criticality } from '@argus/shared';
import FactBadge from './FactBadge.vue';

const props = defineProps<{ enrichment: WorkflowEnrichment | null }>();

const CRIT_TONE: Record<Criticality, 'danger' | 'warn' | 'muted' | 'faint'> = {
  critical: 'danger',
  high: 'warn',
  medium: 'muted',
  low: 'faint',
};
const CATEGORY_LABEL: Record<string, string> = {
  'revenue-ops': 'Revenue Ops',
  'sales-marketing': 'Sales & Marketing',
  'customer-support': 'Customer Support',
  'data-pipeline': 'Data Pipeline',
  integration: 'Integration',
  'internal-ops': 'Internal Ops',
  'monitoring-alerting': 'Monitoring',
  'ai-agent': 'AI Agent',
  other: 'Other',
};

const e = computed(() => props.enrichment);
const isStub = computed(() => e.value?.status === 'stub');
const isStale = computed(() => e.value?.status === 'stale');
</script>

<template>
  <span v-if="e" class="enrichment-badges" data-testid="enrichment-badges">
    <FactBadge
      v-if="isStub"
      label="couldn't analyze"
      tone="muted"
      title="Enrichment couldn't analyze this workflow"
      data-testid="enrichment-stub-badge"
    />
    <template v-else-if="e.criticality">
      <FactBadge
        :label="e.criticality"
        :tone="CRIT_TONE[e.criticality]"
        :title="e.criticalityReason ?? ''"
        data-testid="enrichment-criticality"
      />
      <FactBadge
        v-if="e.category"
        :label="CATEGORY_LABEL[e.category] ?? e.category"
        tone="trigger"
        data-testid="enrichment-category"
      />
      <FactBadge v-if="isStale" label="stale" tone="muted" title="Workflow changed — re-analyzing" data-testid="enrichment-stale-badge" />
    </template>
  </span>
</template>

<style scoped>
.enrichment-badges {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing--4xs);
  flex-wrap: wrap;
}
</style>
