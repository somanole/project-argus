<script setup lang="ts">
import { onMounted } from 'vue';
import { useHealthStore } from './stores/health';
import { useThemeStore, type ThemePreference } from './stores/theme';

const health = useHealthStore();
const theme = useThemeStore();

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

onMounted(() => {
  void health.fetchHealth();
});
</script>

<template>
  <main class="page">
    <header class="masthead">
      <div class="wordmark">
        <span class="eye" aria-hidden="true" />
        <span class="name">Argus</span>
      </div>
      <div class="theme-control" role="group" aria-label="Theme">
        <button
          v-for="opt in themeOptions"
          :key="opt.value"
          type="button"
          class="theme-button"
          :class="{ 'is-active': theme.preference === opt.value }"
          :aria-pressed="theme.preference === opt.value"
          @click="theme.apply(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </header>

    <p class="tagline">
      Fleet-wide governance and accountability for n8n.
      <span class="milestone">Milestone M0 — scaffold</span>
    </p>

    <section class="card" aria-labelledby="health-title">
      <div class="card-head">
        <h2 id="health-title">Server health</h2>
        <button type="button" class="btn-primary" :disabled="health.state === 'loading'" @click="health.fetchHealth()">
          {{ health.state === 'loading' ? 'Checking…' : 'Re-check' }}
        </button>
      </div>

      <p v-if="health.state === 'loading'" class="muted">Contacting the Argus server…</p>

      <p v-else-if="health.state === 'error'" class="status status-error">
        Couldn’t reach the Argus server — {{ health.error }}.
        <span class="muted">Start it with <code>pnpm dev:server</code>.</span>
      </p>

      <dl v-else-if="health.state === 'ok' && health.data" class="fields">
        <div class="field">
          <dt>Status</dt>
          <dd>
            <span class="status" :class="health.data.status === 'ok' ? 'status-ok' : 'status-warn'">
              {{ health.data.status }}
            </span>
          </dd>
        </div>
        <div class="field"><dt>Service</dt><dd><code>{{ health.data.service }}</code></dd></div>
        <div class="field"><dt>Version</dt><dd><code>{{ health.data.version }}</code></dd></div>
        <div class="field"><dt>Database</dt><dd><code>{{ health.data.db }}</code></dd></div>
        <div class="field"><dt>Server time</dt><dd><code>{{ health.data.time }}</code></dd></div>
      </dl>
    </section>

    <footer class="footnote muted">
      Styled with n8n’s vendored design tokens · renders in light &amp; dark
    </footer>
  </main>
</template>

<style scoped>
/* Every value is a var(--…) token from the vendored n8n foundation — no
   hard-coded colors, spacing, radii, or fonts (standing rule 10). */
.page {
  max-width: 40rem;
  margin: 0 auto;
  padding: var(--spacing--2xl) var(--spacing--lg) var(--spacing--3xl);
  display: flex;
  flex-direction: column;
  gap: var(--spacing--lg);
}

.masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing--md);
}

.wordmark {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing--xs);
}

.eye {
  width: var(--spacing--md);
  height: var(--spacing--md);
  border-radius: var(--radius--full);
  background: radial-gradient(
    circle at center,
    var(--color--neutral-white) 0 22%,
    var(--background--brand) 30% 100%
  );
  box-shadow: 0 0 0 2px var(--background--brand);
}

.name {
  font-size: var(--font-size--2xl);
  font-weight: var(--font-weight--bold);
  letter-spacing: -0.01em;
}

.theme-control {
  display: inline-flex;
  border: var(--border-width, 1px) solid var(--border-color);
  border-radius: var(--radius--md);
  overflow: hidden;
}

.theme-button {
  appearance: none;
  border: 0;
  background: var(--background--surface);
  color: var(--color--text--shade-1);
  font: inherit;
  font-size: var(--font-size--2xs);
  padding: var(--spacing--3xs) var(--spacing--sm);
  cursor: pointer;
}
.theme-button + .theme-button {
  border-left: var(--border-width, 1px) solid var(--border-color);
}
.theme-button:hover {
  background: var(--background--hover, var(--background--subtle));
}
.theme-button.is-active {
  background: var(--background--brand);
  color: var(--color--neutral-white);
}

.tagline {
  margin: 0;
  font-size: var(--font-size--md);
  color: var(--color--text--shade-1);
}
.milestone {
  display: inline-block;
  margin-left: var(--spacing--2xs);
  padding: var(--spacing--5xs) var(--spacing--2xs);
  border-radius: var(--radius--sm);
  background: var(--background--subtle);
  color: var(--color--text--shade-1);
  font-size: var(--font-size--3xs);
  font-weight: var(--font-weight--medium);
}

.card {
  background: var(--background--subtle);
  border: var(--border-width, 1px) solid var(--border-color--subtle);
  border-radius: var(--radius--lg);
  padding: var(--spacing--lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing--md);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing--md);
}
.card-head h2 {
  margin: 0;
  font-size: var(--font-size--lg);
  font-weight: var(--font-weight--bold);
}

.btn-primary {
  appearance: none;
  border: 0;
  border-radius: var(--radius--md);
  background: var(--background--brand);
  color: var(--color--neutral-white);
  font: inherit;
  font-size: var(--font-size--sm);
  font-weight: var(--font-weight--medium);
  padding: var(--spacing--2xs) var(--spacing--md);
  cursor: pointer;
}
.btn-primary:hover:not(:disabled) {
  background: var(--background--brand--hover);
}
.btn-primary:disabled {
  background: var(--background--brand--disabled);
  cursor: default;
}

.fields {
  margin: 0;
  display: grid;
  gap: var(--spacing--2xs);
}
.field {
  display: flex;
  justify-content: space-between;
  gap: var(--spacing--md);
}
.field dt {
  color: var(--color--text--shade-1);
  opacity: 0.7;
}
.field dd {
  margin: 0;
}

code {
  font-family: CommitMono, monospace;
  font-size: var(--font-size--2xs);
}

.status {
  display: inline-block;
  padding: var(--spacing--5xs) var(--spacing--2xs);
  border-radius: var(--radius--sm);
  font-size: var(--font-size--2xs);
  font-weight: var(--font-weight--medium);
}
.status-ok {
  background: var(--color--success--tint-2, var(--background--subtle));
  color: var(--color--success);
}
.status-warn {
  background: var(--color--warning--tint-2, var(--background--subtle));
  color: var(--color--warning);
}
.status-error {
  color: var(--color--danger);
}

.muted {
  color: var(--color--text--shade-1);
  opacity: 0.65;
  font-size: var(--font-size--sm);
}
.footnote {
  font-size: var(--font-size--3xs);
}
</style>
