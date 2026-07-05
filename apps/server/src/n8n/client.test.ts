import { describe, it, expect, vi, afterEach } from 'vitest';
import { createN8nClient, reason, statusForError, HttpError } from './client.js';

const OPTS = { baseUrl: 'http://n8n.local', apiKey: 'k' };

function validWf(id: string, name: string) {
  return {
    id, name, active: true, isArchived: false,
    createdAt: '2026-07-04T00:00:00.000Z', updatedAt: '2026-07-04T00:00:00.000Z',
    versionId: 'v1', shared: [{ role: 'workflow:owner', projectId: 'p1' }],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('n8n client — testConnection classifies reachability honestly', () => {
  it('200 → ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ data: [] }) })));
    expect(await createN8nClient(OPTS).testConnection()).toEqual({ status: 'ok', error: null });
  });

  it('401/403 → unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401, json: async () => ({}) })));
    expect((await createN8nClient(OPTS).testConnection()).status).toBe('unauthorized');
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 403, json: async () => ({}) })));
    expect((await createN8nClient(OPTS).testConnection()).status).toBe('unauthorized');
  });

  it('other status → unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 500, json: async () => ({}) })));
    expect((await createN8nClient(OPTS).testConnection()).status).toBe('unreachable');
  });

  it('network error → unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const r = await createN8nClient(OPTS).testConnection();
    expect(r.status).toBe('unreachable');
    expect(r.error).toContain('ECONNREFUSED');
  });
});

describe('n8n client — listWorkflows', () => {
  it('walks every page and skips items that fail the contract (rule 5)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('cursor=')) {
        return { status: 200, json: async () => ({ data: [validWf('w3', 'Gamma')], nextCursor: null }) };
      }
      return {
        status: 200,
        json: async () => ({ data: [validWf('w1', 'Alpha'), { id: 'bad' }, validWf('w2', 'Beta')], nextCursor: 'c1' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const workflows = await createN8nClient(OPTS).listWorkflows();
    expect(workflows.map((w) => w.id)).toEqual(['w1', 'w2', 'w3']); // 'bad' skipped, 2 pages walked
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on a non-200 page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 500, json: async () => ({}) })));
    await expect(createN8nClient(OPTS).listWorkflows()).rejects.toBeInstanceOf(HttpError);
  });

  it('sends the API key header', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => ({ data: [], nextCursor: null }) }));
    vi.stubGlobal('fetch', fetchMock);
    await createN8nClient(OPTS).listWorkflows();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-N8N-API-KEY']).toBe('k');
  });
});

describe('error helpers', () => {
  it('reason() maps HTTP + abort + generic', () => {
    expect(reason(new HttpError(401))).toContain('key');
    expect(reason(new HttpError(500))).toContain('500');
    const abort = new Error('aborted'); abort.name = 'AbortError';
    expect(reason(abort)).toContain('did not respond');
    expect(reason(new Error('boom'))).toBe('boom');
  });

  it('statusForError() is unauthorized only for 401/403', () => {
    expect(statusForError(new HttpError(401))).toBe('unauthorized');
    expect(statusForError(new HttpError(403))).toBe('unauthorized');
    expect(statusForError(new HttpError(500))).toBe('unreachable');
    expect(statusForError(new Error('x'))).toBe('unreachable');
  });
});
