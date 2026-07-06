import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { healthResponseSchema, type HealthResponse } from '@argus/shared';
import { probeDb } from './db/index.js';
import { authRouter } from './auth/routes.js';
import { requireAuth } from './auth/middleware.js';
import { connectionsRouter } from './routes/connections.js';
import { workflowsRouter } from './routes/workflows.js';
import { settingsRouter } from './routes/settings.js';
import type { SyncEngine } from './sync/engine.js';
import type { EnrichmentWorker } from './enrichment/index.js';

export const SERVER_VERSION = '0.1.0';

export interface AppDeps {
  db: Database.Database;
  engine: SyncEngine;
  worker: EnrichmentWorker;
  config: { adminPassword: string; sessionSecret: string; encryptionKey: string; enrichmentEnabled: boolean };
}

/**
 * Builds the Argus Express app. Split from listen() so tests can exercise routes
 * without binding a port.
 *
 * Everything under /api requires a session EXCEPT `/api/health` and the
 * `/api/auth/*` login surface (PLAN.md — everything behind the login).
 */
export function createApp(deps: AppDeps): Express {
  const { db, engine, worker, config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Public: liveness. Reflects the real database now.
  app.get('/api/health', (_req, res) => {
    const dbStatus = probeDb(db);
    const body: HealthResponse = {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      service: 'argus-server',
      version: SERVER_VERSION,
      db: dbStatus,
      time: new Date().toISOString(),
    };
    res.json(healthResponseSchema.parse(body));
  });

  // Public: login / logout / me.
  app.use('/api/auth', authRouter(config));

  // Everything else is behind the session guard.
  const guard = requireAuth(config.sessionSecret);
  app.use('/api/connections', guard, connectionsRouter(db, engine, config.encryptionKey));
  app.use('/api/workflows', guard, workflowsRouter(db, worker, config.encryptionKey));
  app.use('/api/settings', guard, settingsRouter(db, config.encryptionKey, config.enrichmentEnabled, worker));

  return app;
}
