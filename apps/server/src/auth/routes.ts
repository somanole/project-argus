import { Router } from 'express';
import { loginRequestSchema, meResponseSchema, type MeResponse } from '@argus/shared';
import { SESSION_COOKIE, createSessionToken, readSessionToken, readCookie, safeEqual } from './session.js';

/**
 * Auth surface: log in with the admin password + an asserted identity, log out,
 * and ask who you are. These are the only /api routes (besides health) reachable
 * without a session.
 */
export function authRouter(config: { adminPassword: string; sessionSecret: string }): Router {
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
    const body: MeResponse = { authenticated: true, actor };
    res.json(meResponseSchema.parse(body));
  });

  router.post('/logout', (_req, res) => {
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
