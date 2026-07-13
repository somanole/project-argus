<script setup lang="ts">
// The drawer's sense-making section: plain-English summary, business context,
// criticality WITH its reason (always shown next to the label — never a bare level),
// risk flags, suggested-owner rationale, and provenance. Honest states (rule 5): a
// stub reads "couldn't analyze"; a stale row shows last-known analysis, flagged.
// The "Correct" control opens a dialog and performs the audited PUT.
import { ref, computed } from 'vue';
import { workflowDetailSchema, type WorkflowEnrichment, type WorkflowDetail, type Criticality } from '@argus/shared';
import { api } from '../lib/api';
import FactBadge from './FactBadge.vue';
import LabelCorrectionDialog from './LabelCorrectionDialog.vue';

const props = defineProps<{ enrichment: WorkflowEnrichment | null; instanceId: string; workflowId: string }>();
const emit = defineEmits<{ updated: [WorkflowDetail] }>();

const CRIT_TONE: Record<Criticality, 'danger' | 'warn' | 'muted'> = { critical: 'danger', high: 'warn', medium: 'muted', low: 'muted' };
const RISK_LABEL: Record<string, string> = {
  'handles-pii': 'Handles PII',
  'handles-financial-data': 'Financial data',
  'external-egress': 'External egress',
  'customer-facing': 'Customer-facing',
  'production-write': 'Writes production',
  'compliance-sensitive': 'Compliance-sensitive',
};

const e = computed(() => props.enrichment);
const dialogOpen = ref(false);
const saving = ref(false);
const saveError = ref<string | null>(null);

async function saveCorrection(correction: { category?: string; criticality?: string }): Promise<void> {
  if (!correction.category && !correction.criticality) {
    dialogOpen.value = false;
    return;
  }
  saving.value = true;
  saveError.value = null;
  try {
    const updated = await api(
      `/api/workflows/${encodeURIComponent(props.instanceId)}/${encodeURIComponent(props.workflowId)}/enrichment/correction`,
      { method: 'PUT', body: correction },
      workflowDetailSchema,
    );
    emit('updated', updated);
    dialogOpen.value = false;
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : 'could not save correction';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="d-sec" data-testid="enrichment-section">
    <div class="sec-head">
      <h3>What it does</h3>
      <button
        v-if="e && e.status !== 'stub'"
        class="btn btn--secondary btn--sm"
        data-testid="enrichment-correct-button"
        @click="dialogOpen = true"
      >
        Correct
      </button>
    </div>

    <!-- Not enriched (off / pending) -->
    <p v-if="!e" class="muted" data-testid="enrichment-empty">Not enriched yet.</p>

    <!-- Stub: couldn't analyze (rule 5) -->
    <p v-else-if="e.status === 'stub'" class="stub" data-testid="enrichment-stub">
      Couldn’t analyze this workflow. It’ll retry on the next run — this is a labelled fallback, not analysis.
    </p>

    <!-- Analyzed / stale -->
    <div v-else class="enr">
      <p v-if="e.status === 'stale'" class="stale" data-testid="enrichment-stale">
        Workflow changed since this was written — re-analyzing. Showing the last-known summary.
      </p>

      <p class="summary" data-testid="enrichment-summary">{{ e.summary }}</p>

      <div class="crit-row">
        <FactBadge
          v-if="e.criticality"
          :label="e.criticality"
          :tone="CRIT_TONE[e.criticality]"
          data-testid="enrichment-criticality-label"
        />
        <FactBadge
          v-if="e.category"
          :label="e.category"
          tone="trigger"
          data-testid="enrichment-category-label"
        />
        <span v-if="e.corrected" class="muted corrected" data-testid="enrichment-corrected">· edited by a person</span>
      </div>
      <!-- The reason is ALWAYS shown next to the criticality label (rule 5, spec). -->
      <p v-if="e.criticalityReason" class="reason" data-testid="enrichment-criticality-reason">{{ e.criticalityReason }}</p>

      <div v-if="e.riskFlags.length" class="risks" data-testid="enrichment-risk-flags">
        <span class="risks-label">Risk</span>
        <FactBadge v-for="f in e.riskFlags" :key="f" :label="RISK_LABEL[f] ?? f" tone="risk" />
      </div>

      <!-- The longer business-context prose lives behind a disclosure so the summary
           + risk flags lead; the suggested-owner rationale now sits in the Ownership
           section, next to the assign controls where it's actionable. -->
      <details v-if="e.businessContext" class="more-toggle" data-testid="enrichment-more">
        <summary>More context</summary>
        <dl class="more">
          <dt>Business context</dt>
          <dd>{{ e.businessContext }}</dd>
        </dl>
      </details>

      <p class="prov muted" data-testid="enrichment-provenance">Analyzed by {{ e.provider }} {{ e.model }}</p>
      <p v-if="saveError" class="err" role="alert">{{ saveError }}</p>
    </div>

    <LabelCorrectionDialog
      v-if="dialogOpen && e"
      :category="e.category"
      :criticality="e.criticality"
      @cancel="dialogOpen = false"
      @save="saveCorrection"
    />
  </section>
</template>

<style scoped>
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm); margin-bottom: var(--spacing--xs); }
/* Section heading — level 2: full-contrast, normal case, so sections anchor a scan
   (was tiny-uppercase-muted, indistinguishable from field labels). */
