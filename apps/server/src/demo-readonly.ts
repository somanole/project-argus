import type { RequestHandler } from 'express';

/**
 * Read-only enforcement for a shared/public demo (`ARGUS_DEMO_MODE=true`).
 *
 * A demo link hands a working session to strangers. Without this, any visitor could
 * delete a connection (wiping the estate), reassign owners, rewrite the LLM settings,
 * or kick off a full re-enrichment run that spends the operator's API credits.
 *
 * This is a WHITELIST, deliberately: safe methods and a short list of read-only POSTs
 * are allowed and *everything else is refused*. A mutating route added later is
 * therefore blocked by default rather than relying on someone remembering to list it.
 *
 * Not included in the block list — and intentionally so:
 *   • `POST /auth/login|logout` — you must be able to sign in to see the demo at all.
 *   • `POST /chat` — chat only reads (its tools are read-only) and it is the feature
 *     most worth demonstrating. It does spend LLM credits per message; set
 *     `ENRICHMENT_ENABLED=false` to switch all LLM features off if that is abused.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Read-only POSTs, matched against the path *within* the mount point (e.g. `/chat`). */
const ALLOWED_POSTS: RegExp[] = [/^\/auth\/login\/?$/, /^\/auth\/logout\/?$/, /^\/chat\/?$/];

export const DEMO_READONLY_MESSAGE =
  'Argus is running in read-only demo mode — this change is disabled. Run your own instance to try it for real.';

export function demoReadOnly(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.method === 'POST' && ALLOWED_POSTS.some((re) => re.test(req.path))) return next();
    res.status(403).json({ error: DEMO_READONLY_MESSAGE });
  };
}
