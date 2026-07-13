import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SettingsView from './SettingsView.vue';

/** Rule-11 UI-presence: the Settings master switch + provider selection. */
type Caps = { structuredOutput: boolean; streamingToolCalls: boolean; probedAt: string; note: string | null };
type Cfg = {
  provider: string | null;
  model: string | null;
  configured: boolean;
  enabled: boolean;
  envLocked: boolean;
  /** openai_compatible only (DECISION #30); a hosted provider reports neither. */
  baseUrl?: string | null;
  capabilities?: Caps | null;
};
const PROGRESS = { enabled: true, lastEnrichedAt: '2026-07-06T15:24:00.000Z', total: 3, analyzed: 3, stub: 0, stale: 0, pending: 0 };
function stub(config: Cfg, onPut?: (body: unknown) => void) {
  // The response must satisfy llmConfigResponseSchema, so default the endpoint fields to
  // what a hosted provider actually reports: no base URL, no probed capabilities.
  const full = { baseUrl: null, capabilities: null, ...config };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT' && onPut) onPut(JSON.parse(String(init.body)));
    const body = String(url).includes('enrichment-progress') || String(url).includes('enrichment/run') ? PROGRESS : { config: full };
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

  it('presents the provider under a "Smart features" section naming both features', async () => {
    stub({ provider: 'openai', model: 'gpt-5-mini', configured: true, enabled: true, envLocked: false });
    const w = await mountView();
    expect(tid(w, 'smart-features-heading').text()).toBe('Smart features');
    // The copy makes the shared scope explicit: one switch, enrichment AND chat.
    expect(tid(w, 'smart-features-heading').element.parentElement?.textContent?.toLowerCase()).toContain('chat');
    expect(tid(w, 'llm-status').text().toLowerCase()).toContain('chat');
  });

  it('opens and closes the "what\'s sent to the provider" egress drawer', async () => {
    stub({ provider: null, model: null, configured: false, enabled: false, envLocked: false });
    const w = await mountView();
    expect(tid(w, 'egress-open').exists()).toBe(true);
    expect(tid(w, 'egress-drawer').exists()).toBe(false); // closed by default
    await tid(w, 'egress-open').trigger('click');
    const drawer = tid(w, 'egress-drawer');
    expect(drawer.exists()).toBe(true);
    // It documents BOTH features' egress.
    expect(tid(w, 'egress-enrichment').exists()).toBe(true);
    expect(tid(w, 'egress-chat').exists()).toBe(true);
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
          : { config: { provider: 'openai', model: 'gpt-5-mini', baseUrl: null, capabilities: null, configured: true, enabled: true, envLocked: false } } })));
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

/** UI-presence for the third provider (rule 11 · DECISION #30). */
describe('SettingsView — custom OpenAI-compatible endpoint', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  const ON: Cfg = { provider: 'openai', model: 'gpt-5-mini', configured: true, enabled: true, envLocked: false };
  const selectCustom = async (w: ReturnType<typeof mount>) => {
    await tid(w, 'provider-card-openai_compatible').trigger('click');
    await flushPromises();
  };

  it('offers a third provider card, and its endpoint fields appear only when selected', async () => {
    stub(ON);
    const w = await mountView();
    expect(tid(w, 'provider-card-openai_compatible').exists()).toBe(true);
    // Hidden while a hosted provider is selected…
    expect(tid(w, 'llm-base-url-input').exists()).toBe(false);
    await selectCustom(w);
    // …and present once the custom endpoint is chosen.
    expect(tid(w, 'llm-base-url-input').exists()).toBe(true);
    expect(tid(w, 'llm-model-input').exists()).toBe(true);
    expect(tid(w, 'llm-key-input').exists()).toBe(true);
  });

  it('marks the API key optional and allows saving a KEYLESS endpoint', async () => {
    let putBody: unknown;
    stub(ON, (b) => (putBody = b));
    const w = await mountView();
    await selectCustom(w);
    expect(w.find('label[for="llm-key"]').text()).toMatch(/optional/i);

    await tid(w, 'llm-base-url-input').setValue('http://127.0.0.1:11434/v1');
    await tid(w, 'llm-model-input').setValue('llama3.1:8b');
    await flushPromises();
    expect(tid(w, 'llm-save').attributes('disabled')).toBeUndefined(); // saveable with no key
    await tid(w, 'llm-save').trigger('click');
    await flushPromises();
    expect(putBody).toEqual({ provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1:8b' });
  });

  it('blocks save and explains why on an invalid base URL', async () => {
    stub(ON);
    const w = await mountView();
    await selectCustom(w);
    await tid(w, 'llm-base-url-input').setValue('ftp://nope/v1');
    await tid(w, 'llm-model-input').setValue('m');
    await flushPromises();
    expect(tid(w, 'llm-base-url-error').exists()).toBe(true);
    expect(tid(w, 'llm-save').attributes('disabled')).toBeDefined();
  });

  it('warns that plain http:// carries estate metadata unencrypted (allowed, never silent)', async () => {
    stub(ON);
    const w = await mountView();
    await selectCustom(w);
    await tid(w, 'llm-base-url-input').setValue('http://127.0.0.1:11434/v1');
    await flushPromises();
    expect(tid(w, 'llm-insecure-warning').text()).toMatch(/unencrypted/i);

    await tid(w, 'llm-base-url-input').setValue('https://gw.acme.example/v1');
    await flushPromises();
    expect(tid(w, 'llm-insecure-warning').exists()).toBe(false); // https ⇒ no warning
  });

  it('shows the probed capabilities, and says chat is unavailable when tools are unsupported', async () => {
    stub({
      provider: 'openai_compatible',
      model: 'phi4-mini:3.8b',
      baseUrl: 'http://127.0.0.1:11434/v1',
      capabilities: { structuredOutput: true, streamingToolCalls: false, probedAt: '2026-07-10T00:00:00.000Z', note: 'Pick a tool-calling model.' },
      configured: true,
      enabled: true,
      envLocked: false,
    });
    const w = await mountView();
    expect(tid(w, 'llm-capabilities').exists()).toBe(true);
    expect(tid(w, 'llm-capabilities-endpoint').text()).toContain('http://127.0.0.1:11434/v1');
    expect(tid(w, 'cap-structured-output').text()).toMatch(/supported/i);
    expect(tid(w, 'cap-tool-calls').text()).toMatch(/unavailable/i);
    expect(tid(w, 'llm-chat-unavailable').text()).toMatch(/chat is unavailable/i);
    expect(tid(w, 'llm-capabilities-note').text()).toContain('tool-calling model');
    // The status banner still says enrichment is active — the rest of Argus keeps working.
    expect(tid(w, 'llm-status').text().toLowerCase()).toContain('active');
  });

  it('hides the chat-unavailable notice when the endpoint DOES support tool calls', async () => {
    stub({
      provider: 'openai_compatible',
      model: 'llama3.1:8b',
      baseUrl: 'http://127.0.0.1:11434/v1',
      capabilities: { structuredOutput: true, streamingToolCalls: true, probedAt: '2026-07-10T00:00:00.000Z', note: null },
      configured: true,
      enabled: true,
      envLocked: false,
    });
    const w = await mountView();
    expect(tid(w, 'cap-tool-calls').text()).toMatch(/supported/i);
    expect(tid(w, 'llm-chat-unavailable').exists()).toBe(false);
  });

  it('shows no capability panel for a hosted provider (both seams are known-good)', async () => {
    stub(ON);
    const w = await mountView();
    expect(tid(w, 'llm-capabilities').exists()).toBe(false);
  });
});
