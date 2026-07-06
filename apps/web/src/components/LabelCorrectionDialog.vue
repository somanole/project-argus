<script setup lang="ts">
// A small modal to correct a workflow's category / criticality label. Options come
// straight from the shared enums (single source of truth). Emits the correction; the
// parent performs the audited PUT.
import { ref } from 'vue';
import { enrichmentCategorySchema, criticalitySchema, type EnrichmentCategory, type Criticality } from '@argus/shared';

const props = defineProps<{ category: EnrichmentCategory | null; criticality: Criticality | null }>();
const emit = defineEmits<{ save: [{ category?: EnrichmentCategory; criticality?: Criticality }]; cancel: [] }>();

const categoryOptions = enrichmentCategorySchema.options;
const criticalityOptions = criticalitySchema.options;

const category = ref<EnrichmentCategory | null>(props.category);
const criticality = ref<Criticality | null>(props.criticality);

function save(): void {
  const out: { category?: EnrichmentCategory; criticality?: Criticality } = {};
  if (category.value && category.value !== props.category) out.category = category.value;
  if (criticality.value && criticality.value !== props.criticality) out.criticality = criticality.value;
  emit('save', out);
}
</script>

<template>
  <div class="scrim" tabindex="-1" @click.self="emit('cancel')" @keydown.esc="emit('cancel')">
    <div class="dialog card" role="dialog" aria-label="Correct labels" data-testid="label-correction-dialog">
      <h3>Correct labels</h3>
      <div class="field">
        <label for="corr-cat">Category</label>
        <select id="corr-cat" v-model="category" class="input" data-testid="label-correction-category">
          <option v-for="c in categoryOptions" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div class="field">
        <label for="corr-crit">Criticality</label>
        <select id="corr-crit" v-model="criticality" class="input" data-testid="label-correction-criticality">
          <option v-for="c in criticalityOptions" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div class="actions">
        <button class="btn btn--ghost btn--sm" @click="emit('cancel')">Cancel</button>
        <button class="btn btn--primary btn--sm" data-testid="label-correction-save" @click="save">Save correction</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--color--text--shade-1) 40%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
  padding: var(--spacing--md);
}
.dialog { width: min(24rem, 100%); display: flex; flex-direction: column; gap: var(--spacing--sm); }
.dialog h3 { margin: 0; font-size: var(--font-size--md); font-weight: var(--font-weight--bold); }
.field { display: flex; flex-direction: column; gap: var(--spacing--4xs); }
.field label { font-size: var(--font-size--2xs); color: var(--color--text--shade-1); opacity: 0.7; }
.actions { display: flex; justify-content: flex-end; gap: var(--spacing--2xs); margin-top: var(--spacing--2xs); }
</style>
