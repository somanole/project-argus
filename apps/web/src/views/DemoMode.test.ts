import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ConnectionsView from './ConnectionsView.vue';
import SettingsView from './SettingsView.vue';
import LoginView from './LoginView.vue';
import { useAuthStore } from '../stores/auth';

vi.mock('vue-router', () => ({ useRouter: () => ({ replace: vi.fn() }), useRoute: () => ({ query: {} }) }));

/**
 * Public-demo affordance (rule 11).
 *
 * The server already refuses every mutating request in demo mode, so this is about
 * honesty rather than security (rule 5): a visitor should SEE what Argus can do and
 * find those controls visibly disabled, instead of clicking into a 403. The controls
 * must therefore still render — disabling them must never mean hiding them.
 */

const connectionsBody = {
  connections: [
    {
      id: 'a', label: 'prod', baseUrl: 'http://localhost:5678', webhookHost: null,
      createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-05T00:00:00.000Z',
      health: { status: 'ok', lastSyncedAt: '2026-07-05T00:00:00.000Z', lastError: null, workflowCount: 29, analyzerDrift: null },
    },
  ],
};

const llmBody = {
  config: { provider: 'openai', model: 'gpt-5-mini', baseUrl: null, capabilities: null, configured: true, enabled: true, envLocked: false },
};
const progressBody = { enabled: true, lastEnrichedAt: null, total: 29, analyzed: 29, stub: 0, stale: 0, pending: 0 };

function stubFetch(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const payload = u.includes('/settings/llm') ? llmBody : u.includes('enrichment-progress') ? progressBody : body;
    return { ok: true, status: 200, json: async () => payload };
  }));
}

async function mountWith(component: unknown, demoMode: boolean, body: unknown) {
  setActivePinia(createPinia());
  stubFetch(body);
  const auth = useAuthStore();
  auth.demoMode = demoMode;
  const w = mount(component as never, { global: { stubs: { 'router-link': RouterLinkStub } } });
  await flushPromises();
  return w;
}

afterEach(() => vi.unstubAllGlobals());

describe('demo mode — write controls are visible but disabled', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('Connections: Remove and Register stay rendered but are disabled', async () => {
    const w = await mountWith(ConnectionsView, true, connectionsBody);
    const remove = w.find('[data-testid="remove-connection"]');
    const register = w.find('[data-testid="register-submit"]');
    expect(remove.exists()).toBe(true); // still visible — never hidden
    expect(register.exists()).toBe(true);
    expect(remove.attributes('disabled')).toBeDefined();
    expect(register.attributes('disabled')).toBeDefined();
    expect(w.find('[data-testid="demo-readonly-notice"]').exists()).toBe(true);
    w.unmount();
  });

  it('Connections: the same controls are enabled in a normal deployment', async () => {
    const w = await mountWith(ConnectionsView, false, connectionsBody);
    expect(w.find('[data-testid="remove-connection"]').attributes('disabled')).toBeUndefined();
    expect(w.find('[data-testid="register-submit"]').attributes('disabled')).toBeUndefined();
    expect(w.find('[data-testid="demo-readonly-notice"]').exists()).toBe(false);
    w.unmount();
  });

  it('Settings: every Smart-features write control is rendered and disabled', async () => {
    const w = await mountWith(SettingsView, true, llmBody);
    for (const id of ['enrichment-toggle', 'provider-card-openai', 'provider-card-anthropic', 'llm-key-input', 'llm-save']) {
      const el = w.find(`[data-testid="${id}"]`);
      expect(el.exists(), `${id} should still be visible`).toBe(true);
      expect(el.attributes('disabled'), `${id} should be disabled`).toBeDefined();
    }
    expect(w.find('[data-testid="demo-readonly-notice"]').exists()).toBe(true);
    w.unmount();
  });

  it('Settings: the kill switch and provider choice work normally when not a demo', async () => {
    const w = await mountWith(SettingsView, false, llmBody);
    expect(w.find('[data-testid="enrichment-toggle"]').attributes('disabled')).toBeUndefined();
    expect(w.find('[data-testid="provider-card-openai"]').attributes('disabled')).toBeUndefined();
    expect(w.find('[data-testid="demo-readonly-notice"]').exists()).toBe(false);
    w.unmount();
  });
});

describe('demo mode — login pre-fill', () => {
  it('pre-fills the password from the server and explains why', async () => {
    setActivePinia(createPinia());
    stubFetch({});
    const auth = useAuthStore();
    auth.demoMode = true;
    auth.demoPassword = 'argus-demo-x';
    const w = mount(LoginView, { global: { stubs: { 'router-link': RouterLinkStub } } });
    await flushPromises();
    expect((w.find('#pw').element as HTMLInputElement).value).toBe('argus-demo-x');
    expect(w.find('[data-testid="demo-login-hint"]').exists()).toBe(true);
    w.unmount();
  });

  it('leaves the password empty on a normal deployment', async () => {
    setActivePinia(createPinia());
    stubFetch({});
    const auth = useAuthStore();
    auth.demoMode = false;
    auth.demoPassword = null;
    const w = mount(LoginView, { global: { stubs: { 'router-link': RouterLinkStub } } });
    await flushPromises();
    expect((w.find('#pw').element as HTMLInputElement).value).toBe('');
    expect(w.find('[data-testid="demo-login-hint"]').exists()).toBe(false);
    w.unmount();
  });
});
