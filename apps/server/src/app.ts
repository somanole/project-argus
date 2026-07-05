import express, { type Express } from 'express';
import { healthResponseSchema, type HealthResponse } from '@argus/shared';
import { probeDb } from './db.js';

export const SERVER_VERSION = '0.0.0';

/**
 * Builds the Argus Express app. Split from the listen() call in index.ts so
 * tests can exercise routes without binding a port.
 *
 * Surface today: `GET /api/health`. Connections, auth, sync, and chat arrive in
 * later slices (the connections registry is S1a).
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    const db = probeDb();
    const body: HealthResponse = {
      status: db === 'ok' ? 'ok' : 'degraded',
      service: 'argus-server',
      version: SERVER_VERSION,
      db,
      time: new Date().toISOString(),
    };
    // Validate our own output against the shared contract before sending, so a
    // drift between server and web fails loudly here rather than in the browser.
    res.json(healthResponseSchema.parse(body));
  });

  return app;
}
