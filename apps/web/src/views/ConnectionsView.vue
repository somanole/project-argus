<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { useConnectionsStore } from '../stores/connections';
import { ApiError } from '../lib/api';
import HealthBadge from '../components/HealthBadge.vue';
import AnalyzerDriftNotice from '../components/AnalyzerDriftNotice.vue';
import { instanceColor } from '../lib/instanceColor';
import { relativeTime } from '../lib/time';

const connections = useConnectionsStore();

const form = reactive({ label: '', baseUrl: '', apiKey: '', webhookHost: '' });
const submitting = ref(false);
const formError = ref<string | null>(null);
const removingId = ref<string | null>(null);

let poll: ReturnType<typeof setInterval> | undefined;

async function register(): Promise<void> {
  submitting.value = true;
  formError.value = null;
  try {
    await connections.register({
      label: form.label,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      webhookHost: form.webhookHost.trim() === '' ? null : form.webhookHost.trim(),
    });
    form.label = '';
    form.baseUrl = '';
    form.apiKey = '';
    form.webhookHost = '';
  } catch (err) {
    formError.value = err instanceof ApiError ? err.message : 'could not register the connection';
  } finally {
    submitting.value = false;
  }
}

async function remove(id: string, label: string): Promise<void> {
  if (!window.confirm(`Remove connection “${label}”? Its cached workflows are dropped (the instance is untouched).`)) return;
  removingId.value = id;
  try {
    await connections.remove(id);
  } finally {
    removingId.value = null;
  }
}

onMounted(async () => {
  await connections.refresh();
  poll = setInterval(() => void connections.refresh(), 15_000);
});
onUnmounted(() => {
  if (poll) clearInterval(poll);
});
</script>

<template>
  <section class="connections">
    <header class="head">
      <h1>Connections</h1>
      <p class="muted sub">Point Argus at each n8n instance with a read-only API key.</p>
    </header>

    <div class="grid">
      <!-- Register -->
      <form class="card panel" @submit.prevent="register">
        <h2>Register an instance</h2>
        <div class="field">
          <label for="label">Label</label>
          <input id="label" v-model="form.label" class="input" placeholder="prod" required>
        </div>
        <div class="field">
          <label for="url">Base URL</label>
          <input id="url" v-model="form.baseUrl" class="input" placeholder="http://localhost:5678" required>
        </div>
        <div class="field">
          <label for="key">API key</label>
          <input id="key" v-model="form.apiKey" class="input" type="password" placeholder="n8n public API key" required>
          <span class="hint">A read-only n8n API key (Settings → n8n API). Stored encrypted; never shown again.</span>
        </div>
        <div class="field">
          <label for="hook">Public webhook host <span class="opt">(optional)</span></label>
          <input id="hook" v-model="form.webhookHost" class="input" placeholder="https://hooks.example.com">
        </div>

        <p v-if="formError" class="err" role="alert">{{ formError }}</p>

        <button class="btn btn--primary btn--block" type="submit" :disabled="submitting">
          {{ submitting ? 'Validating & connecting…' : 'Register connection' }}
        </button>
      </form>

      <!-- Registered -->
      <div class="list">
        <p v-if="connections.state === 'loading'" class="muted pad">Loading connections…</p>
        <p v-else-if="connections.state === 'error'" class="err pad">Couldn’t load connections — {{ connections.error }}.</p>
        <div v-else-if="connections.connections.length === 0" class="card empty muted">
          No connections yet. Register your first instance on the left.
        </div>

        <article v-for="c in connections.connections" :key="c.id" class="card conn">
          <div class="conn-head">
            <span class="conn-label">
              <span class="dot" :style="{ background: instanceColor(c.id) }" />
              {{ c.label }}
            </span>
            <HealthBadge :health="c.health" data-testid="connection-health" />
          </div>
          <div class="conn-url mono">{{ c.baseUrl }}</div>
          <p v-if="c.health.lastError" class="err small">{{ c.health.lastError }}</p>
          <AnalyzerDriftNotice :drift="c.health.analyzerDrift" data-testid="analyzer-drift" />
          <div class="conn-foot">
            <dl class="meta">
              <div><dt>Workflows</dt><dd>{{ c.health.workflowCount }}</dd></div>
              <div><dt>Last synced</dt><dd>{{ relativeTime(c.health.lastSyncedAt) }}</dd></div>
            </dl>
            <button class="btn btn--danger btn--sm" :disabled="removingId === c.id" @click="remove(c.id, c.label)">
              {{ removingId === c.id ? 'Removing…' : 'Remove' }}
            </button>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.connections { display: flex; flex-direction: column; gap: var(--spacing--md); }
.head h1 { margin: 0; font-size: var(--font-size--xl); font-weight: var(--font-weight--bold); }
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--sm); }

.grid { display: grid; grid-template-columns: minmax(0, 22rem) 1fr; gap: var(--spacing--lg); align-items: start; }
@media (max-width: 46rem) { .grid { grid-template-columns: 1fr; } }

.panel { display: flex; flex-direction: column; gap: var(--spacing--sm); }
.panel h2 { margin: 0; font-size: var(--font-size--md); font-weight: var(--font-weight--bold); }
.opt { color: var(--color--text--shade-1); opacity: 0.6; font-weight: var(--font-weight--regular); }

.list { display: flex; flex-direction: column; gap: var(--spacing--sm); }
.conn { display: flex; flex-direction: column; gap: var(--spacing--2xs); }
.conn-head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm); }
.conn-label { display: inline-flex; align-items: center; gap: var(--spacing--4xs); font-weight: var(--font-weight--bold); }
.conn-url { color: var(--color--text--shade-1); opacity: 0.8; word-break: break-all; }
/* Stats and the Remove action share the footer row — stats left, action right —
   so the card stays as tall as its content instead of trailing dead space. */
.conn-foot { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--spacing--sm); margin-top: var(--spacing--4xs); }
.meta { display: flex; gap: var(--spacing--xl); margin: 0; }
.meta div { display: flex; flex-direction: column; gap: 0; }
.meta dt { font-size: var(--font-size--3xs); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide); color: var(--color--text--shade-1); opacity: 0.6; }
.meta dd { margin: 0; font-size: var(--font-size--sm); font-variant-numeric: tabular-nums; }

.err { margin: 0; color: var(--color--danger); font-size: var(--font-size--2xs); }
.err.small { font-size: var(--font-size--3xs); }
.empty { text-align: center; }
.pad { padding: var(--spacing--md) 0; }
</style>
