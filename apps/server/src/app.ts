import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { healthResponseSchema, type HealthResponse } from '@argus/shared';
import { probeDb } from './db/index.js';
import { authRouter } from './auth/routes.js';
import { requireAuth } from './auth/middleware.js';
import { connectionsRouter } from './routes/connections.js';
import { workflowsRouter } from './routes/workflows.js';
import { ownershipRouter } from './routes/ownership.js';
import { settingsRouter } from './routes/settings.js';
import { graphRouter } from './routes/graph.js';
import { governanceRouter } from './routes/governance.js';
import { chatRouter } from './routes/chat.js';
import { createChatSessionStore } from './chat/session.js';
import type { SyncEngine } from './sync/engine.js';
import type { EnrichmentWorker } from './enrichment/index.js';

export const SERVER_VERSION = '0.1.0';

export interface AppDeps {
  db: Database.Database;
  engine: SyncEngine;
  worker: EnrichmentWorker;
  config: { adminPassword: string; sessionSecret: string; encryptionKey: string; enrichmentEnabled: boolean; chatEgressEmails: boolean };
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

  // Public: login / logout / me. (db so login/logout write to the sacred audit_log.)
  app.use('/api/auth', authRouter(config, db));

  // Everything else is behind the session guard.
  const guard = requireAuth(config.sessionSecret);
  app.use('/api/connections', guard, connectionsRouter(db, engine, config.encryptionKey));
  app.use('/api/workflows', guard, workflowsRouter(db, worker, config.encryptionKey));
  app.use('/api/ownership', guard, ownershipRouter(db, config.encryptionKey));
  app.use('/api/settings', guard, settingsRouter(db, config.encryptionKey, config.enrichmentEnabled, worker));
  app.use('/api/graph', guard, graphRouter(db));
  app.use('/api/governance', guard, governanceRouter(db));
  // Chat history lives here, per process — in-memory, not persisted (Finding 1).
  const chatSessions = createChatSessionStore();
  app.use('/api/chat', guard, chatRouter(db, config.encryptionKey, config.chatEgressEmails, chatSessions, config.enrichmentEnabled));

  // Optional single-origin serving: also serve the built web UI so the whole app
  // is ONE port to expose (e.g. behind a Tailscale Funnel for a public demo). Off
  // by default — in dev the Vite server serves the web and proxies /api here, and
  // tests never set this. Turn on with ARGUS_SERVE_WEB=true after `pnpm build`.
  if ((process.env.ARGUS_SERVE_WEB ?? '').toLowerCase() === 'true') {
    const webDist = process.env.ARGUS_WEB_DIST
      ? resolve(process.env.ARGUS_WEB_DIST)
      // apps/server/{src,dist}/app.* → ../../web/dist in both tsx and built layouts.
      : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
    const indexHtml = join(webDist, 'index.html');
    if (existsSync(indexHtml)) {
      app.use(express.static(webDist));
      // SPA history-mode fallback: any non-/api GET returns index.html so deep
      // links (/estate, /health, …) resolve to the client router, not a 404.
      app.get(/^(?!\/api\/).+/, (_req, res) => res.sendFile(indexHtml));
      console.log(`[argus] serving web UI from ${webDist} (single-origin mode)`);
    } else {
      console.warn(`[argus] ARGUS_SERVE_WEB=true but no build at ${indexHtml} — run 'pnpm build' first. Serving API only.`);
    }
  }

  return app;
}
