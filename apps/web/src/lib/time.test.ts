import { describe, it, expect } from 'vitest';
import { relativeTime } from './time';

const now = Date.parse('2026-07-05T12:00:00.000Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

describe('relativeTime', () => {
  it('returns "—" for missing or invalid input (never a guess)', () => {
    expect(relativeTime(null, now)).toBe('—');
    expect(relativeTime(undefined, now)).toBe('—');
    expect(relativeTime('not-a-date', now)).toBe('—');
  });

  it('formats seconds / minutes / hours / days', () => {
    expect(relativeTime(ago(1000), now)).toBe('just now');
    expect(relativeTime(ago(30_000), now)).toBe('30s ago');
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5m ago');
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe('3h ago');
    expect(relativeTime(ago(2 * 86_400_000), now)).toBe('2d ago');
  });
});
