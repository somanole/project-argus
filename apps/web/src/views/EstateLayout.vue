<script setup lang="ts">
// The Estate — the single explorable surface, with two independent controls:
//   • lens (what you're looking at): Explore / Health / Ownership — the tab bar.
//   • representation (how it's drawn): List / Graph — the toggle, orthogonal to the lens
//     and driven by ?view=. The graph is the same estate; the lens emphasizes a subset.
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import GraphView from './GraphView.vue';

const route = useRoute();
const router = useRouter();

const lenses = [
  { key: 'explore', label: 'Explore', to: '/estate' },
  { key: 'health', label: 'Health', to: '/estate/health' },
  { key: 'ownership', label: 'Ownership', to: '/estate/ownership' },
] as const;

const activeLens = computed<'explore' | 'health' | 'ownership'>(() => {
  if (route.name === 'estate-health') return 'health';
  if (route.name === 'estate-ownership') return 'ownership';
  return 'explore';
});

const rep = computed<'list' | 'graph'>(() => (route.query.view === 'graph' ? 'graph' : 'list'));
function setRep(next: 'list' | 'graph'): void {
  const query = { ...route.query };
  if (next === 'graph') query.view = 'graph';
  else delete query.view;
  void router.replace({ path: route.path, query });
}
// Keep ?view across lens switches so the representation is sticky.
const lensTo = (to: string) => ({ path: to, query: rep.value === 'graph' ? { view: 'graph' } : {} });
</script>

<template>
  <section class="estate" data-testid="estate-view">
    <div class="controlbar">
      <nav class="lenstabs" aria-label="Estate lens">
        <router-link
          v-for="l in lenses"
          :key="l.key"
          :to="lensTo(l.to)"
          class="lenstab"
          :class="{ on: activeLens === l.key }"
          :aria-current="activeLens === l.key ? 'page' : undefined"
          :data-testid="`lens-${l.key}`"
        >
          {{ l.label }}
        </router-link>
      </nav>

      <div class="rep" role="group" aria-label="View" data-testid="estate-rep-toggle">
        <button type="button" :class="{ on: rep === 'list' }" :aria-pressed="rep === 'list'" data-testid="rep-list" @click="setRep('list')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>List
        </button>
        <button type="button" :class="{ on: rep === 'graph' }" :aria-pressed="rep === 'graph'" data-testid="rep-graph" @click="setRep('graph')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="9" cy="18" r="2.5" /><path d="m8 7 8 1M8 8l1 8" /></svg>Graph
        </button>
      </div>
    </div>

    <!-- List representation = the lens's own view; Graph representation = the shared map. -->
    <GraphView v-if="rep === 'graph'" embedded :lens="activeLens" />
    <router-view v-else />
  </section>
</template>

<style scoped>
.estate { display: flex; flex-direction: column; gap: var(--spacing--sm); }

.controlbar {
  display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm);
  flex-wrap: wrap; border-bottom: 1px solid var(--border-color);
}
.lenstabs { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; }
.lenstab {
  appearance: none; text-decoration: none;
  font-size: var(--font-size--md); font-weight: var(--font-weight--medium);
  color: var(--color--text--shade-1); opacity: 0.65;
  padding: var(--spacing--2xs) var(--spacing--3xs);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.lenstab:hover { opacity: 1; }
.lenstab.on { color: var(--background--brand); opacity: 1; border-bottom-color: var(--background--brand); }

/* List / Graph representation toggle. */
.rep { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--radius--md); overflow: hidden; margin-bottom: var(--spacing--4xs); }
.rep button {
  appearance: none; border: 0; border-right: 1px solid var(--border-color);
  background: var(--background--surface); color: var(--color--text--shade-1);
  font: inherit; font-size: var(--font-size--2xs); font-weight: var(--font-weight--medium);
  padding: var(--spacing--4xs) var(--spacing--2xs); cursor: pointer;
  display: inline-flex; align-items: center; gap: var(--spacing--4xs);
}
.rep button:last-child { border-right: 0; }
.rep button svg { width: 0.9rem; height: 0.9rem; }
.rep button:hover:not(.on) { background: var(--background--subtle); }
.rep button.on { background: var(--background--brand); color: var(--color--neutral-white); }
</style>
