<script setup lang="ts">
// Settings — enrichment. A master ON/OFF switch (the kill switch) governs everything;
// when on, you pick ONE provider (clear cards, not ambiguous radios) and paste its key.
// The active provider is stated plainly. Honest about the off / unconfigured / ops-locked
// states. Tokens-only, both themes, responsive.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useSettingsStore } from '../stores/settings';
import { checkBaseUrl, type LlmProvider } from '@argus/shared';

const store = useSettingsStore();
const { config, progress, state, error } = storeToRefs(store);

// `model: null` ⇒ the model is customer-chosen, not pinned by us (DECISION #30).
const PROVIDERS: { value: LlmProvider; label: string; model: string | null; blurb: string }[] = [
  { value: 'openai', label: 'OpenAI', model: 'gpt-5-mini', blurb: 'GPT — the reference provider.' },
  { value: 'anthropic', label: 'Anthropic', model: 'claude-haiku-4-5', blurb: 'Claude — measured against the same bar.' },
  {
    value: 'openai_compatible',
    label: 'Custom endpoint',
    model: null,
    blurb: 'Any OpenAI-compatible API — vLLM, Ollama, LM Studio, or your gateway. Self-hosted means nothing leaves your network.',
  },
];

const provider = ref<LlmProvider>('openai');
const apiKey = ref('');
const baseUrl = ref('');
const modelId = ref('');
const saved = ref(false);

const isCustom = computed(() => provider.value === 'openai_compatible');

// Live base-URL feedback, using the SAME validator the server enforces with.
const urlCheck = computed(() => (baseUrl.value.trim() ? checkBaseUrl(baseUrl.value) : null));
const urlError = computed(() => (urlCheck.value && !urlCheck.value.ok ? urlCheck.value.reason : null));
// http:// is allowed (an in-VPC endpoint is the point) but never silently — say what it means.
const insecure = computed(() => urlCheck.value?.ok === true && urlCheck.value.insecure === true);

/** The probe verdict for the saved custom endpoint (null for the hosted providers). */
const caps = computed(() => config.value?.capabilities ?? null);
const chatAvailable = computed(() => caps.value === null || caps.value.streamingToolCalls);

let poll: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await store.load();
  // Keep "last ran" + pending live while the owner watches enrichment fill in.
  poll = setInterval(() => void store.refreshProgress(), 5_000);
});
onUnmounted(() => {
  if (poll) clearInterval(poll);
});
watch(config, (c) => {
  if (c?.provider) provider.value = c.provider;
  // Pre-fill the endpoint so the owner can see (and amend) what's configured.
  if (c?.baseUrl) baseUrl.value = c.baseUrl;
  if (c?.provider === 'openai_compatible' && c.model) modelId.value = c.model;
});

// "Enrichment last ran" — absolute date + time (or never).
const lastEnrichedLabel = computed(() => {
  const t = progress.value?.lastEnrichedAt;
  return t ? new Date(t).toLocaleString() : 'never';
});
// Honest run feedback: report what ACTUALLY happened, never imply work that didn't run.
const enriching = ref(false);
const runNote = ref<string | null>(null);
let runPoll: ReturnType<typeof setInterval> | undefined;
const workLeft = (p: typeof progress.value): number => (p ? p.pending + p.stale : 0);

async function runNow(): Promise<void> {
  runNote.value = null;
  if (runPoll) clearInterval(runPoll);
  const p = await store.runNow();
  if (!p) return; // store holds the error
  if (workLeft(p) === 0) {
    // Nothing to do — say so plainly instead of faking a spinner (rule 5).
    runNote.value = 'Everything is up to date — nothing to re-enrich.';
    return;
  }
  // Real work queued: show live progress and finish only when it genuinely settles.
  enriching.value = true;
  let ticks = 0;
  runPoll = setInterval(async () => {
    ticks++;
    await store.refreshProgress();
    if (workLeft(progress.value) === 0 || ticks > 150 /* ~5 min safety cap */) {
      if (runPoll) clearInterval(runPoll);
      enriching.value = false;
      const done = progress.value;
      runNote.value = done
        ? `Enriched ${done.analyzed}/${done.total}${done.stub > 0 ? ` · ${done.stub} couldn’t analyze` : ''}.`
        : null;
    }
  }, 2_000);
}
onUnmounted(() => {
  if (runPoll) clearInterval(runPoll);
});

