import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { createSyncEngine } from './sync/engine.js';

const PORT = Number(process.env.ARGUS_PORT ?? process.env.PORT ?? 3000);
const HOST = process.env.ARGUS_HOST ?? '127.0.0.1';

const config = loadConfig();
const db = openDb(config.dbPath);
const engine = createSyncEngine(db, config.encryptionKey, config.pollIntervalMs);
const app = createApp({ db, engine, config });

const server = app.listen(PORT, HOST, () => {
  console.log(`[argus] server listening on http://${HOST}:${PORT} (health: /api/health)`);
  console.log(`[argus] db ${config.dbPath} · polling every ${Math.round(config.pollIntervalMs / 1000)}s`);
  // Begin the poll+reconcile loop (initial sync of every registered connection).
  engine.start();
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    engine.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
