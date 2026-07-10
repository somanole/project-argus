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
      health: { status: 'ok', lastSyncedAt: '2026-07-05T00:00:00.000Z', lastError: null, workflowCount: 29, analyzerDrift: null },
    },
  ],
};

const driftBody = {
  connections: [
    {
      id: 'a', label: 'prod', baseUrl: 'http://localhost:5678', webhookHost: null,
      createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-05T00:00:00.000Z',
      health: {
        status: 'ok', lastSyncedAt: '2026-07-05T00:00:00.000Z', lastError: null, workflowCount: 29,
        analyzerDrift: {
          manifestN8nVersion: '2.29.0', status: 'core-drift',
          coreUnknown: { types: 4, workflows: 3 }, communityUnknown: { types: 0, workflows: 0 },
          coreExamples: ['n8n-nodes-base.__futureNode'], communityExamples: [],
        },
      },
    },
  ],
};

describe('Connections chrome — UI-presence (rule 11)', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('renders the connection-health indicator with its state; no drift notice when current', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => connectionsBody })));
    const w = mount(ConnectionsView, { global: { stubs: { 'router-link': RouterLinkStub } } });
    await flushPromises();

    const health = w.find('[data-testid="connection-health"]');
    expect(health.exists()).toBe(true);
    expect(health.text()).toContain('Connected'); // 'ok' → "Connected"
    // A current connection (null drift) shows NO drift notice.
    expect(w.find('[data-testid="analyzer-drift"]').exists()).toBe(false);

    w.unmount();
  });

  it('renders the analyzer-drift notice for a core-drift connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => driftBody })));
    const w = mount(ConnectionsView, { global: { stubs: { 'router-link': RouterLinkStub } } });
    await flushPromises();

    const notice = w.find('[data-testid="analyzer-drift"]');
    expect(notice.exists()).toBe(true);
    expect(notice.attributes('data-drift-status')).toBe('core-drift');
    expect(notice.text()).toContain('Coverage may have dropped');
    expect(notice.text()).toContain('4 core node types');

    w.unmount();
  });
});