const enabled = computed(() => config.value?.enabled ?? false);
const envLocked = computed(() => config.value?.envLocked ?? false);
const configured = computed(() => config.value?.configured ?? false);
const busy = computed(() => state.value === 'saving');

// The single source of truth for the status banner.
const status = computed<'active' | 'on-unconfigured' | 'off' | 'env-locked'>(() => {
  if (envLocked.value) return 'env-locked';
  if (!enabled.value) return 'off';
  return configured.value ? 'active' : 'on-unconfigured';
});

async function toggle(): Promise<void> {
  if (envLocked.value || busy.value) return;
  await store.setEnabled(!enabled.value);
}

/**
 * A custom endpoint needs a base URL + model; its API key is OPTIONAL (keyless
 * self-hosted endpoints are the norm). The hosted providers still require a key.
 */
const canSave = computed(() => {
  if (busy.value) return false;
  if (!isCustom.value) return apiKey.value.trim().length > 0;
  return urlCheck.value?.ok === true && modelId.value.trim().length > 0;
});

/** Saving a custom endpoint re-probes it, which takes a moment — say so, don't just spin. */
const saveLabel = computed(() => {
  if (busy.value) return isCustom.value ? 'Probing endpoint…' : 'Saving…';
  const active = configured.value && config.value?.provider === provider.value;
  if (!active) return 'Save provider';
  // For a custom endpoint the key is optional, so "Update key" would misname the action.
  return isCustom.value ? 'Update endpoint' : 'Update key';
});

async function save(): Promise<void> {
  saved.value = false;
  if (!canSave.value) return;
  const ok = isCustom.value
    ? await store.save(provider.value, apiKey.value.trim(), { baseUrl: baseUrl.value.trim(), model: modelId.value.trim() })
    : await store.save(provider.value, apiKey.value.trim());
  if (ok) {
    apiKey.value = '';
    saved.value = true;
  }
}
</script>

