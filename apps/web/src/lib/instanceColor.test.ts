import { describe, it, expect } from 'vitest';
import { instanceColor, assignInstanceColors } from './instanceColor';

describe('instanceColor', () => {
  it('is stable for the same id', () => {
    expect(instanceColor('abc')).toBe(instanceColor('abc'));
  });

  it('always resolves to a vendored token (never a hard-coded color)', () => {
    for (const id of ['a', 'prod', 'staging', 'x9f2', '']) {
      expect(instanceColor(id)).toMatch(/^var\(--color--[a-z]+-\d+\)$/);
    }
  });

  it('gives assigned instances DISTINCT colors (prod ≠ staging) even when their hashes would collide', () => {
    assignInstanceColors(['conn-prod', 'conn-staging']);
    expect(instanceColor('conn-prod')).not.toBe(instanceColor('conn-staging'));
    // still a vendored token, still stable
    expect(instanceColor('conn-prod')).toMatch(/^var\(--color--[a-z]+-\d+\)$/);
    expect(instanceColor('conn-prod')).toBe(instanceColor('conn-prod'));
  });

  it('assignment is deterministic regardless of caller order', () => {
    assignInstanceColors(['b-id', 'a-id']);
    const first = instanceColor('a-id');
    assignInstanceColors(['a-id', 'b-id']);
    expect(instanceColor('a-id')).toBe(first);
  });
});
