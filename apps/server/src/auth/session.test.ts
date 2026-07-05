import { describe, it, expect } from 'vitest';
import { createSessionToken, readSessionToken, readCookie, SESSION_COOKIE } from './session.js';

const actor = { name: 'Sam Rivers', email: 'sam@acme.example' };

describe('signed session tokens', () => {
  it('round-trips the asserted actor', () => {
    const token = createSessionToken(actor, 'secret');
    expect(readSessionToken(token, 'secret')).toEqual(actor);
  });

  it('rejects a token signed with a different secret', () => {
    const token = createSessionToken(actor, 'secret');
    expect(readSessionToken(token, 'other-secret')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = createSessionToken(actor, 'secret');
    const tampered = Buffer.from(JSON.stringify({ name: 'Mallory', email: 'm@x.example' })).toString('base64url') + token.slice(token.indexOf('.'));
    expect(readSessionToken(tampered, 'secret')).toBeNull();
  });

  it('reads a named cookie from a header', () => {
    expect(readCookie(`other=1; ${SESSION_COOKIE}=abc; x=2`, SESSION_COOKIE)).toBe('abc');
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
  });
});