.d-sec h3 {
  margin: 0;
  font-size: var(--font-size--sm);
  font-weight: var(--font-weight--bold);
  color: var(--color--text--shade-1);
  letter-spacing: -0.005em;
}
.enr { display: flex; flex-direction: column; gap: var(--spacing--2xs); }
/* Level 3 — body: the summary leads, at full contrast. */
.summary { margin: 0; font-size: var(--font-size--sm); line-height: var(--line-height--md); }
.crit-row { display: flex; flex-wrap: wrap; gap: var(--spacing--4xs); align-items: center; }
.corrected { font-size: var(--font-size--3xs); }
/* Level 4 — supporting prose/meta, the ONE muted step (matches global .muted @ 0.65). */
.reason { margin: 0; font-size: var(--font-size--2xs); line-height: var(--line-height--md); color: var(--color--text--shade-1); opacity: 0.65; }
.risks { display: flex; flex-wrap: wrap; gap: var(--spacing--4xs); align-items: center; }
/* "Risk" reads like the other field labels (Nodes / Triggers), not a tiny uppercase eyebrow. */
.risks-label {
  font-size: var(--font-size--2xs);
  font-weight: var(--font-weight--bold); color: var(--color--text--shade-1);
  margin-right: var(--spacing--5xs);
}
.more-toggle > summary {
  cursor: pointer;
  list-style: none;
  font-size: var(--font-size--2xs);
  color: var(--color--primary, var(--background--brand));
  width: fit-content;
}
.more-toggle > summary::-webkit-details-marker { display: none; }
.more-toggle > summary::before { content: '▸ '; opacity: 0.7; }
.more-toggle[open] > summary::before { content: '▾ '; }
.more { display: grid; grid-template-columns: auto; gap: var(--spacing--4xs); margin: var(--spacing--4xs) 0 0; }
.more dt { font-size: var(--font-size--3xs); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide); color: var(--color--text--shade-1); opacity: 0.65; }
.more dd { margin: 0 0 var(--spacing--2xs); font-size: var(--font-size--2xs); line-height: var(--line-height--md); }
.prov { font-size: var(--font-size--3xs); }
.stub, .stale { margin: 0; font-size: var(--font-size--2xs); color: var(--color--warning); }
.summary + .crit-row { margin-top: var(--spacing--4xs); }
.err { color: var(--color--danger); font-size: var(--font-size--2xs); margin: 0; }
</style>