<template>
  <section class="settings" data-testid="settings-view">
    <header>
      <h1>Settings</h1>
      <p class="muted sub">Enrichment provider. Only the workflow metadata allow-list is ever sent — never secrets or URLs.</p>
    </header>

    <div class="card">
      <!-- Master switch (the kill switch) -->
      <div class="switch-row">
        <div class="switch-label">
          <h2>Enrichment</h2>
          <p class="muted">When on, workflows get an AI summary, category, and criticality. When off, Argus runs fully deterministic — no summaries, nothing sent.</p>
        </div>
        <button
          type="button"
          role="switch"
          class="switch"
          :class="{ 'switch--on': enabled, 'switch--locked': envLocked }"
          :aria-checked="enabled"
          :disabled="envLocked || busy"
          data-testid="enrichment-toggle"
          @click="toggle"
        >
          <span class="knob" />
          <span class="switch-text">{{ enabled ? 'On' : 'Off' }}</span>
        </button>
      </div>

      <!-- Status banner: always states plainly what's happening -->
      <p class="status" :class="`status--${status}`" data-testid="llm-status">
        <span v-if="status === 'active'">
          <span class="dot dot--ok" /> Active — enriching via <strong>{{ config?.provider === 'openai_compatible' ? 'your endpoint' : config?.provider }}</strong>
          · <span class="mono">{{ config?.model }}</span>
          <span v-if="config?.baseUrl" class="mono muted"> @ {{ config.baseUrl }}</span>
        </span>
        <span v-else-if="status === 'on-unconfigured'"><span class="dot dot--warn" /> On, but no provider key yet — add one below to start.</span>
        <span v-else-if="status === 'env-locked'"><span class="dot dot--muted" /> Turned off by ops config (<span class="mono">ENRICHMENT_ENABLED=false</span>). The switch is locked.</span>
        <span v-else><span class="dot dot--muted" /> Off — Argus runs fully deterministic; no summaries.</span>
      </p>

      <!-- Provider selection + key — only when the switch is on and not ops-locked -->
      <div v-if="enabled && !envLocked" class="provider-block">
        <div class="field" role="radiogroup" aria-label="Provider" data-testid="llm-provider-select">
          <span class="field-label">Provider</span>
          <div class="providers">
            <button
              v-for="p in PROVIDERS"
              :key="p.value"
              type="button"
              role="radio"
              class="prov"
              :class="{ 'prov--selected': provider === p.value }"
              :aria-checked="provider === p.value"
              :data-testid="`provider-card-${p.value}`"
              @click="provider = p.value"
            >
              <span class="prov-radio" aria-hidden="true" />
              <span class="prov-body">
                <span class="prov-top">
                  <span class="prov-name">{{ p.label }}</span>
                  <span v-if="configured && config?.provider === p.value" class="prov-active" data-testid="provider-active-badge">Active</span>
                </span>
                <span class="prov-model mono muted">{{ p.model ?? 'your model' }}</span>
                <span class="prov-blurb muted">{{ p.blurb }}</span>
              </span>
            </button>
          </div>
        </div>

        <!-- Custom endpoint: base URL + model. The key below becomes optional. -->
        <template v-if="isCustom">
          <div class="field">
            <label for="llm-base-url">Base URL</label>
            <input
              id="llm-base-url"
              v-model="baseUrl"
              class="input"
              type="url"
              inputmode="url"
              autocomplete="off"
              spellcheck="false"
              placeholder="http://127.0.0.1:11434/v1"
              data-testid="llm-base-url-input"
            >
            <p v-if="urlError" class="err" role="alert" data-testid="llm-base-url-error">{{ urlError }}</p>
            <p v-else class="hint muted">The OpenAI-compatible API root. Point it at a vLLM, Ollama, LM Studio, or gateway endpoint.</p>
          </div>

          <!-- http:// is legitimate on a private network — but say what it costs, never assume. -->
          <p v-if="insecure" class="notice notice--warn" data-testid="llm-insecure-warning">
            <span class="dot dot--warn" />
            <span>Plain <span class="mono">http://</span> — workflow metadata will travel <strong>unencrypted</strong> to this endpoint. Fine on a private network; use <span class="mono">https://</span> if it crosses one.</span>
          </p>

          <div class="field">
            <label for="llm-model">Model</label>
            <input
              id="llm-model"
              v-model="modelId"
              class="input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="llama3.1:8b"
              data-testid="llm-model-input"
            >
            <p class="hint muted">Exactly as the endpoint names it. Argus pins no default here — the model is yours to choose.</p>
          </div>
        </template>

        <div class="field">
          <label for="llm-key">{{ PROVIDERS.find((p) => p.value === provider)?.label }} API key<span v-if="isCustom" class="muted"> (optional)</span></label>
          <input
            id="llm-key"
            v-model="apiKey"
            class="input"
            type="password"
            autocomplete="off"
            :placeholder="isCustom ? 'Leave blank if the endpoint needs no key' : configured && config?.provider === provider ? 'A key is stored — paste a new one to replace it' : 'Paste the provider API key'"
            data-testid="llm-key-input"
          >
          <p class="hint muted">
            Encrypted at rest, never shown again. Switching provider re-enriches the estate.<span v-if="isCustom"> Many self-hosted endpoints need no key.</span>
          </p>
        </div>

        <div class="actions">
          <button class="btn btn--primary" :disabled="!canSave" data-testid="llm-save" @click="save">
            {{ saveLabel }}
          </button>
          <span v-if="saved" class="ok muted" data-testid="llm-saved">Saved — enrichment started.</span>
          <span v-if="state === 'error'" class="err" role="alert">{{ error }}</span>
        </div>

        <!--
          The capability-probe verdict for the SAVED custom endpoint. Seam support is
          probed, never assumed (DECISION #30): an endpoint that can't emit tool calls
          disables chat out loud rather than letting it answer from nothing (rule 5).
        -->
        <div v-if="caps" class="caps" data-testid="llm-capabilities">
          <span class="caps-label muted">Endpoint capabilities</span>
          <p class="caps-endpoint mono muted" data-testid="llm-capabilities-endpoint">{{ config?.baseUrl }} · {{ config?.model }}</p>
          <ul class="caps-list">
            <li data-testid="cap-structured-output">
              <span class="dot" :class="caps.structuredOutput ? 'dot--ok' : 'dot--danger'" />
              <span>Enrichment <span class="muted">(structured output)</span> — <strong>{{ caps.structuredOutput ? 'supported' : 'unavailable' }}</strong></span>
            </li>
            <li data-testid="cap-tool-calls">
              <span class="dot" :class="caps.streamingToolCalls ? 'dot--ok' : 'dot--danger'" />
              <span>Chat <span class="muted">(tool calls)</span> — <strong>{{ caps.streamingToolCalls ? 'supported' : 'unavailable' }}</strong></span>
            </li>
          </ul>
          <p v-if="!chatAvailable" class="notice notice--warn" data-testid="llm-chat-unavailable">
            <span class="dot dot--warn" />
            <span>Chat is unavailable on this provider — it can only answer from real tool results, never guesses. Everything else in Argus keeps working.</span>
          </p>
          <p v-if="caps.note" class="caps-note muted" data-testid="llm-capabilities-note">{{ caps.note }}</p>
        </div>

        <!-- Freshness + manual re-run -->
        <div v-if="configured" class="run-wrap" data-testid="enrichment-run">
          <div class="run-row">
            <div class="run-meta">
              <span class="muted run-label">Enrichment last ran</span>
              <span class="run-time" data-testid="enrichment-last-ran">{{ lastEnrichedLabel }}</span>
              <span v-if="progress && progress.pending + progress.stale > 0" class="muted"> · {{ progress.pending + progress.stale }} to do</span>
              <span v-else-if="progress && progress.total > 0" class="muted"> · {{ progress.analyzed }}/{{ progress.total }} enriched</span>
            </div>
            <button class="btn btn--secondary btn--sm" :disabled="enriching" data-testid="enrich-now" @click="runNow">
              {{ enriching ? 'Enriching…' : 'Enrich now' }}
            </button>
          </div>
          <p v-if="runNote" class="run-note muted" data-testid="enrichment-run-note">{{ runNote }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: var(--spacing--md); max-width: 42rem; }
h1 { margin: 0; font-size: var(--font-size--xl); font-weight: var(--font-weight--bold); }
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--sm); }
.card { display: flex; flex-direction: column; gap: var(--spacing--md); }

