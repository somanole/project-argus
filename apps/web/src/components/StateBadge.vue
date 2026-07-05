<script setup lang="ts">
import { computed } from 'vue';

// A workflow's live state, mirroring n8n: Active / Inactive, or Archived.
const props = defineProps<{ active: boolean; isArchived: boolean }>();

const view = computed(() => {
  if (props.isArchived) return { cls: 'badge--muted', dot: 'dot--muted', label: 'Archived' };
  if (props.active) return { cls: 'badge--ok', dot: 'dot--ok', label: 'Active' };
  return { cls: 'badge--muted', dot: 'dot--muted', label: 'Inactive' };
});
</script>

<template>
  <span class="badge" :class="view.cls">
    <span class="dot" :class="view.dot" />
    {{ view.label }}
  </span>
</template>
