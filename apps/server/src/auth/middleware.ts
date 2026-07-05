import type { Request, Response, NextFunction } from 'express';
import type { SessionActor } from '@argus/shared';
import { SESSION_COOKIE, readSessionToken, readCookie } from './session.js';

/**
 * Gate for everything under /api except health and login. A request without a
 * valid session gets 401 — no partial access (PLAN.md: everything behind the
 * login). On success the asserted actor is stashed on res.locals for handlers
 * (and their audit entries).
 */
export function requireAuth(sessionSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const actor = token ? readSessionToken(token, sessionSecret) : null;
    if (!actor) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    res.locals.actor = actor;
    next();
  };
}

/** Typed accessor for the actor a passed `requireAuth` guarantees is present. */
export function actorOf(res: Response): SessionActor {
  return res.locals.actor as SessionActor;
}
