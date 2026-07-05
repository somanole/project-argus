import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  connectionsResponseSchema,
  connectionResponseSchema,
  type Connection,
  type ConnectionInput,
} from '@argus/shared';
import { api } from '../lib/api';

/**
 * The connections registry, client side. Holds the list (with live health) and
 * the register/remove actions. Never sees an API key after it is submitted.
 */
export const useConnectionsStore = defineStore('connections', () => {
  const connections = ref<Connection[]>([]);
  const state = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const error = ref<string | null>(null);

  async function refresh(): Promise<void> {
    if (state.value === 'idle') state.value = 'loading';
    try {
      const res = await api('/api/connections', {}, connectionsResponseSchema);
      connections.value = res.connections;
      state.value = 'ok';
      error.value = null;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not load connections';
    }
  }

  /** Register a connection. Throws ApiError (plain-English) on failure. */
  async function register(input: ConnectionInput): Promise<void> {
    const res = await api('/api/connections', { method: 'POST', body: input }, connectionResponseSchema);
    // Optimistically show it immediately; a refresh will reconcile.
    connections.value = [...connections.value.filter((c) => c.id !== res.connection.id), res.connection];
    await refresh();
  }

  async function remove(id: string): Promise<void> {
    await api(`/api/connections/${id}`, { method: 'DELETE' });
    connections.value = connections.value.filter((c) => c.id !== id);
  }

  return { connections, state, error, refresh, register, remove };
});
