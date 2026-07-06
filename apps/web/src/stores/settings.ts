import { defineStore } from 'pinia';
import { ref } from 'vue';
import { llmConfigResponseSchema, enrichmentProgressSchema, type LlmConfig, type LlmProvider, type EnrichmentProgress } from '@argus/shared';
import { api } from '../lib/api';

/**
 * The LLM provider settings, client side. The key is write-only from here — the
 * server never returns it, so the store only ever holds the SAFE view (provider,
 * model, configured, enabled).
 */
export const useSettingsStore = defineStore('settings', () => {
  const config = ref<LlmConfig | null>(null);
  const progress = ref<EnrichmentProgress | null>(null);
  const state = ref<'idle' | 'loading' | 'ok' | 'error' | 'saving'>('idle');
  const error = ref<string | null>(null);

  async function refreshProgress(): Promise<void> {
    try {
      progress.value = await api('/api/workflows/enrichment-progress', {}, enrichmentProgressSchema);
    } catch {
      progress.value = null;
    }
  }

  async function load(): Promise<void> {
    if (state.value === 'idle') state.value = 'loading';
    try {
      const res = await api('/api/settings/llm', {}, llmConfigResponseSchema);
      config.value = res.config;
      await refreshProgress();
      state.value = 'ok';
      error.value = null;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not load settings';
    }
  }

  /** Trigger an enrichment pass now (gated — only pending/changed workflows re-enrich). */
  async function runNow(): Promise<EnrichmentProgress | null> {
    try {
      progress.value = await api('/api/settings/enrichment/run', { method: 'POST' }, enrichmentProgressSchema);
      error.value = null;
      return progress.value;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'could not start enrichment';
      return null;
    }
  }

  /** Flip the enrichment master switch. Returns false on failure (state holds the reason). */
  async function setEnabled(enabled: boolean): Promise<boolean> {
    state.value = 'saving';
    try {
      const res = await api('/api/settings/enrichment', { method: 'PUT', body: { enabled } }, llmConfigResponseSchema);
      config.value = res.config;
      state.value = 'ok';
      error.value = null;
      return true;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not update enrichment';
      return false;
    }
  }

  async function save(provider: LlmProvider, apiKey: string): Promise<boolean> {
    state.value = 'saving';
    try {
      const res = await api('/api/settings/llm', { method: 'PUT', body: { provider, apiKey } }, llmConfigResponseSchema);
      config.value = res.config;
      state.value = 'ok';
      error.value = null;
      return true;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not save settings';
      return false;
    }
  }

  return { config, progress, state, error, load, save, setEnabled, runNow, refreshProgress };
});
