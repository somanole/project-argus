import { describe, it, expect } from 'vitest';
import { instanceColor } from './instanceColor';

describe('instanceColor', () => {
  it('is stable for the same id', () => {
    expect(instanceColor('abc')).toBe(instanceColor('abc'));
  });

  it('always resolves to a vendored token (never a hard-coded color)', () => {
    for (const id of ['a', 'prod', 'staging', 'x9f2', '']) {
      expect(instanceColor(id)).toMatch(/^var\(--color--[a-z]+-\d+\)$/);
    }
  });
});
