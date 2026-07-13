<script setup lang="ts">
/**
 * The S7 Chat view (spec .agents/specs/chat.md) — a natural-language layer over the
 * deterministic core. It renders the streamed answer, the tool-call chips (what the
 * assistant queried), and clickable workflow references (built ONLY from the workflows
 * the tools surfaced — a fabricated workflow has no link). Read-only: chat never
 * mutates; a workflow reference opens the existing detail drawer. Honest states only.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { workflowDetailSchema, type ChatWorkflowRef, type WorkflowListItem } from '@argus/shared';
import { useChatStore } from '../stores/chat';
import { api } from '../lib/api';
import ChatToolChip from '../components/ChatToolChip.vue';
import WorkflowDetailDrawer from '../components/WorkflowDetailDrawer.vue';

const store = useChatStore();
const draft = ref('');
const scroller = ref<HTMLElement | null>(null);

// A chat workflow-reference click opens the existing detail drawer. We fetch the full
// list item by instanceId+id (the drawer's contract) — no reshaping, no invented data.
const selected = ref<WorkflowListItem | null>(null);
const openError = ref<string | null>(null);

const EXAMPLES = [
  "What's failing right now, and who owns it?",
  'What happens if Sam Rivers leaves?',
  'Everything touching Salesforce that can email externally',
  'Which critical workflows have no owner?',
  "What breaks if 'Send Slack Alert' goes down?",
  "What's our governance score, and what's dragging it down?",
];

const isEmpty = computed(() => store.messages.length === 0);

async function submit(): Promise<void> {
  const text = draft.value;
  if (!text.trim() || store.sending) return;
  draft.value = '';
  await store.send(text);
}

function ask(example: string): void {
  if (store.sending) return;
  draft.value = example;
  void submit();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void submit();
  }
}

async function openWorkflow(ref: ChatWorkflowRef): Promise<void> {
  openError.value = null;
  try {
    const detail = await api(`/api/workflows/${encodeURIComponent(ref.instanceId)}/${encodeURIComponent(ref.id)}`, {}, workflowDetailSchema);
    selected.value = detail.workflow;
  } catch {
    openError.value = `Couldn't open "${ref.name}".`;
  }
}

// Workflow references live in ONE place — a "Referenced" row at the bottom of the answer,
// NOT inline. The answer prose stays clean; every distinct workflow the answer named gets
// exactly one clickable pill there, labeled by instance so two same-named workflows across
// instances stay distinct. References are grounded by construction: they come only from the
// workflow objects the tools surfaced (m.refs), never parsed out of the model's prose.
const refKey = (r: ChatWorkflowRef): string => `${r.instanceId}::${r.id}`;
const refLabel = (r: ChatWorkflowRef): string => (r.instance ? `${r.name} (${r.instance})` : r.name);

// The distinct surfaced workflows the answer actually NAMED — deduped by instance+id (so
// each workflow appears once no matter how often the prose repeats its name), and limited
// to names present in the text (so a broad tool result doesn't flood the row with workflows
// the answer never mentioned). Sorted name-then-instance for a stable, grouped reading.
function mentionedRefs(m: { text: string; refs: ChatWorkflowRef[] }): ChatWorkflowRef[] {
  if (!m.text) return [];
  const seen = new Set<string>();
  const out: ChatWorkflowRef[] = [];
  for (const r of m.refs) {
    if (!m.text.includes(r.name)) continue;
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.instance ?? '').localeCompare(b.instance ?? ''));
}

// Keep the newest message in view as it streams.
watch(
  () => store.messages.map((m) => m.text + m.tools.length + m.refs.length + (m.streaming ? '1' : '0')).join(),
  async () => {
    await nextTick();
    scroller.value?.scrollTo?.({ top: scroller.value.scrollHeight });
  },
);
</script>

<template>
  <section class="view chat" data-testid="chat-view">
    <header class="head">
      <div>
        <h1>Chat</h1>
        <p class="muted sub">Ask about the estate. Every answer is grounded in Argus's data — names and numbers come from the tools, never invented.</p>
      </div>
      <button v-if="!isEmpty" class="btn btn--secondary btn--sm" :disabled="store.sending" @click="store.reset()">New chat</button>
    </header>

    <div ref="scroller" class="messages" data-testid="chat-messages">
      <!-- Empty state: the canonical questions as one-click prompts. -->
      <div v-if="isEmpty" class="empty">
        <p class="muted">Try one of these:</p>
        <div class="examples">
          <button v-for="ex in EXAMPLES" :key="ex" class="example" data-testid="chat-example" @click="ask(ex)">{{ ex }}</button>
        </div>
      </div>

      <div v-for="m in store.messages" :key="m.id" class="msg" :class="`msg--${m.role}`" data-testid="chat-message">
        <div class="bubble">
          <!-- Tool-call chips (assistant only): what it queried. -->
          <div v-if="m.tools.length" class="chips">
            <ChatToolChip v-for="c in m.tools" :key="c.id" :chip="c" />
          </div>

          <!-- Referenced workflows, right under the tool chips: ONE place for every workflow
               the answer named — each a clickable pill (labeled by instance so same-named
               workflows stay distinct), opening its own detail drawer. Deduped, so a name
               repeated in the prose is listed once. Built only from tool-surfaced refs,
               never parsed from prose. Sits above the answer so it needs no scrolling. -->
          <div v-if="m.role === 'assistant' && !m.streaming && mentionedRefs(m).length" class="refrow" data-testid="chat-refs">
            <span class="muted reflabel">Referenced</span>
            <button v-for="r in mentionedRefs(m)" :key="r.instanceId + '/' + r.id" class="wf-ref" data-testid="chat-workflow-ref" @click="openWorkflow(r)">{{ refLabel(r) }}<span class="ext" aria-hidden="true"> ↗</span></button>
          </div>

          <!-- The answer as clean prose — no inline links. -->
          <p v-if="m.text" class="text">{{ m.text }}</p>

          <!-- Thinking indicator while the tool loop runs. -->
          <p v-if="m.streaming && !m.text" class="thinking" data-testid="chat-streaming">
            <span class="tdot" /><span class="tdot" /><span class="tdot" />
          </p>

          <p v-if="m.error" class="err" role="alert">{{ m.error }}</p>
        </div>
      </div>

      <p v-if="openError" class="err pad" role="alert">{{ openError }}</p>
    </div>

    <form class="composer" @submit.prevent="submit">
      <textarea
        v-model="draft"
        class="input composer-input"
        data-testid="chat-input"
        rows="1"
        placeholder="Ask about workflows, owners, failures, blast radius…"
        :disabled="store.sending"
        @keydown="onKeydown"
      />
      <button class="btn btn--primary send" data-testid="chat-send" type="submit" :disabled="store.sending || !draft.trim()">
        {{ store.sending ? '…' : 'Send' }}
      </button>
    </form>

    <WorkflowDetailDrawer :selected="selected" @close="selected = null" />
  </section>
</template>

<style scoped>
.chat {
  max-width: 56rem;
  display: flex;
  flex-direction: column;
  /* Fill the content area so the composer sits at the bottom; never overflow the page. */
  height: calc(100vh - 8rem);
  min-height: 24rem;
}
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--md); margin-bottom: var(--spacing--sm); flex-wrap: wrap; }
.head h1 { margin: 0; font-size: var(--font-size--xl); font-weight: var(--font-weight--bold); }
.sub { margin: var(--spacing--5xs) 0 0; font-size: var(--font-size--sm); max-width: 40rem; }

