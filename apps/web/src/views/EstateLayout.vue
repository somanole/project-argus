<script setup lang="ts">
// The Estate — the single explorable surface. This layout owns the lens tab bar
// (what you're looking at); the active lens's view renders below via <router-view>.
// A lens is a saved filter + grouping + columns over the same estate; the sidebar's
// nested Estate shortcuts deep-link straight to a lens.
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

const lenses = [
  { key: 'explore', label: 'Explore', to: '/estate' },
  { key: 'health', label: 'Health', to: '/estate/health' },
  { key: 'ownership', label: 'Ownership', to: '/estate/ownership' },
] as const;

const activeLens = computed(() => {
  if (route.name === 'estate-health') return 'health';
  if (route.name === 'estate-ownership') return 'ownership';
  return 'explore';
});
</script>

<template>
  <section class="estate" data-testid="estate-view">
    <nav class="lenstabs" aria-label="Estate lens">
      <router-link
        v-for="l in lenses"
        :key="l.key"
        :to="l.to"
        class="lenstab"
        :class="{ on: activeLens === l.key }"
        :aria-current="activeLens === l.key ? 'page' : undefined"
        :data-testid="`lens-${l.key}`"
      >
        {{ l.label }}
      </router-link>
    </nav>

    <router-view />
  </section>
</template>

<style scoped>
.estate { display: flex; flex-direction: column; gap: var(--spacing--sm); }

.lenstabs {
  display: flex; gap: var(--spacing--2xs); flex-wrap: wrap;
  border-bottom: 1px solid var(--border-color);
}
.lenstab {
  appearance: none; text-decoration: none;
  font-size: var(--font-size--md); font-weight: var(--font-weight--medium);
  color: var(--color--text--shade-1); opacity: 0.65;
  padding: var(--spacing--2xs) var(--spacing--3xs);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.lenstab:hover { opacity: 1; }
.lenstab.on { color: var(--background--brand); opacity: 1; border-bottom-color: var(--background--brand); }
</style>
