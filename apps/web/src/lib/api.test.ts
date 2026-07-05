import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from './api';

// Structural parser (same shape api() accepts) — avoids a direct zod dep here.
const numberParser = {
  parse(v: unknown): { n: number } {
    if (typeof (v as { n?: unknown }).n !== 'number') throw new Error('bad shape');
    return v as { n: number };
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('api()', () => {
  it('validates a success body against the given schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ n: 1 }) })));
    const out = await api('/x', {}, numberParser);
    expect(out).toEqual({ n: 1 });
  });

  it('surfaces the server\'s plain-English error on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad key' }) })));
    await expect(api('/x', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 400, message: 'bad key' });
  });

  it('reports an unreachable server as ApiError(0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await expect(api('/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('returns undefined for 204 No Content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204, json: async () => undefined })));
    expect(await api('/x', { method: 'DELETE' })).toBeUndefined();
  });
});
