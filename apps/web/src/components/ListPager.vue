<script setup lang="ts">
// One pager for every list in the app — Previous / Next plus an "X–Y of N" readout.
// Presentational: the parent owns the page state (server-side for the catalog, client-side
// for the health/ownership groups) and reacts to `go`. Renders NOTHING when everything fits
// on a single page, so small lists stay uncluttered. Tokens only → both themes for free.
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    page: number; // 0-based current page
    pageSize: number;
    total: number; // total items across all pages
    label?: string; // aria-label for the nav
  }>(),
  { label: 'Pages' },
);
const emit = defineEmits<{ (e: 'go', page: number): void }>();

const lastPage = computed(() => Math.max(Math.ceil(props.total / props.pageSize) - 1, 0));
const multiPage = computed(() => props.total > props.pageSize);
const rangeStart = computed(() => (props.total === 0 ? 0 : props.page * props.pageSize + 1));
const rangeEnd = computed(() => Math.min((props.page + 1) * props.pageSize, props.total));
const hasPrev = computed(() => props.page > 0);
const hasNext = computed(() => props.page < lastPage.value);

function go(p: number): void {
  emit('go', Math.min(Math.max(p, 0), lastPage.value));
}
</script>

<template>
  <nav v-if="multiPage" class="pager" :aria-label="label" data-testid="pager">
    <span class="muted range" data-testid="pager-range">{{ rangeStart }}–{{ rangeEnd }} of {{ total }}</span>
    <div class="pager-btns">
      <button class="btn btn--secondary btn--sm" :disabled="!hasPrev" data-testid="pager-prev" @click="go(page - 1)">Previous</button>
      <button class="btn btn--secondary btn--sm" :disabled="!hasNext" data-testid="pager-next" @click="go(page + 1)">Next</button>
    </div>
  </nav>
</template>

<style scoped>
.pager { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm); flex-wrap: wrap; padding-top: var(--spacing--3xs); }
.pager .range { font-size: var(--font-size--2xs); font-variant-numeric: tabular-nums; }
.pager-btns { display: flex; gap: var(--spacing--2xs); }
.pager-btns .btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
