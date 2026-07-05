import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Central runtime config for the Argus server, read from the environment with
 * safe dev defaults. Secrets (admin password, session + encryption keys) SHOULD
 * be set in production; when they aren't, we fall back to a stable dev value and
 * warn loudly once — never silently (standing rule 5).
 *
 * README stance (PLAN.md security): Argus runs on a private network only, never
 * internet-exposed.
 */

// This file lives at apps/server/{src,dist}/config.* — three levels under the
// repo root in both dev (tsx) and built (node dist) layouts.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const warned = new Set<string>();
function devDefault(name: string, value: string): string {
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`[argus] ${name} not set — using an insecure dev default. Set it before any real use.`);
  }
  return value;
}

export interface ArgusConfig {
  dbPath: string;
  adminPassword: string;
  sessionSecret: string;
  encryptionKey: string;
  /** How often each connection is re-listed + reconciled (ms). */
  pollIntervalMs: number;
}

export function loadConfig(): ArgusConfig {
  return {
    dbPath: process.env.ARGUS_DB_PATH ?? join(REPO_ROOT, 'data', 'argus.sqlite'),
    adminPassword: process.env.ARGUS_ADMIN_PASSWORD ?? devDefault('ARGUS_ADMIN_PASSWORD', 'argus'),
    sessionSecret: process.env.ARGUS_SESSION_SECRET ?? devDefault('ARGUS_SESSION_SECRET', 'argus-dev-session-secret'),
    encryptionKey: process.env.ARGUS_ENCRYPTION_KEY ?? devDefault('ARGUS_ENCRYPTION_KEY', 'argus-dev-encryption-key'),
    pollIntervalMs: Number(process.env.ARGUS_POLL_INTERVAL_MS ?? 30_000),
  };
}
