import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useWorkflowsStore } from './workflows';

function item(id: string, instanceId: string, instanceLabel: string) {
  return {
    instanceId,
    instanceLabel,
    id,
    name: `wf-${id}`,
    active: true,
    isArchived: false,
    project: 'Revenue Ops',
    updatedAt: '2026-07-04T00:00:00.000Z',
    systems: [] as string[],
    triggers: [] as string[],
    mcpExposed: false,
    nodeCount: 2,
    understood: true,
    brokenRefCount: 0,
    enrichment: null,
    health: null,
    owner: null,
  };
}

function okResponse(workflows: ReturnType<typeof item>[], total = workflows.length) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      workflows,
      facets: { systems: [{ value: 'Salesforce', count: 2 }], triggers: [], instances: [{ id: 'a', label: 'prod', count: 2 }] },
      total,
      limit: 50,
      offset: 0,
      generatedAt: '2026-07-05T00:00:00.000Z',
    }),
  };
}

describe('workflows store (server-side filtering)', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('loads the estate + facets and renders exactly what the server returns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([item('1', 'a', 'prod'), item('2', 'a', 'prod'), item('3', 'b', 'staging')])));
    const store = useWorkflowsStore();
    await store.refresh();

    expect(store.state).toBe('ok');
    expect(store.workflows).toHaveLength(3);
    expect(store.facets.systems[0]).toEqual({ value: 'Salesforce', count: 2 });
  });

  it('builds server query params from the filter state (a filter, not a partition)', async () => {
    const fetchMock = vi.fn(async (_url: string) => okResponse([item('1', 'a', 'prod')]));
    vi.stubGlobal('fetch', fetchMock);
    const store = useWorkflowsStore();

    store.setInstance('a');
    store.toggleSystem('Salesforce');
    store.setMcpOnly(true);
    store.setStateFilter('archived');
    // Wait a tick so the async refreshes settle.
    await Promise.resolve();

    const lastUrl = String(fetchMock.mock.calls.at(-1)?.[0] ?? '');
    expect(lastUrl).toContain('instanceId=a');
    expect(lastUrl).toContain('system=Salesforce');
    expect(lastUrl).toContain('mcp=true');
    expect(lastUrl).toContain('archived=true');
    expect(store.activeFilterCount).toBe(4);
  });

  it('applies deep-link filters from a URL query (Overview tiles land on their set)', async () => {
    const fetchMock = vi.fn(async (_url: string) => okResponse([item('1', 'a', 'prod')]));
    vi.stubGlobal('fetch', fetchMock);
    const store = useWorkflowsStore();

    // e.g. the "Idle but active" tile → /estate?health=idle&active=true.
    store.applyFromQuery({ health: 'idle', active: 'true' });
    await store.refresh();
    let lastUrl = String(fetchMock.mock.calls.at(-1)?.[0] ?? '');
    expect(lastUrl).toContain('health=idle');
    expect(lastUrl).toContain('active=true');

    // A second deep-link is AUTHORITATIVE — it clears the previous link's filters instead
    // of accumulating (the bug: idle+active+broken+stale stacking to zero matches). No
    // manual clearFilters() in between.
    store.applyFromQuery({ stale: 'true' });
    await store.refresh();
    lastUrl = String(fetchMock.mock.calls.at(-1)?.[0] ?? '');
    expect(lastUrl).toContain('stale=true');
    expect(lastUrl).not.toContain('health=idle'); // previous filter gone
    expect(lastUrl).not.toContain('active=true');
    expect(store.staleOnly).toBe(true);
    expect(store.health).toEqual([]);
    expect(store.stateFilter).toBe('all');
    expect(store.activeFilterCount).toBe(1); // exactly the one deep-linked filter
  });

  it('paginates server-side: sends limit/offset, exposes total, and resets to page 1 on a filter change', async () => {
    const fetchMock = vi.fn(async (_url: string) => okResponse([item('1', 'a', 'prod')], 320));
    vi.stubGlobal('fetch', fetchMock);
    const store = useWorkflowsStore();
    await store.refresh();

    let lastUrl = String(fetchMock.mock.calls.at(-1)?.[0] ?? '');
    expect(lastUrl).toContain('limit=50');
    expect(lastUrl).toContain('offset=0');
    expect(store.total).toBe(320); // full match count, not the page length

    // Page forward → offset advances, page kept.
    store.goToPage(2);
    await Promise.resolve();
    lastUrl = String(fetchMock.mock.calls.at(-1)?.[0] ?? '');
    expect(lastUrl).toContain('offset=100'); // page 2 (0-based) * 50
    expect(store.page).toBe(2);

    // Any filter change resets to page 1 (a new filter set has its own pages).
    store.setMcpOnly(true);
    await Promise.resolve();
    lastUrl = String(fetchMock.mock.calls.at(-1)?.[0] ?? '');
    expect(lastUrl).toContain('offset=0');
    expect(store.page).toBe(0);
  });

  it('reports an honest error when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('down');
    }));
    const store = useWorkflowsStore();
    await store.refresh();
    expect(store.state).toBe('error');
    expect(store.error).toBeTruthy();
  });
});
