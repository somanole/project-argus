import { Router } from 'express';
import type Database from 'better-sqlite3';
import { loginRequestSchema, meResponseSchema, type MeResponse } from '@argus/shared';
import { appendAudit } from '../db/audit.js';
import { SESSION_COOKIE, createSessionToken, readSessionToken, readCookie, safeEqual } from './session.js';

/**
 * Auth surface: log in with the admin password + an asserted identity, log out,
 * and ask who you are. These are the only /api routes (besides health) reachable
 * without a session.
 *
 * Each successful login and each logout is written to the sacred append-only
 * `audit_log` (actions `auth.login` / `auth.logout`), so who came and went shows in
 * the same self-audit timeline as every other governance action. A rejected login
 * (wrong password) is never audited — there is no authenticated actor to attribute.
 */
export function authRouter(config: { adminPassword: string; sessionSecret: string }, db: Database.Database): Router {
  const router = Router();
  const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 } as const;

  router.post('/login', (req, res) => {
    const parsed = loginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const { password, name, email } = parsed.data;
    if (!safeEqual(password, config.adminPassword)) {
      // Never reveal whether the password or something else was wrong.
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }
    const actor = { name, email };
    res.cookie(SESSION_COOKIE, createSessionToken(actor, config.sessionSecret), COOKIE_OPTS);
    appendAudit(db, actor, { action: 'auth.login', entityType: 'session', entityId: null });
    const body: MeResponse = { authenticated: true, actor };
    res.json(meResponseSchema.parse(body));
  });

  router.post('/logout', (req, res) => {
    // Attribute the logout to whoever the (still-valid) session belonged to. If there
    // is no valid session, there is no actor to audit — just clear and return.
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const actor = token ? readSessionToken(token, config.sessionSecret) : null;
    if (actor) appendAudit(db, actor, { action: 'auth.logout', entityType: 'session', entityId: null });
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json(meResponseSchema.parse({ authenticated: false, actor: null }));
  });

  router.get('/me', (req, res) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const actor = token ? readSessionToken(token, config.sessionSecret) : null;
    const body: MeResponse = actor ? { authenticated: true, actor } : { authenticated: false, actor: null };
    res.json(meResponseSchema.parse(body));
  });

  return router;
}
