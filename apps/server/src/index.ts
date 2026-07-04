import { createApp } from './app.js';

const PORT = Number(process.env.ARGUS_PORT ?? process.env.PORT ?? 3000);
const HOST = process.env.ARGUS_HOST ?? '127.0.0.1';

const app = createApp();
app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[argus] server listening on http://${HOST}:${PORT} (health: /api/health)`);
});
