import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SettingsView from './SettingsView.vue';

/** Rule-11 UI-presence: the Settings master switch + provider selection. */
type Cfg = { provider: string | null; model: string | null; configured: boolean; enabled: boolean; envLocked: boolean };
const PROGRESS = { enabled: true, lastEnrichedAt: '2026-07-06T15:24:00.000Z', total: 3, analyzed: 3, stub: 0, stale: 0, pending: 0 };
function stub(config: Cfg, onPut?: (body: unknown) => void) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT' && onPut) onPut(JSON.parse(String(init.body)));
    const body = String(url).includes('enrichment-progress') || String(url).includes('enrichment/run') ? PROGRESS : { config };
    return { ok: true, status: 200, json: async () => body };
  }));
}
const tid = (w: ReturnType<typeof mount>, id: string) => w.find(`[data-testid="${id}"]`);
const mountView = async () => {
  const w = mount(SettingsView);
  await flushPromises();
  return w;
};

describe('SettingsView (rule 11)', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('always shows the master switch and a status line', async () => {
    stub({ provider: null, model: null, configured: false, enabled: false, envLocked: false });
    const w = await mountView();
    expect(tid(w, 'settings-view').exists()).toBe(true);
    expect(tid(w, 'enrichment-toggle').exists()).toBe(true);
    expect(tid(w, 'llm-status').exists()).toBe(true);
  });

  it('when OFF: hides the provider block and says Argus is deterministic', async () => {
    stub({ provider: null, model: null, configured: false, enabled: false, envLocked: false });
    const w = await mountView();
    expect(tid(w, 'enrichment-toggle').text()).toContain('Off');
    expect(tid(w, 'llm-status').text().toLowerCase()).toContain('deterministic');
    expect(tid(w, 'llm-provider-select').exists()).toBe(false); // hidden while off
  });

  it('when ON + configured: states the active provider and badges it', async () => {
    stub({ provider: 'openai', model: 'gpt-5-mini', configured: true, enabled: true, envLocked: false });
    const w = await mountView();
    expect(tid(w, 'enrichment-toggle').text()).toContain('On');
    expect(tid(w, 'llm-status').text().toLowerCase()).toContain('active');
    expect(tid(w, 'llm-status').text()).toContain('gpt-5-mini');
    // Provider cards visible; the configured one is badged Active.
    expect(tid(w, 'provider-card-openai').exists()).toBe(true);
    expect(tid(w, 'provider-card-anthropic').exists()).toBe(true);
    expect(tid(w, 'provider-active-badge').exists()).toBe(true);
    expect(tid(w, 'llm-key-input').exists()).toBe(true);
    expect(tid(w, 'llm-save').exists()).toBe(true);
  });

  it('when ON + no key: prompts to add one', async () => {
    stub({ provider: null, model: null, configured: false, enabled: true, envLocked: false });
    const w = await mountView();
    expect(tid(w, 'llm-status').text().toLowerCase()).toContain('no provider key');
    expect(tid(w, 'llm-provider-select').exists()).toBe(true);
  });

  it('when ops-locked: the switch is disabled and says so', async () => {
    stub({ provider: null, model: null, configured: false, enabled: false, envLocked: true });
    const w = await mountView();
    expect(tid(w, 'enrichment-toggle').attributes('disabled')).toBeDefined();
    expect(tid(w, 'llm-status').text()).toContain('ENRICHMENT_ENABLED');
  });

  it('shows when enrichment last ran and offers a re-run trigger', async () => {
    stub({ provider: 'openai', model: 'gpt-5-mini', configured: true, enabled: true, envLocked: false });
    const w = await mountView();
    expect(tid(w, 'enrichment-run').exists()).toBe(true);
    // "last ran" reflects the timestamp (locale-formatted, so assert it's not "never").
    expect(tid(w, 'enrichment-last-ran').text()).not.toBe('never');
    expect(tid(w, 'enrich-now').exists()).toBe(true);
  });

  it('"Enrich now" says "up to date" when nothing needs re-enriching (no fake success)', async () => {
    stub({ provider: 'openai', model: 'gpt-5-mini', configured: true, enabled: true, envLocked: false }); // PROGRESS has 0 pending/stale
    const w = await mountView();
    await tid(w, 'enrich-now').trigger('click');
    await flushPromises();
    expect(tid(w, 'enrichment-run-note').text().toLowerCase()).toContain('up to date');
    // The button is NOT left implying work happened.
    expect(tid(w, 'enrich-now').text()).toContain('Enrich now');
  });

  it('"never" until the first enrichment', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      ({ ok: true, status: 200, json: async () =>
        String(url).includes('enrichment-progress')
          ? { enabled: true, lastEnrichedAt: null, total: 3, analyzed: 0, stub: 0, stale: 0, pending: 3 }
          : { config: { provider: 'openai', model: 'gpt-5-mini', configured: true, enabled: true, envLocked: false } } })));
    const w = await mountView();
    expect(tid(w, 'enrichment-last-ran').text()).toBe('never');
  });

  it('toggling the switch PUTs the new enrichment state', async () => {
    let putBody: unknown;
    stub({ provider: null, model: null, configured: false, enabled: false, envLocked: false }, (b) => (putBody = b));
    const w = await mountView();
    await tid(w, 'enrichment-toggle').trigger('click');
    await flushPromises();
    expect(putBody).toEqual({ enabled: true });
  });
});
