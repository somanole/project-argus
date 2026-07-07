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

function okResponse(workflows: ReturnType<typeof item>[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      workflows,
      facets: { systems: [{ value: 'Salesforce', count: 2 }], triggers: [], instances: [{ id: 'a', label: 'prod', count: 2 }] },
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
