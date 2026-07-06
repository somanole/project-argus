import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  workflowsResponseSchema,
  coverageResponseSchema,
  enrichmentProgressSchema,
  type WorkflowListItem,
  type WorkflowFacets,
  type CoverageResponse,
  type EnrichmentProgress,
} from '@argus/shared';
import { api } from '../lib/api';

/**
 * The estate-wide catalog, client side. Filtering is SERVER-side (S1b): the store
 * holds the active filters, builds the query, and renders exactly what the server
 * returns. `instanceId` is a filter, not a partition — 'all' is the whole estate.
 * Facets are computed over the whole estate (unfiltered) so the chips stay stable
 * while you filter.
 */
export type StateFilter = 'all' | 'active' | 'archived';

const emptyFacets: WorkflowFacets = { systems: [], triggers: [], instances: [] };

export const useWorkflowsStore = defineStore('workflows', () => {
  const workflows = ref<WorkflowListItem[]>([]);
  const facets = ref<WorkflowFacets>(emptyFacets);
  const coverage = ref<CoverageResponse | null>(null);
  const enrichmentProgress = ref<EnrichmentProgress | null>(null);
  const state = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const error = ref<string | null>(null);
  const lastUpdated = ref<string | null>(null);

  // ---- filters (all AND together; systems/triggers are OR within their facet) ----
  const instanceId = ref<string>('all');
  const systems = ref<string[]>([]);
  const triggers = ref<string[]>([]);
  const mcpOnly = ref<boolean>(false);
  const brokenOnly = ref<boolean>(false);
  const criticality = ref<string[]>([]);
  const health = ref<string[]>([]);
  const stateFilter = ref<StateFilter>('all');
  const q = ref<string>('');

  const activeFilterCount = computed(
    () =>
      (instanceId.value !== 'all' ? 1 : 0) +
      systems.value.length +
      triggers.value.length +
      criticality.value.length +
      health.value.length +
      (mcpOnly.value ? 1 : 0) +
      (brokenOnly.value ? 1 : 0) +
      (stateFilter.value !== 'all' ? 1 : 0) +
      (q.value.trim() ? 1 : 0),
  );

  /** Friendly labels for trigger node types, from the facets. */
  const triggerLabels = computed<Record<string, string>>(() =>
    Object.fromEntries(facets.value.triggers.map((t) => [t.value, t.label])),
  );

  function buildQuery(): string {
    const p = new URLSearchParams();
    if (instanceId.value !== 'all') p.set('instanceId', instanceId.value);
    for (const s of systems.value) p.append('system', s);
    for (const t of triggers.value) p.append('trigger', t);
    for (const c of criticality.value) p.append('criticality', c);
    for (const h of health.value) p.append('health', h);
    if (mcpOnly.value) p.set('mcp', 'true');
    if (brokenOnly.value) p.set('broken', 'true');
    if (stateFilter.value === 'active') p.set('active', 'true');
    if (stateFilter.value === 'archived') p.set('archived', 'true');
    const query = q.value.trim();
    if (query) p.set('q', query);
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  async function refresh(): Promise<void> {
    if (state.value === 'idle') state.value = 'loading';
    try {
      const res = await api(`/api/workflows${buildQuery()}`, {}, workflowsResponseSchema);
      workflows.value = res.workflows;
      facets.value = res.facets;
      lastUpdated.value = res.generatedAt;
      state.value = 'ok';
      error.value = null;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not load the catalog';
    }
  }

  async function refreshCoverage(): Promise<void> {
    try {
      coverage.value = await api('/api/workflows/coverage', {}, coverageResponseSchema);
    } catch {
      coverage.value = null; // honest: show nothing rather than a guess (rule 5)
    }
  }

  async function refreshEnrichmentProgress(): Promise<void> {
    try {
      enrichmentProgress.value = await api('/api/workflows/enrichment-progress', {}, enrichmentProgressSchema);
    } catch {
      enrichmentProgress.value = null;
    }
  }

  // ---- filter mutations (each re-queries) ----
  const toggle = (list: typeof systems, value: string) => {
    list.value = list.value.includes(value) ? list.value.filter((v) => v !== value) : [...list.value, value];
    void refresh();
  };
  const setInstance = (id: string) => {
    instanceId.value = id;
    void refresh();
  };
  const toggleSystem = (s: string) => toggle(systems, s);
  const toggleTrigger = (t: string) => toggle(triggers, t);
  const toggleCriticality = (c: string) => toggle(criticality, c);
  const toggleHealth = (h: string) => toggle(health, h);
  const setMcpOnly = (v: boolean) => {
    mcpOnly.value = v;
    void refresh();
  };
  const setBrokenOnly = (v: boolean) => {
    brokenOnly.value = v;
    void refresh();
  };
  const setStateFilter = (v: StateFilter) => {
    stateFilter.value = v;
    void refresh();
  };
  const setQuery = (v: string) => {
    q.value = v;
    void refresh();
  };
  const clearFilters = () => {
    instanceId.value = 'all';
    systems.value = [];
    triggers.value = [];
    criticality.value = [];
    health.value = [];
    mcpOnly.value = false;
    brokenOnly.value = false;
    stateFilter.value = 'all';
    q.value = '';
    void refresh();
  };

  return {
    workflows,
    facets,
    coverage,
    enrichmentProgress,
    state,
    error,
    lastUpdated,
    instanceId,
    systems,
    triggers,
    criticality,
    health,
    mcpOnly,
    brokenOnly,
    stateFilter,
    q,
    activeFilterCount,
    triggerLabels,
    refresh,
    refreshCoverage,
    refreshEnrichmentProgress,
    setInstance,
    toggleSystem,
    toggleTrigger,
    toggleCriticality,
    toggleHealth,
    setMcpOnly,
    setBrokenOnly,
    setStateFilter,
    setQuery,
    clearFilters,
  };
});
