<script setup lang="ts">
import { computed } from 'vue';
import type { ConnectionHealth } from '@argus/shared';

// Honest connection health (standing rule 5) — never shows an unreachable
// instance as a healthy empty estate.
const props = defineProps<{ health: ConnectionHealth }>();

const view = computed(() => {
  switch (props.health.status) {
    case 'ok':
      return { cls: 'badge--ok', dot: 'dot--ok', label: 'Connected' };
    case 'unauthorized':
      return { cls: 'badge--danger', dot: 'dot--danger', label: 'Key rejected' };
    case 'unreachable':
      return { cls: 'badge--danger', dot: 'dot--danger', label: 'Unreachable' };
    default:
      return { cls: 'badge--muted', dot: 'dot--muted', label: 'Syncing…' };
  }
});
</script>

<template>
  <span class="badge" :class="view.cls">
    <span class="dot" :class="view.dot" />
    {{ view.label }}
  </span>
</template>
