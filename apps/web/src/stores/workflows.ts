import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { workflowsResponseSchema, type WorkflowListItem } from '@argus/shared';
import { api } from '../lib/api';

/**
 * The estate-wide workflow inventory, client side. Holds the flat list, the
 * selected instance filter, and drives the auto-refresh poll so the UI reflects
 * n8n changes on its own. `instanceId` is a filter, not a partition — 'all' is
 * the whole estate.
 */
export const useWorkflowsStore = defineStore('workflows', () => {
  const workflows = ref<WorkflowListItem[]>([]);
  const state = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const error = ref<string | null>(null);
  const lastUpdated = ref<string | null>(null);
  /** Selected instance id, or 'all' for the whole estate. */
  const filter = ref<string>('all');

  const filtered = computed(() =>
    filter.value === 'all' ? workflows.value : workflows.value.filter((w) => w.instanceId === filter.value),
  );

  async function refresh(): Promise<void> {
    if (state.value === 'idle') state.value = 'loading';
    try {
      const res = await api('/api/workflows', {}, workflowsResponseSchema);
      workflows.value = res.workflows;
      lastUpdated.value = res.generatedAt;
      state.value = 'ok';
      error.value = null;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not load workflows';
    }
  }

  function setFilter(id: string): void {
    filter.value = id;
  }

  return { workflows, filtered, state, error, lastUpdated, filter, refresh, setFilter };
});
