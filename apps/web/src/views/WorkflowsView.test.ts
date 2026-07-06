import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WorkflowsView from './WorkflowsView.vue';

/**
 * Rule-11 UI-presence checks for the persistent catalog chrome: every signed-off
 * header element and filter control renders with its key text/state. These assert
 * presence/state, NOT appearance — the freshness pill's live timestamp is dynamic,
 * so we assert the element + its STATIC label ("Polling", "synced"), not the number.
 */
const workflowsBody = {
  workflows: [
    {
      instanceId: 'a', instanceLabel: 'prod', id: 'w1', name: 'Alpha', active: true, isArchived: false,
      project: 'Revenue Ops', updatedAt: '2026-07-05T00:00:00.000Z',
      systems: ['Salesforce'], triggers: ['n8n-nodes-base.webhook'], mcpExposed: true, nodeCount: 3, understood: true, brokenRefCount: 0,
    },
  ],
  facets: {
    systems: [{ value: 'Salesforce', count: 1 }],
    triggers: [{ value: 'n8n-nodes-base.webhook', label: 'Webhook', count: 1 }],
    instances: [{ id: 'a', label: 'prod', count: 1 }],
  },
  generatedAt: '2026-07-05T00:00:00.000Z',
};
const coverageBody = {
  total: 1, understood: 1, understoodPct: 100, gapsByKind: {}, unknownNodeTypes: [],
  unresolvedRefTotal: 0, dynamicRefTotal: 0, brokenRefTotal: 0, perInstance: [],
};

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.includes('/api/workflows/coverage') ? coverageBody
      : u.includes('/api/workflows') ? workflowsBody
        : u.includes('/api/connections') ? { connections: [] }
          : {};
    return { ok: true, status: 200, json: async () => body };
  }));
}

describe('Catalog chrome — UI-presence (rule 11)', () => {
  beforeEach(() => { setActivePinia(createPinia()); stubFetch(); });
  afterEach(() => vi.unstubAllGlobals());

  it('renders every persistent header element with its key text/state', async () => {
    const w = mount(WorkflowsView, { global: { stubs: { 'router-link': RouterLinkStub } } });
    await flushPromises();
    const tid = (id: string) => w.find(`[data-testid="${id}"]`);

    // Coverage number.
    expect(tid('coverage-indicator').exists()).toBe(true);
    expect(tid('coverage-indicator').text()).toContain('%');
    // Polling freshness pill — static label, not the live number.
    expect(tid('freshness-pill').exists()).toBe(true);
    expect(tid('freshness-pill').text()).toContain('Polling');
    // "synced N ago" indicator — static label only.
    expect(tid('synced-indicator').exists()).toBe(true);
    expect(tid('synced-indicator').text()).toContain('synced');
    // Refresh control.
    expect(tid('refresh-button').exists()).toBe(true);

    w.unmount();
  });

  it('renders every filter control', async () => {
    const w = mount(WorkflowsView, { global: { stubs: { 'router-link': RouterLinkStub } } });
    await flushPromises();
    const tid = (id: string) => w.find(`[data-testid="${id}"]`);

    for (const f of ['filter-search', 'filter-state', 'filter-mcp', 'filter-instance', 'filter-system', 'filter-trigger']) {
      expect(tid(f).exists(), `${f} should render`).toBe(true);
    }
    // The state control offers All / Active / Archived.
    expect(tid('filter-state').text()).toContain('Active');
    expect(tid('filter-state').text()).toContain('Archived');
    // The MCP control is labelled.
    expect(tid('filter-mcp').text()).toContain('MCP');

    w.unmount();
  });
});
