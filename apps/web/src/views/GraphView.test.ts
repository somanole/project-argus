import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, RouterLinkStub } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import GraphView from './GraphView.vue';
import { useGraphStore } from '../stores/graph';

/**
 * Rule-11 UI-presence checks for the S5 graph chrome: the scope switcher, the
 * archived + MCP toggles, the legend, and the blast-radius impact panel with its
 * EXPLICIT total. Asserts presence/state, not appearance. The vue-flow canvas
 * (DependencyGraph) is stubbed — it needs a real DOM; these tests guard the chrome.
 */
const graphBody = {
  scope: 'estate', focus: null, hops: null, nodes: [], edges: [], truncated: false, nodeTotal: 0,
  generatedAt: '2026-07-07T00:00:00.000Z',
};

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.includes('/api/graph') ? graphBody
      : u.includes('/api/connections') ? { connections: [{ id: 'a', label: 'prod' }] }
        : u.includes('/api/workflows') ? { facets: { systems: [{ value: 'Salesforce' }] } }
          : {};
    return { ok: true, status: 200, json: async () => body };
  }));
}

const mountView = () => mount(GraphView, {
  global: { stubs: { DependencyGraph: true, RouterLink: RouterLinkStub } },
});

const tid = (w: ReturnType<typeof mountView>, id: string) => w.find(`[data-testid="${id}"]`);

describe('Graph view chrome — UI-presence (rule 11)', () => {
  beforeEach(() => { setActivePinia(createPinia()); stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the scope switcher with estate / instance / system', async () => {
    const w = mountView();
    await flushPromises();
    expect(tid(w, 'graph-scope-switcher').exists()).toBe(true);
    for (const s of ['estate', 'instance', 'system']) {
      expect(tid(w, `graph-scope-${s}`).exists()).toBe(true);
    }
    // Neighborhood was removed from the UI.
    expect(tid(w, 'graph-scope-neighborhood').exists()).toBe(false);
  });

  it('renders the archived toggle and the legend (the MCP-exposure toggle was removed)', async () => {
    const w = mountView();
    await flushPromises();
    expect(tid(w, 'graph-archived-toggle').exists()).toBe(true);
    expect(tid(w, 'graph-mcp-toggle').exists()).toBe(false);
    expect(tid(w, 'graph-legend').text().toLowerCase()).toContain('possible');
    expect(tid(w, 'graph-legend').text().toLowerCase()).toContain('cross-instance');
  });

  it('the impact panel shows the blast-radius answer with an EXPLICIT total', async () => {
    const w = mountView();
    await flushPromises();
    const store = useGraphStore();
    store.selectedNode = {
      id: 'wf:a:slack', kind: 'workflow', instanceId: 'a', instanceLabel: 'prod', label: 'Send Slack Alert',
      resourceId: 'slack', workflowId: 'slack', health: 'idle', active: true, archived: false, isAgent: false, brokenRef: false, mcpExposed: false,
    };
    store.impact = {
      mode: 'failure', focusKind: 'workflow', focusInstanceId: 'a', focusId: 'slack', focusLabel: 'Send Slack Alert',
      edgeTypesTraversed: ['call'],
      affected: [{ instanceId: 'a', instanceLabel: 'prod', workflowId: 'c1', name: 'Caller One', hops: 1 }],
      total: 5, possibleExcluded: 1, statement: '5 affected, nothing else.', generatedAt: '2026-07-07T00:00:00.000Z',
    };
    store.impactState = 'ok';
    await nextTick();
    expect(tid(w, 'graph-impact-panel').exists()).toBe(true);
    expect(tid(w, 'graph-impact-total').text()).toBe('5');
    expect(tid(w, 'graph-impact-statement').text()).toContain('If this fails');
  });

  it('the panel has an Unselect control that clears the selection', async () => {
    const w = mountView();
    await flushPromises();
    const store = useGraphStore();
    store.selectedNode = {
      id: 'wf:a:slack', kind: 'workflow', instanceId: 'a', instanceLabel: 'prod', label: 'Send Slack Alert',
      resourceId: 'slack', workflowId: 'slack', health: 'idle', active: true, archived: false, isAgent: false, brokenRef: false, mcpExposed: false,
    };
    await nextTick();
    const clear = tid(w, 'graph-panel-clear');
    expect(clear.exists()).toBe(true);
    await clear.trigger('click');
    expect(store.selectedNode).toBeNull();
  });

  it('the selected workflow and each blast-radius workflow are clickable into the detail drawer', async () => {
    const w = mountView();
    await flushPromises();
    const store = useGraphStore();
    store.selectedNode = {
      id: 'wf:a:slack', kind: 'workflow', instanceId: 'a', instanceLabel: 'prod', label: 'Send Slack Alert',
      resourceId: 'slack', workflowId: 'slack', health: 'idle', active: true, archived: false, isAgent: false, brokenRef: false, mcpExposed: false,
    };
    store.impact = {
      mode: 'failure', focusKind: 'workflow', focusInstanceId: 'a', focusId: 'slack', focusLabel: 'Send Slack Alert',
      edgeTypesTraversed: ['call'],
      affected: [{ instanceId: 'a', instanceLabel: 'prod', workflowId: 'c1', name: 'Caller One', hops: 1 }],
      total: 1, possibleExcluded: 0, statement: '1 affected, nothing else.', generatedAt: '2026-07-07T00:00:00.000Z',
    };
    store.impactState = 'ok';
    await nextTick();
    // The selected workflow's name is a button that opens its details.
    const title = tid(w, 'graph-panel-open-detail');
    expect(title.exists()).toBe(true);
    expect(title.element.tagName).toBe('BUTTON');
    // Every workflow in the blast radius is a clickable row.
    const list = tid(w, 'graph-affected-list');
    expect(list.exists()).toBe(true);
    const rows = list.findAll('button.affected-item');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain('Caller One');
  });
});