/* Master switch */
.switch-row { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--md); flex-wrap: wrap; }
.switch-label { flex: 1 1 16rem; }
.switch-label h2 { margin: 0 0 var(--spacing--5xs); font-size: var(--font-size--md); font-weight: var(--font-weight--bold); }
.switch-label p { margin: 0; font-size: var(--font-size--2xs); line-height: var(--line-height--md); }
.switch {
  appearance: none; display: inline-flex; align-items: center; gap: var(--spacing--3xs);
  border: 1px solid var(--border-color); border-radius: var(--radius--full);
  background: var(--background--subtle); color: var(--color--text--shade-1);
  padding: var(--spacing--5xs) var(--spacing--2xs) var(--spacing--5xs) var(--spacing--5xs);
  font: inherit; font-size: var(--font-size--2xs); font-weight: var(--font-weight--medium);
  cursor: pointer; min-width: 4.5rem;
}
.switch .knob {
  width: 1.15rem; height: 1.15rem; border-radius: var(--radius--full);
  background: var(--color--text--shade-1); opacity: 0.55; transition: transform 0.12s ease, background 0.12s ease;
}
.switch--on { background: var(--background--brand); border-color: var(--background--brand); color: var(--color--neutral-white); flex-direction: row-reverse; padding: var(--spacing--5xs) var(--spacing--5xs) var(--spacing--5xs) var(--spacing--2xs); }
.switch--on .knob { background: var(--color--neutral-white); opacity: 1; }
.switch--locked { opacity: 0.6; cursor: not-allowed; }
.switch-text { line-height: 1; }

/* Status banner */
.status { margin: 0; font-size: var(--font-size--sm); display: flex; align-items: center; gap: var(--spacing--4xs); padding: var(--spacing--2xs) var(--spacing--sm); border-radius: var(--radius--md); border: 1px solid var(--border-color--subtle); }
.status--active { background: var(--background--success, var(--background--subtle)); }
.status--on-unconfigured, .status--env-locked { background: var(--background--warning, var(--background--subtle)); }
.status--off { background: var(--background--subtle); }
.status strong { font-weight: var(--font-weight--bold); }

