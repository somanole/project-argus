import { describe, it, expect } from 'vitest';
import { redactText, redactDeep } from './redact.js';

describe('redactText — the free-text backstop (DECISION #26)', () => {
  it('scrubs common secret shapes', () => {
    const cases: Array<[string, string]> = [
      ['token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'jwt'],
      ['key AKIAIOSFODNN7EXAMPLE here', 'aws-access-key'],
      ['sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', 'openai-key'],
      ['postgres://admin:s3cr3tP4ss@db.internal:5432/prod', 'connection-string'],
      ['xoxb-123456789012-abcdefghijklmnop', 'slack-token'],
    ];
    for (const [input, kind] of cases) {
      const r = redactText(input);
      expect(r.count, `${kind}: ${input}`).toBeGreaterThanOrEqual(1);
      expect(r.kinds).toContain(kind);
      expect(r.text).toContain('[REDACTED:');
    }
  });

  it('redacts a standalone high-entropy blob', () => {
    const r = redactText('secret Zx9Kq2mVn7Pw4Lr8Ts5Yb1Hd3Fj6Gc0');
    expect(r.count).toBeGreaterThanOrEqual(1);
    expect(r.text).toContain('[REDACTED:');
  });

  it('leaves ordinary workflow text untouched', () => {
    for (const s of ['Send Slack Alert', 'Revenue Ops', 'Stripe Failed Payment Dunning', 'billing']) {
      const r = redactText(s);
      expect(r.count, s).toBe(0);
      expect(r.text).toBe(s);
    }
  });
});

describe('redactDeep', () => {
  it('walks nested strings and counts hits', () => {
    const { value, count } = redactDeep({
      name: 'Job sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
      tags: ['ok', 'AKIAIOSFODNN7EXAMPLE'],
      nested: { node: 'clean name' },
    });
    expect(count).toBe(2);
    expect(value.name).toContain('[REDACTED:openai-key]');
    expect(value.tags[1]).toContain('[REDACTED:aws-access-key]');
    expect(value.nested.node).toBe('clean name');
  });
});
