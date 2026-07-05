import { defineStore } from 'pinia';
import { ref } from 'vue';
import { meResponseSchema, type SessionActor, type LoginRequest } from '@argus/shared';
import { api, ApiError } from '../lib/api';

/**
 * Holds who is logged in (the asserted identity). `ensureLoaded` resolves the
 * session once from the server so the router guard can decide before the first
 * navigation.
 */
export const useAuthStore = defineStore('auth', () => {
  const actor = ref<SessionActor | null>(null);
  const loaded = ref(false);

  async function ensureLoaded(): Promise<void> {
    if (loaded.value) return;
    try {
      const me = await api('/api/auth/me', {}, meResponseSchema);
      actor.value = me.actor;
    } catch {
      actor.value = null;
    } finally {
      loaded.value = true;
    }
  }

  /** Log in. Throws ApiError with a plain-English message on failure. */
  async function login(credentials: LoginRequest): Promise<void> {
    const me = await api('/api/auth/login', { method: 'POST', body: credentials }, meResponseSchema);
    actor.value = me.actor;
    loaded.value = true;
  }

  async function logout(): Promise<void> {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
    actor.value = null;
  }

  return { actor, loaded, ensureLoaded, login, logout };
});
