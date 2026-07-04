import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * Controls the active theme by setting `data-theme` on <body>, which is exactly
 * the mechanism n8n's vendored tokens use (see styles/n8n-tokens/VENDORED.md):
 *   - 'system' → remove the attribute; the OS `prefers-color-scheme` decides
 *   - 'light' / 'dark' → force that theme
 * Argus never flattens to a single theme (standing rule 10).
 */
export const useThemeStore = defineStore('theme', () => {
  const preference = ref<ThemePreference>('system');

  function apply(pref: ThemePreference): void {
    preference.value = pref;
    const body = document.body;
    if (pref === 'system') {
      body.removeAttribute('data-theme');
    } else {
      body.setAttribute('data-theme', pref);
    }
  }

  return { preference, apply };
});
