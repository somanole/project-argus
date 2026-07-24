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
  // S2 enrichment:
  /** Kill switch. false → a fully functional deterministic Argus, zero LLM calls. */
  enrichmentEnabled: boolean;
  /** Concurrent LLM calls per enrichment run. */
  enrichmentConcurrency: number;
  /** Per-run token budget; the run stops when reached, leaving the rest PENDING (0 = unlimited). */
  enrichmentSpendCapTokens: number;
  // S7 chat:
  /** Opt-in (default off): let chat egress owner/actor emails in tool results (DECISION #29). */
  chatEgressEmails: boolean;
  /** Public-demo mode — see `isDemoMode()`. */
  demoMode: boolean;
}

/**
 * Public-demo mode (`ARGUS_DEMO_MODE=true`).
 *
 * Argus stamps the asserted identity (name + email) of whoever signs in onto every
 * audit entry. On a PUBLIC demo that means one visitor's identity is visible to the
 * next one, so in demo mode the audit READ path redacts actor identities and refuses
 * to filter by actor (which would otherwise be a probe for who has visited).
 *
 * This is a read-side mask only: the audit log itself still records the real actor,
 * so the record stays complete and append-only for the operator (rule 6). Redaction
 * happens server-side, never in the browser — a public API that returned the real
 * values would leak them to anyone who called it directly.
 */
export function isDemoMode(): boolean {
  return (process.env.ARGUS_DEMO_MODE ?? 'false').toLowerCase() === 'true';
}

/**
 * The password to pre-fill on a public demo's login form, or null.
 *
 * Deliberately a SEPARATE variable from `ARGUS_ADMIN_PASSWORD`: demo mode is also a
 * reasonable setting for an internal shared instance (it hides audit identities), and
 * enabling it must never publish that instance's real admin password as a side
 * effect. Publishing a login is an explicit, separate decision.
 */
export function demoLoginPassword(): string | null {
  if (!isDemoMode()) return null;
  const pw = process.env.ARGUS_DEMO_PASSWORD;
  return pw && pw.length > 0 ? pw : null;
}

export function loadConfig(): ArgusConfig {
  return {
    dbPath: process.env.ARGUS_DB_PATH ?? join(REPO_ROOT, 'data', 'argus.sqlite'),
    adminPassword: process.env.ARGUS_ADMIN_PASSWORD ?? devDefault('ARGUS_ADMIN_PASSWORD', 'argus'),
    sessionSecret: process.env.ARGUS_SESSION_SECRET ?? devDefault('ARGUS_SESSION_SECRET', 'argus-dev-session-secret'),
    encryptionKey: process.env.ARGUS_ENCRYPTION_KEY ?? devDefault('ARGUS_ENCRYPTION_KEY', 'argus-dev-encryption-key'),
    pollIntervalMs: Number(process.env.ARGUS_POLL_INTERVAL_MS ?? 30_000),
    // Enabled by default, but a no-op until a provider + key are configured in Settings.
    enrichmentEnabled: (process.env.ENRICHMENT_ENABLED ?? 'true').toLowerCase() !== 'false',
    enrichmentConcurrency: Number(process.env.ARGUS_ENRICHMENT_CONCURRENCY ?? 3),
    enrichmentSpendCapTokens: Number(process.env.ARGUS_ENRICHMENT_SPEND_CAP_TOKENS ?? 5_000_000),
    // PII minimization by default (DECISION #29): emails leave only when explicitly opted in.
    chatEgressEmails: (process.env.ARGUS_CHAT_EGRESS_EMAILS ?? 'false').toLowerCase() === 'true',
    demoMode: isDemoMode(),
  };
}
