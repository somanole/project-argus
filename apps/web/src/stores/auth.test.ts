import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from './auth';

const actor = { name: 'Sam Rivers', email: 'sam@acme.example' };
const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });

describe('auth store', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('ensureLoaded resolves the session once', async () => {
    const fetchMock = vi.fn(ok({ authenticated: true, actor }));
    vi.stubGlobal('fetch', fetchMock);
    const store = useAuthStore();
    await store.ensureLoaded();
    await store.ensureLoaded(); // cached — no second call
    expect(store.actor).toEqual(actor);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a failed /me as logged out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const store = useAuthStore();
    await store.ensureLoaded();
    expect(store.actor).toBeNull();
  });

  it('login stores the asserted actor; logout clears it', async () => {
    vi.stubGlobal('fetch', vi.fn(ok({ authenticated: true, actor })));
    const store = useAuthStore();
    await store.login({ password: 'pw', name: actor.name, email: actor.email });
    expect(store.actor).toEqual(actor);

    vi.stubGlobal('fetch', vi.fn(ok({ authenticated: false, actor: null })));
    await store.logout();
    expect(store.actor).toBeNull();
  });
});
