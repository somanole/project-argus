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
});
export type MeResponse = z.infer<typeof meResponseSchema>;
