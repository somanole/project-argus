import { z } from 'zod';

/**
 * Argus login contract. MVP = admin password + **asserted** identity (name +
 * email), stamped on the session and every audit entry (PLAN.md — identity,
 * honestly). Self-asserted by design; OIDC is a later track.
 */
export const loginRequestSchema = z.object({
  password: z.string().min(1, 'password is required'),
  name: z.string().trim().min(1, 'your name is required'),
  email: z.string().trim().email('a valid email is required'),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** The identity carried on a session and stamped onto audit entries. */
export const sessionActorSchema = z.object({
  name: z.string(),
  email: z.string().email(),
});
export type SessionActor = z.infer<typeof sessionActorSchema>;

/** GET /api/auth/me — who, if anyone, is logged in. */
export const meResponseSchema = z.object({
  authenticated: z.boolean(),
  actor: sessionActorSchema.nullable(),
  /**
   * Public-demo mode (ARGUS_DEMO_MODE). The server already refuses every mutating
   * request; this tells the UI so it can render write controls **visible but
   * disabled** rather than letting them fail with a 403 on click. Defaults false so
   * an older server response still parses.
   */
  demoMode: z.boolean().default(false),
  /**
   * The credential to pre-fill on the login form of a public demo, so a visitor can
   * sign in without being handed a password out of band. Server-supplied and only
   * ever non-null when demo mode is on AND the operator explicitly set
   * `ARGUS_DEMO_PASSWORD` — publishing a login is a deliberate act, never a
   * side effect of enabling demo mode. Never hardcoded in the web app.
   */
  demoPassword: z.string().nullable().default(null),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