.messages {
  flex: 1 1 auto;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing--md);
  padding: var(--spacing--sm) var(--spacing--3xs);
}

/* Anchor the starter prompts just above the composer (not dead-centre in the scroll
   area) — they sit where the eye goes to type, instead of floating in a void below
   the header. */
.empty { margin-top: auto; }
.examples { display: flex; flex-direction: column; gap: var(--spacing--2xs); margin-top: var(--spacing--2xs); align-items: flex-start; }
.example {
  appearance: none;
  text-align: left;
  border: 1px solid var(--border-color--subtle);
  background: var(--background--subtle);
  color: var(--color--text--shade-1);
  border-radius: var(--radius--md);
  padding: var(--spacing--2xs) var(--spacing--sm);
  font: inherit;
  font-size: var(--font-size--sm);
  cursor: pointer;
  max-width: 100%;
}
.example:hover { background: var(--background--hover); }

.msg { display: flex; }
.msg--user { justify-content: flex-end; }
.msg--assistant { justify-content: flex-start; }
.bubble {
  max-width: 90%;
  min-width: 0;
  padding: var(--spacing--2xs) var(--spacing--sm);
  border-radius: var(--radius--lg);
  border: 1px solid var(--border-color--subtle);
  background: var(--background--surface);
}
.msg--user .bubble { background: var(--background--brand); color: var(--color--neutral-white); border-color: transparent; }
.msg--user .text { color: var(--color--neutral-white); }

.chips { display: flex; flex-wrap: wrap; gap: var(--spacing--4xs); margin-bottom: var(--spacing--2xs); }

.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--font-size--sm); line-height: 1.55; }

/* Referenced-workflows row: one place for every workflow the answer named, each a small
   clickable pill labeled by name + instance. Sits under the tool chips, above the prose,
   set off from the answer by a hairline below it. */
.refrow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing--4xs);
  margin-bottom: var(--spacing--2xs);
  padding-bottom: var(--spacing--2xs);
  border-bottom: 1px solid var(--border-color--subtle);
}
.reflabel {
  font-size: var(--font-size--3xs);
  text-transform: uppercase;
  letter-spacing: var(--letter-spacing--wide);
}
.wf-ref {
  appearance: none;
  font: inherit;
  cursor: pointer;
  color: var(--background--brand);
  font-weight: var(--font-weight--medium);
  border: 1px solid var(--border-color--subtle);
  border-radius: var(--radius--full);
  padding: var(--spacing--5xs) var(--spacing--2xs);
  background: var(--background--subtle);
  font-size: var(--font-size--3xs);
  line-height: 1.4;
}
.wf-ref:hover { background: var(--background--hover); }
.wf-ref .ext { font-size: 0.85em; opacity: 0.7; }

.thinking { display: inline-flex; gap: 4px; margin: var(--spacing--3xs) 0; }
.tdot { width: 6px; height: 6px; border-radius: var(--radius--full); background: var(--color--text--tint-1); animation: blink 1.2s infinite ease-in-out; }
.tdot:nth-child(2) { animation-delay: 0.2s; }
.tdot:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

.err { color: var(--color--danger); font-size: var(--font-size--2xs); margin: var(--spacing--3xs) 0 0; }
.pad { padding: var(--spacing--2xs) 0; }

.composer { display: flex; gap: var(--spacing--2xs); align-items: flex-end; padding-top: var(--spacing--sm); border-top: 1px solid var(--border-color--subtle); }
.composer-input { flex: 1 1 auto; resize: none; min-height: 2.5rem; max-height: 8rem; font-family: inherit; }
.send { flex: none; }

@media (max-width: 30rem) {
  .chat { height: calc(100vh - 10rem); }
  .bubble { max-width: 100%; }
}
</style>
