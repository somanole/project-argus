import { describe, expect, it, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useThemeStore } from './theme';

describe('theme store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.removeAttribute('data-theme');
  });

  it("forces dark by setting body[data-theme='dark']", () => {
    const theme = useThemeStore();
    theme.apply('dark');
    expect(document.body.getAttribute('data-theme')).toBe('dark');
  });

  it("forces light by setting body[data-theme='light']", () => {
    const theme = useThemeStore();
    theme.apply('light');
    expect(document.body.getAttribute('data-theme')).toBe('light');
  });

  it("'system' removes the attribute so prefers-color-scheme decides (never flattened)", () => {
    const theme = useThemeStore();
    theme.apply('dark');
    theme.apply('system');
    expect(document.body.hasAttribute('data-theme')).toBe(false);
  });
});
