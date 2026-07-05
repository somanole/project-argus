import { Router } from 'express';
import type Database from 'better-sqlite3';
import {
  connectionInputSchema,
  connectionsResponseSchema,
  connectionResponseSchema,
  type Connection,
} from '@argus/shared';
import { actorOf } from '../auth/middleware.js';
import {
  listConnectionRows,
  getConnectionRow,
  createConnection,
  deleteConnection,
  toSafe,
  type ConnectionRow,
} from '../connections/repo.js';
import type { SyncEngine } from '../sync/engine.js';
import { createN8nClient } from '../n8n/client.js';

/**
 * The connections registry API. Registering validates the key against the live
 * instance before storing anything (rule 1: talk to real n8n), stores the key
 * encrypted, and audits the change. No route ever returns the API key.
 */
export function connectionsRouter(db: Database.Database, engine: SyncEngine, encryptionKey: string): Router {
  const router = Router();

  const present = (row: ConnectionRow): Connection => ({ ...toSafe(row), health: engine.health(row.id) });

  router.get('/', (_req, res) => {
    const connections = listConnectionRows(db).map(present);
    res.json(connectionsResponseSchema.parse({ connections }));
  });

  router.post('/', async (req, res) => {
    const parsed = connectionInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const input = parsed.data;
    // Validate the key against the real instance before we store anything.
    const probe = await createN8nClient({ baseUrl: input.baseUrl, apiKey: input.apiKey }).testConnection();
    if (probe.status !== 'ok') {
      res.status(400).json({ error: probe.error ?? 'could not connect to n8n with that key' });
      return;
    }
    const row = createConnection(db, actorOf(res), input, encryptionKey);
    await engine.syncNow(row.id);
    res.status(201).json(connectionResponseSchema.parse({ connection: present(getConnectionRow(db, row.id) ?? row) }));
  });

  router.post('/:id/sync', async (req, res) => {
    const row = getConnectionRow(db, req.params.id ?? '');
    if (!row) {
      res.status(404).json({ error: 'connection not found' });
      return;
    }
    await engine.syncNow(row.id);
    res.json(connectionResponseSchema.parse({ connection: present(row) }));
  });

  router.delete('/:id', (req, res) => {
    const removed = deleteConnection(db, actorOf(res), req.params.id ?? '');
    if (!removed) {
      res.status(404).json({ error: 'connection not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
