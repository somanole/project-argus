import { z } from 'zod';

/**
 * The contract for `GET /api/health`, shared between server and web so both
 * sides agree on the shape. M0 placeholder — no product data yet; this exists
 * to prove the server → shared-types → web loop runs end to end.
 */
export const healthResponseSchema = z.object({
  /** Overall service status. `ok` only when every dependency below is healthy. */
  status: z.enum(['ok', 'degraded']),
  /** Constant service identifier, so a misrouted call is obvious. */
  service: z.literal('argus-server'),
  /** Server package version. */
  version: z.string(),
  /**
   * SQLite (better-sqlite3) reachability. Proves the native DB binding loads
   * and answers a query — the M0 "dev environment runs end to end" check.
   * `unavailable` is honest degradation, never a guess (standing rule 5).
   */
  db: z.enum(['ok', 'unavailable']),
  /** ISO-8601 server time at the moment the response was built. */
  time: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
