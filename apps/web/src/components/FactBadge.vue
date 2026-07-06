<script setup lang="ts">
// A small labelled pill for a catalog fact (a system, a trigger, MCP, a warning).
// All tones are token-based, so every one flips correctly in light/dark.
withDefaults(defineProps<{ label: string; tone?: 'system' | 'trigger' | 'mcp' | 'ok' | 'warn' | 'danger' | 'muted'; title?: string }>(), {
  tone: 'muted',
  title: '',
});
</script>

<template>
  <span class="fbadge" :class="`fbadge--${tone}`" :title="title || label">
    <slot name="icon" />
    {{ label }}
  </span>
</template>

<style scoped>
.fbadge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing--5xs);
  max-width: 100%;
  padding: var(--spacing--5xs) var(--spacing--2xs);
  border-radius: var(--radius--full);
  border: 1px solid var(--border-color--subtle);
  background: var(--background--subtle);
  color: var(--color--text--shade-1);
  font-size: var(--font-size--3xs);
  font-weight: var(--font-weight--medium);
  line-height: var(--line-height--sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Systems get a subtle brand-tinted border so "touches X" reads as an integration. */
.fbadge--system {
  border-color: var(--border-color);
  background: var(--background--surface);
}
.fbadge--trigger {
  border-color: var(--border-color);
  background: var(--background--subtle);
}
.fbadge--mcp {
  background: var(--background--warning, var(--background--subtle));
  color: var(--text-color--warning, var(--color--warning));
  border-color: var(--border-color--warning, transparent);
}
.fbadge--ok {
  background: var(--background--success, var(--background--subtle));
  color: var(--text-color--success, var(--color--success));
  border-color: var(--border-color--success, transparent);
}
.fbadge--warn {
  background: var(--background--warning, var(--background--subtle));
  color: var(--text-color--warning, var(--color--warning));
  border-color: var(--border-color--warning, transparent);
}
.fbadge--danger {
  background: var(--background--danger, var(--background--subtle));
  color: var(--text-color--danger, var(--color--danger));
  border-color: var(--border-color--danger, transparent);
}
.fbadge--muted {
  opacity: 0.9;
}
</style>
