import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { healthEstateResponseSchema, type HealthEstateResponse } from '@argus/shared';
import { api } from '../lib/api';

/**
 * The S3 "what's failing right now" feed (`GET /api/workflows/failing`): failing then
 * degraded workflows with their S2 criticality, a summary of every health state, and
 * the per-instance retention window. Honest states only (rule 5): the view shows a
 * plain-English reason on error and never invents health the server didn't report.
 */
export const useEstateHealthStore = defineStore('estateHealth', () => {
  const data = ref<HealthEstateResponse | null>(null);
  const state = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const error = ref<string | null>(null);
  const lastUpdated = ref<string | null>(null);

  /** The single retention window to headline (all instances share n8n's default). */
  const windowHours = computed(() => data.value?.windows[0]?.windowHours ?? 336);
  const windowDays = computed(() => Math.round(windowHours.value / 24));
  /** Instances whose executions couldn't be read — their health is unavailable, not green. */
  const unavailableInstances = computed(() => (data.value?.windows ?? []).filter((w) => !w.available));

  async function refresh(): Promise<void> {
    if (state.value === 'idle') state.value = 'loading';
    try {
      const res = await api('/api/workflows/failing', {}, healthEstateResponseSchema);
      data.value = res;
      lastUpdated.value = res.generatedAt;
      state.value = 'ok';
      error.value = null;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not load estate health';
    }
  }

  return { data, state, error, lastUpdated, windowHours, windowDays, unavailableInstances, refresh };
});
