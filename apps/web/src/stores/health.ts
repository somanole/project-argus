import { defineStore } from 'pinia';
import { ref } from 'vue';
import { healthResponseSchema, type HealthResponse } from '@argus/shared';

/**
 * Fetches and holds the Argus server's `/api/health` response.
 *
 * Honest states only (standing rule 5): `loading` → `ok` when the server
 * answers with a contract-valid payload, or `error` with a plain-English reason
 * when it doesn't. Never invents a status the server didn't report.
 */
export const useHealthStore = defineStore('health', () => {
  const state = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const data = ref<HealthResponse | null>(null);
  const error = ref<string | null>(null);

  async function fetchHealth(): Promise<void> {
    state.value = 'loading';
    error.value = null;
    try {
      const res = await fetch('/api/health', { headers: { accept: 'application/json' } });
      if (!res.ok) {
        throw new Error(`server responded ${res.status}`);
      }
      // Validate against the shared contract — a shape mismatch is an error we
      // surface, not something we paper over.
      data.value = healthResponseSchema.parse(await res.json());
      state.value = 'ok';
    } catch (err) {
      data.value = null;
      error.value = err instanceof Error ? err.message : 'could not reach the Argus server';
      state.value = 'error';
    }
  }

  return { state, data, error, fetchHealth };
});
