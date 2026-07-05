<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useWorkflowsStore } from '../stores/workflows';
import { useConnectionsStore } from '../stores/connections';
import StateBadge from '../components/StateBadge.vue';
import { instanceColor } from '../lib/instanceColor';
import { relativeTime } from '../lib/time';

const workflows = useWorkflowsStore();
const connections = useConnectionsStore();
const { filtered, state, error, filter, lastUpdated, workflows: all } = storeToRefs(workflows);

// A ticking clock so "synced Ns ago" advances between refreshes.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;

const total = computed(() => all.value.length);
const countFor = (id: string) => all.value.filter((w) => w.instanceId === id).length;
const syncedAgo = computed(() => relativeTime(lastUpdated.value, now.value));

async function refreshAll(): Promise<void> {
  await Promise.all([workflows.refresh(), connections.refresh()]);
}

onMounted(async () => {
  await refreshAll();
  // Auto-refresh so the estate reflects n8n changes without user action.
  poll = setInterval(() => void refreshAll(), 15_000);
  clock = setInterval(() => (now.value = Date.now()), 1_000);
});
onUnmounted(() => {
  if (poll) clearInterval(poll);
  if (clock) clearInterval(clock);
});
</script>

<template>
  <section class="workflows">
    <header class="head">
      <div>
        <h1>Workflows</h1>
        <p class="muted sub">
          {{ total }} across {{ connections.connections.length }}
          instance<span v-if="connections.connections.length !== 1">s</span>
        </p>
      </div>
      <div class="freshness">
        <span class="badge badge--muted"><span class="dot dot--ok" /> Polling — updates within ~30s</span>
        <span class="muted synced">synced {{ syncedAgo }}</span>
        <button class="btn btn--secondary btn--sm" @click="refreshAll">Refresh</button>
      </div>
    </header>

    <div class="filters" role="group" aria-label="Filter by instance">
      <button class="chip" :class="{ 'chip--active': filter === 'all' }" @click="workflows.setFilter('all')">
        All estate <span class="count">{{ total }}</span>
      </button>
      <button
        v-for="c in connections.connections"
        :key="c.id"
        class="chip"
        :class="{ 'chip--active': filter === c.id }"
        @click="workflows.setFilter(c.id)"
      >
        <span class="dot" :style="{ background: instanceColor(c.id) }" />
        {{ c.label }} <span class="count">{{ countFor(c.id) }}</span>
      </button>
    </div>

    <p v-if="state === 'loading'" class="muted pad">Loading the estate…</p>

    <p v-else-if="state === 'error'" class="err pad" role="alert">
      Couldn’t load workflows — {{ error }}.
    </p>

    <div v-else-if="filtered.length === 0" class="card empty">
      <p v-if="total === 0">
        No workflows yet. <router-link to="/connections">Register a connection</router-link> to see your estate.
      </p>
      <p v-else class="muted">No workflows for this instance.</p>
    </div>

    <div v-else class="table-wrap">
      <table class="wf">
        <thead>
          <tr>
            <th class="c-name">Name</th>
            <th class="c-inst">Instance</th>
            <th class="c-proj">Project</th>
            <th class="c-state">Status</th>
            <th class="c-upd">Updated</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="w in filtered" :key="w.instanceId + '/' + w.id">
            <td class="c-name">{{ w.name }}</td>
            <td class="c-inst">
              <span class="instance">
                <span class="dot" :style="{ background: instanceColor(w.instanceId) }" />
                {{ w.instanceLabel }}
              </span>
            </td>
            <td class="c-proj">
              <span v-if="w.project">{{ w.project }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td class="c-state"><StateBadge :active="w.active" :is-archived="w.isArchived" /></td>
            <td class="c-upd muted">{{ relativeTime(w.updatedAt, now) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.workflows { display: flex; flex-direction: column; gap: var(--spacing--md); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--md); flex-wrap: wrap; }
h1 { margin: 0; font-size: var(--font-size--xl); font-weight: var(--font-weight--bold); }
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--sm); }
.freshness { display: flex; align-items: center; gap: var(--spacing--2xs); flex-wrap: wrap; }
.synced { font-size: var(--font-size--2xs); }

.filters { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; }
.chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: var(--spacing--4xs);
  border: 1px solid var(--border-color);
  border-radius: var(--radius--full);
  background: var(--background--surface);
  color: var(--color--text--shade-1);
  font: inherit;
  font-size: var(--font-size--2xs);
  font-weight: var(--font-weight--medium);
  padding: var(--spacing--4xs) var(--spacing--sm);
  cursor: pointer;
}
.chip:hover { background: var(--background--subtle); }
.chip--active { background: var(--background--brand); color: var(--color--neutral-white); border-color: var(--background--brand); }
.chip .count { opacity: 0.7; font-variant-numeric: tabular-nums; }

.table-wrap {
  border: 1px solid var(--border-color--subtle);
  border-radius: var(--radius--lg);
  overflow-x: auto;
}
.wf { width: 100%; border-collapse: collapse; font-size: var(--font-size--sm); }
.wf thead th {
  text-align: left;
  font-size: var(--font-size--3xs);
  font-weight: var(--font-weight--medium);
  text-transform: uppercase;
  letter-spacing: var(--letter-spacing--wide);
  color: var(--color--text--shade-1);
  opacity: 0.6;
  padding: var(--spacing--2xs) var(--spacing--sm);
  background: var(--background--subtle);
  border-bottom: 1px solid var(--border-color--subtle);
  white-space: nowrap;
}
.wf tbody td {
  padding: var(--spacing--2xs) var(--spacing--sm);
  border-bottom: 1px solid var(--border-color--subtle);
  vertical-align: middle;
}
.wf tbody tr:last-child td { border-bottom: 0; }
.wf tbody tr:hover td { background: var(--background--hover, var(--background--subtle)); }
.c-name { font-weight: var(--font-weight--medium); }
.c-upd { white-space: nowrap; font-size: var(--font-size--2xs); }
.instance { display: inline-flex; align-items: center; gap: var(--spacing--4xs); white-space: nowrap; }

.empty { text-align: center; }
.empty p { margin: 0; }
.pad { padding: var(--spacing--md) 0; }
.err { color: var(--text-color--danger, var(--color--danger)); }
a { color: var(--color--primary, var(--background--brand)); }
</style>
