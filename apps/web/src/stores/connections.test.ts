import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useConnectionsStore } from './connections';

function conn(id: string, label: string) {
  return {
    id, label, baseUrl: 'http://localhost:5678', webhookHost: null,
    createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-05T00:00:00.000Z',
    health: { status: 'ok', lastSyncedAt: null, lastError: null, workflowCount: 3, analyzerDrift: null },
  };
}
const json = (status: number, body: unknown) => async () => ({ ok: status < 400, status, json: async () => body });

describe('connections store', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('refresh loads the registry with health', async () => {
    vi.stubGlobal('fetch', vi.fn(json(200, { connections: [conn('1', 'prod')] })));
    const store = useConnectionsStore();
    await store.refresh();
    expect(store.state).toBe('ok');
    expect(store.connections).toHaveLength(1);
    expect(store.connections[0]?.health.status).toBe('ok');
  });

  it('register posts then re-lists the registry', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ connection: conn('2', 'staging') }) };
      return { ok: true, status: 200, json: async () => ({ connections: [conn('1', 'prod'), conn('2', 'staging')] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = useConnectionsStore();
    await store.register({ label: 'staging', baseUrl: 'http://localhost:5679', apiKey: 'k', webhookHost: null });
    expect(store.connections.map((c) => c.label)).toEqual(['prod', 'staging']);
  });

  it('remove drops the connection locally', async () => {
    vi.stubGlobal('fetch', vi.fn(json(200, { connections: [conn('1', 'prod'), conn('2', 'staging')] })));
    const store = useConnectionsStore();
    await store.refresh();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204, json: async () => undefined })));
    await store.remove('1');
    expect(store.connections.map((c) => c.id)).toEqual(['2']);
  });
});
