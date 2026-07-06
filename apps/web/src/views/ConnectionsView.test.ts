import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ConnectionsView from './ConnectionsView.vue';

/**
 * Rule-11 UI-presence check for the connection-health indicator (a signed-off S1a
 * element). It lives on the Connections screen (not the catalog header), so we guard
 * it here — presence + its state label, not appearance.
 */
const connectionsBody = {
  connections: [
    {
      id: 'a', label: 'prod', baseUrl: 'http://localhost:5678', webhookHost: null,
      createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-05T00:00:00.000Z',
      health: { status: 'ok', lastSyncedAt: '2026-07-05T00:00:00.000Z', lastError: null, workflowCount: 29 },
    },
  ],
};

describe('Connections chrome — UI-presence (rule 11)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => connectionsBody })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the connection-health indicator with its state', async () => {
    const w = mount(ConnectionsView, { global: { stubs: { 'router-link': RouterLinkStub } } });
    await flushPromises();

    const health = w.find('[data-testid="connection-health"]');
    expect(health.exists()).toBe(true);
    expect(health.text()).toContain('Connected'); // 'ok' → "Connected"

    w.unmount();
  });
});
