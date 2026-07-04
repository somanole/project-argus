import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.js';

describe('healthResponseSchema', () => {
  it('accepts a well-formed healthy payload', () => {
    const parsed = healthResponseSchema.parse({
      status: 'ok',
      service: 'argus-server',
      version: '0.0.0',
      db: 'ok',
      time: new Date().toISOString(),
    });
    expect(parsed.status).toBe('ok');
  });

  it('rejects an unknown service identifier (guards against a misrouted call)', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'not-argus',
      version: '0.0.0',
      db: 'ok',
      time: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO time string', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'argus-server',
      version: '0.0.0',
      db: 'ok',
      time: 'yesterday',
    });
    expect(result.success).toBe(false);
  });
});
