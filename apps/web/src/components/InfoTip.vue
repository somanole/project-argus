<script setup lang="ts">
// A small ⓘ affordance that reveals a short explanation on hover/focus — so the longer
// "why" prose can leave the dashboard surface and live here instead (keeps views clean,
// rule 10/11). Accessible: a real button, keyboard-focusable, the copy in a role="tooltip".
// Token-only styling → both themes for free. The popover aligns to the trigger's right
// edge and extends left, so it never pushes the page into horizontal overflow at 375px.
withDefaults(defineProps<{ text: string; label?: string }>(), { label: 'More information' });
</script>

<template>
  <span class="infotip" data-testid="infotip">
    <button type="button" class="infotip-btn" :aria-label="label">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M12 11v5" stroke-linecap="round" /><circle cx="12" cy="7.75" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    </button>
    <span class="infotip-pop" role="tooltip">{{ text }}</span>
  </span>
</template>

<style scoped>
.infotip { position: relative; display: inline-flex; vertical-align: middle; }
.infotip-btn {
  appearance: none; border: 0; background: none; padding: 0; margin: 0; cursor: help;
  display: inline-grid; place-items: center; color: var(--color--text--shade-1); opacity: 0.5;
  border-radius: var(--radius--full);
}
.infotip-btn:hover, .infotip-btn:focus-visible { opacity: 0.9; }
.infotip-btn:focus-visible { outline: 2px solid var(--background--brand); outline-offset: 2px; }
.infotip-btn svg { width: 0.9rem; height: 0.9rem; }

.infotip-pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 40;
  width: max-content; max-width: min(16rem, 70vw);
  padding: var(--spacing--2xs) var(--spacing--sm);
  background: var(--background--surface); color: var(--color--text--shade-1);
  border: 1px solid var(--border-color--subtle); border-radius: var(--radius--md);
  box-shadow: var(--shadow); font-size: var(--font-size--2xs); line-height: 1.45; font-weight: var(--font-weight--regular);
  opacity: 0; visibility: hidden; transform: translateY(-2px);
  transition: opacity var(--duration--snappy, 0.12s) ease, transform var(--duration--snappy, 0.12s) ease, visibility 0s linear 0.12s;
  text-align: left; white-space: normal; pointer-events: none;
}
.infotip:hover .infotip-pop,
.infotip:focus-within .infotip-pop {
  opacity: 1; visibility: visible; transform: translateY(0);
  transition: opacity var(--duration--snappy, 0.12s) ease, transform var(--duration--snappy, 0.12s) ease;
}
</style>
