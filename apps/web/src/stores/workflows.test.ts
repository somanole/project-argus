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
  };
}

describe('workflows store', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('loads the estate and filters by instance (a filter, not a partition)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          workflows: [item('1', 'a', 'prod'), item('2', 'a', 'prod'), item('3', 'b', 'staging')],
          generatedAt: '2026-07-05T00:00:00.000Z',
        }),
      })),
    );
    const store = useWorkflowsStore();
    await store.refresh();

    expect(store.state).toBe('ok');
    expect(store.filtered).toHaveLength(3); // 'all' = whole estate
    store.setFilter('a');
    expect(store.filtered.map((w) => w.id)).toEqual(['1', '2']);
    store.setFilter('b');
    expect(store.filtered.map((w) => w.id)).toEqual(['3']);
  });

  it('reports an honest error when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const store = useWorkflowsStore();
    await store.refresh();
    expect(store.state).toBe('error');
    expect(store.error).toBeTruthy();
  });
});
