<script setup lang="ts">
/**
 * "What's sent to the provider" — the informed-consent side drawer for smart features.
 * It's the in-app mirror of the two owner sign-off docs (docs/DATA-FLOW.md for enrichment,
 * docs/DATA-FLOW-CHAT.md for chat): what leaves, what never leaves, and the guarantees —
 * so the owner can decide BEFORE enabling. Plain English, tokens-only, both themes. If any
 * of those docs' egress facts change, this drawer changes in the same session (rule 9).
 */
defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
</script>

<template>
  <div v-if="open" class="scrim" tabindex="-1" data-testid="egress-drawer" @click.self="emit('close')" @keydown="onKeydown">
    <aside class="drawer" role="dialog" aria-label="What's sent to the provider">
      <header class="d-head">
        <h2>What's sent to the provider</h2>
        <button class="btn btn--ghost btn--sm close" aria-label="Close" @click="emit('close')">✕</button>
      </header>

      <div class="d-body">
        <p class="intro">
          One provider — the one you choose below — powers both smart features. Your API key is
          <strong>encrypted at rest and never sent back</strong>, and Argus is <strong>read-only</strong>
          against n8n. With a <strong>self-hosted endpoint, none of this leaves your network</strong>.
        </p>

        <!-- Enrichment: the narrow surface (one workflow → one small payload). -->
        <section class="feat" data-testid="egress-enrichment">
          <h3>Enrichment</h3>
          <p class="muted lead">One workflow → one small payload, per workflow.</p>
          <p class="line line--yes">
            <span class="dot dot--ok" />
            <span><strong>Sent:</strong> workflow &amp; node names, tags, trigger &amp; node <span class="mono">types</span>, systems, credential <span class="mono">types</span>, topology counts, failure stats.</span>
          </p>
          <p class="line line--no">
            <span class="dot dot--danger" />
            <span><strong>Never:</strong> node parameter values, URLs or hostnames, credential values or names, API keys, pinned or execution data.</span>
          </p>
        </section>

        <!-- Chat: the wider surface (your question + tool results over a tool loop). -->
        <section class="feat" data-testid="egress-chat">
          <h3>Chat <span class="muted tag">wider surface</span></h3>
          <p class="muted lead">Your question, plus tool results, over up to 8 tool calls per turn.</p>
          <p class="line line--yes">
            <span class="dot dot--ok" />
            <span><strong>Sent:</strong> your message, the conversation so far, workflow &amp; owner <strong>names</strong>, and governance metadata (health, criticality, systems, counts, scores).</span>
          </p>
          <p class="line line--no">
            <span class="dot dot--danger" />
            <span><strong>Never:</strong> credential values or keys, raw URLs, hostnames, webhook paths, expression strings, execution payloads, or owner &amp; actor emails (off by default).</span>
          </p>
        </section>

        <!-- The guarantees that hold for both. -->
        <section class="guarantees">
          <p class="line">
            <span class="dot dot--ok" />
            <span>Every value is <strong>secret-scrubbed</strong> on the way out — a key or token pasted into any text becomes <span class="mono">[REDACTED]</span>.</span>
          </p>
          <p class="line">
            <span class="dot dot--ok" />
            <span><strong>Kill switch:</strong> turn smart features off and Argus makes <strong>zero</strong> LLM calls and runs fully deterministic.</span>
          </p>
          <p class="line">
            <span class="dot dot--ok" />
            <span>All of the above is <strong>enforced by tests</strong> in <span class="mono">pnpm verify</span>, not just documented.</span>
          </p>
        </section>

        <p class="dest muted">
          Destination: whichever provider is active — OpenAI, Anthropic, or your own OpenAI-compatible
          endpoint. Only one is active at a time, and it's the only host contacted. A plain
          <span class="mono">http://</span> endpoint means the payload travels unencrypted across your network.
        </p>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--color--text--shade-1) 32%, transparent);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}
.drawer {
  width: min(34rem, 94vw);
  height: 100%;
  overflow-y: auto;
  background: var(--background--surface);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow--lg, none);
}
.d-head {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm);
  padding: var(--spacing--md) var(--spacing--lg);
  background: var(--background--surface);
  border-bottom: 1px solid var(--border-color--subtle);
}
.d-head h2 { margin: 0; font-size: var(--font-size--lg); font-weight: var(--font-weight--bold); }
.close { font-size: var(--font-size--md); line-height: 1; }
.d-body { display: flex; flex-direction: column; gap: var(--spacing--md); padding: var(--spacing--md) var(--spacing--lg) var(--spacing--lg); }

.intro { margin: 0; font-size: var(--font-size--sm); line-height: var(--line-height--md); }
.intro strong { font-weight: var(--font-weight--bold); }

.feat { display: flex; flex-direction: column; gap: var(--spacing--3xs); border: 1px solid var(--border-color--subtle); border-radius: var(--radius--lg); padding: var(--spacing--sm) var(--spacing--md); }
.feat h3 { margin: 0; font-size: var(--font-size--md); font-weight: var(--font-weight--bold); display: flex; align-items: center; gap: var(--spacing--4xs); }
.tag { font-size: var(--font-size--3xs); font-weight: var(--font-weight--regular); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide); }
.lead { margin: 0 0 var(--spacing--3xs); font-size: var(--font-size--2xs); }

.guarantees { display: flex; flex-direction: column; gap: var(--spacing--3xs); border-top: 1px solid var(--border-color--subtle); padding-top: var(--spacing--md); }

.line { margin: 0; display: flex; align-items: flex-start; gap: var(--spacing--4xs); font-size: var(--font-size--2xs); line-height: var(--line-height--md); }
.line .dot { flex: 0 0 auto; margin-top: 0.4em; }
.line strong { font-weight: var(--font-weight--bold); }

.dest { margin: 0; font-size: var(--font-size--3xs); line-height: var(--line-height--md); }
</style>