/* Provider cards */
.provider-block { display: flex; flex-direction: column; gap: var(--spacing--md); border-top: 1px solid var(--border-color--subtle); padding-top: var(--spacing--md); }
.field { display: flex; flex-direction: column; gap: var(--spacing--4xs); }
.field-label, .field > label { font-size: var(--font-size--2xs); color: var(--color--text--shade-1); opacity: 0.7; }
.providers { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; }
.prov {
  appearance: none; text-align: left; cursor: pointer; flex: 1 1 15rem;
  display: flex; align-items: flex-start; gap: var(--spacing--2xs);
  border: 1px solid var(--border-color); border-radius: var(--radius--lg);
  background: var(--background--surface); color: var(--color--text--shade-1);
  padding: var(--spacing--sm); font: inherit;
}
.prov:hover { background: var(--background--subtle); }
.prov--selected { border-color: var(--background--brand); box-shadow: 0 0 0 1px var(--background--brand); background: var(--background--subtle); }
.prov-radio { flex: 0 0 auto; width: 1rem; height: 1rem; margin-top: 2px; border-radius: var(--radius--full); border: 2px solid var(--border-color--strong, var(--border-color)); position: relative; }
.prov--selected .prov-radio { border-color: var(--background--brand); }
.prov--selected .prov-radio::after { content: ''; position: absolute; inset: 2px; border-radius: var(--radius--full); background: var(--background--brand); }
.prov-body { display: flex; flex-direction: column; gap: var(--spacing--5xs); min-width: 0; }
.prov-top { display: flex; align-items: center; gap: var(--spacing--4xs); }
.prov-name { font-size: var(--font-size--sm); font-weight: var(--font-weight--bold); }
.prov-active { font-size: var(--font-size--4xs, var(--font-size--3xs)); font-weight: var(--font-weight--bold); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide); color: var(--text-color--success, var(--color--success)); border: 1px solid var(--border-color--success, transparent); background: var(--background--success, transparent); border-radius: var(--radius--full); padding: 0 var(--spacing--3xs); }
.prov-model { font-size: var(--font-size--3xs); }
.prov-blurb { font-size: var(--font-size--3xs); }

/* Insecure-transport + chat-unavailable notices */
.notice {
  margin: 0; display: flex; align-items: flex-start; gap: var(--spacing--4xs);
  font-size: var(--font-size--2xs); line-height: var(--line-height--md);
  padding: var(--spacing--2xs) var(--spacing--sm); border-radius: var(--radius--md);
  border: 1px solid var(--border-color--subtle);
}
.notice--warn { background: var(--background--warning, var(--background--subtle)); }
.notice .dot { flex: 0 0 auto; margin-top: 0.35em; }
.notice strong { font-weight: var(--font-weight--bold); }

/* Capability-probe verdict */
.caps { display: flex; flex-direction: column; gap: var(--spacing--4xs); border-top: 1px solid var(--border-color--subtle); padding-top: var(--spacing--sm); }
.caps-label { text-transform: uppercase; letter-spacing: var(--letter-spacing--wide); font-size: var(--font-size--3xs); }
/* A long endpoint URL must wrap, never push the page sideways at 375px (rule 10). */
.caps-endpoint { margin: 0; font-size: var(--font-size--3xs); overflow-wrap: anywhere; }
.caps-list { list-style: none; margin: var(--spacing--5xs) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing--5xs); }
.caps-list li { display: flex; align-items: center; gap: var(--spacing--4xs); font-size: var(--font-size--2xs); }
.caps-list strong { font-weight: var(--font-weight--bold); }
.caps-note { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--3xs); line-height: var(--line-height--md); }

.actions { display: flex; align-items: center; gap: var(--spacing--sm); flex-wrap: wrap; }
.run-wrap { display: flex; flex-direction: column; gap: var(--spacing--4xs); border-top: 1px solid var(--border-color--subtle); padding-top: var(--spacing--sm); }
.run-row { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm); flex-wrap: wrap; }
.run-meta { display: flex; align-items: baseline; gap: var(--spacing--4xs); flex-wrap: wrap; font-size: var(--font-size--2xs); }
.run-label { text-transform: uppercase; letter-spacing: var(--letter-spacing--wide); font-size: var(--font-size--3xs); }
.run-time { font-weight: var(--font-weight--medium); font-variant-numeric: tabular-nums; }
.run-note { margin: 0; font-size: var(--font-size--2xs); }
.ok { font-size: var(--font-size--2xs); }
.err { color: var(--text-color--danger, var(--color--danger)); font-size: var(--font-size--2xs); }

@media (max-width: 720px) {
  .prov { flex-basis: 100%; }
}
</style>
