import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { sessionActorSchema, type SessionActor } from '@argus/shared';

/**
 * Stateless signed session tokens. A token is `payload.signature` where payload
 * is base64url JSON of the asserted actor and signature is an HMAC-SHA256 over
 * it (keyed by the session secret). No server-side session store — verifying a
 * token only needs the secret. The token carries a self-asserted identity, not a
 * verified one (PLAN.md — identity, honestly).
 */
export const SESSION_COOKIE = 'argus_session';

function hmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** Constant-time string compare (equal-length-safe via digesting first). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

export function createSessionToken(actor: SessionActor, secret: string): string {
  const body = Buffer.from(JSON.stringify({ name: actor.name, email: actor.email })).toString('base64url');
  return `${body}.${hmac(body, secret)}`;
}

/** Returns the actor if the token is well-formed and correctly signed, else null. */
export function readSessionToken(token: string, secret: string): SessionActor | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, hmac(body, secret))) return null;
  try {
    const parsed = sessionActorSchema.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Read one cookie value from a raw Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
