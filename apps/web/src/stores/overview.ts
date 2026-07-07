import { defineStore } from 'pinia';
import { ref } from 'vue';
import { governanceOverviewResponseSchema, type GovernanceOverviewResponse } from '@argus/shared';
import { api } from '../lib/api';

/**
 * The S6 governance-overview data — the ONE composed read
 * (`GET /api/governance/overview`) that backs the dashboard. Pure composition on
 * the server; the store just fetches it and holds honest state (rule 5): a failed
 * load surfaces a plain-English reason, never invented numbers.
 */
export const useOverviewStore = defineStore('overview', () => {
  const data = ref<GovernanceOverviewResponse | null>(null);
  const state = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const error = ref<string | null>(null);
  const lastUpdated = ref<string | null>(null);

  /** The compliance-report download URL (a plain link, no fetch). */
  function exportUrl(): string {
    return '/api/governance/export';
  }

  async function refresh(): Promise<void> {
    if (state.value === 'idle') state.value = 'loading';
    try {
      data.value = await api('/api/governance/overview', {}, governanceOverviewResponseSchema);
      state.value = 'ok';
      error.value = null;
      lastUpdated.value = data.value.generatedAt;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not load the governance overview';
    }
  }

  return { data, state, error, lastUpdated, exportUrl, refresh };
});
