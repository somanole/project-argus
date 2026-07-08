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

// Inline linkification: split an answer into text + workflow-reference segments, using
// ONLY the names the tools surfaced (exact, whole-name matches). Names not surfaced by a
// tool are never linkified — clickable references are grounded by construction.
type Segment = { t: 'text'; v: string } | { t: 'ref'; v: string; ref: ChatWorkflowRef };
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const refKey = (r: ChatWorkflowRef): string => `${r.instanceId}::${r.id}`;

function segmentsFor(text: string, refs: ChatWorkflowRef[]): Segment[] {
  // A name is inline-linkable ONLY if exactly one distinct workflow (instance+id) carries it.
  // Two workflows sharing a name across instances are ambiguous — we can't tell which text
  // occurrence maps to which instance, so we do NOT link them inline (they'd all point at one).
  const distinctPerName = new Map<string, Set<string>>();
  for (const r of refs) {
    const s = distinctPerName.get(r.name) ?? new Set<string>();
    s.add(refKey(r));
    distinctPerName.set(r.name, s);
  }
  const linkable = [...new Map(refs.filter((r) => (distinctPerName.get(r.name)?.size ?? 0) === 1).map((r) => [r.name, r])).values()]
    .filter((r) => r.name.trim().length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  if (!linkable.length || !text) return [{ t: 'text', v: text }];
  const re = new RegExp(`(${linkable.map((r) => escapeRe(r.name)).join('|')})`, 'g');
  const out: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    const ref = linkable.find((r) => r.name === m![0])!;
    out.push({ t: 'ref', v: m[0], ref });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

// The reference row shows every DISTINCT surfaced workflow (by instance+id, NOT by name)
// whose name is mentioned but wasn't inline-linked — so BOTH of two same-named workflows
// appear, each opening its own instance's drawer. Labeled by instance to tell them apart.
function mentionedRefs(m: { text: string; refs: ChatWorkflowRef[] }): ChatWorkflowRef[] {
  if (!m.text) return [];
  const linkedNames = new Set(segmentsFor(m.text, m.refs).filter((s) => s.t === 'ref').map((s) => (s as { ref: ChatWorkflowRef }).ref.name));
  const seen = new Set<string>();
  const out: ChatWorkflowRef[] = [];
  for (const r of m.refs) {
    if (linkedNames.has(r.name) || !m.text.includes(r.name)) continue;
    const k = refKey(r);
    if (seen.has(k)) continue; // dedup by instance+id — keep same-named-different-instance
    seen.add(k);
    out.push(r);
  }
  return out;
}

const refLabel = (r: ChatWorkflowRef): string => (r.instance ? `${r.name} (${r.instance})` : r.name);

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
      <button v-if="!isEmpty" class="btn btn--ghost btn--sm" :disabled="store.sending" @click="store.reset()">New chat</button>
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

          <!-- The answer, with clickable workflow references. -->
          <p v-if="m.text" class="text">
            <template v-for="(seg, i) in segmentsFor(m.text, m.refs)" :key="i">
              <button v-if="seg.t === 'ref'" class="wf-ref" data-testid="chat-workflow-ref" @click="openWorkflow(seg.ref)">{{ seg.v }}<span class="ext" aria-hidden="true"> ↗</span></button>
              <span v-else>{{ seg.v }}</span>
            </template>
          </p>

          <!-- Thinking indicator while the tool loop runs. -->
          <p v-if="m.streaming && !m.text" class="thinking" data-testid="chat-streaming">
            <span class="tdot" /><span class="tdot" /><span class="tdot" />
          </p>

          <!-- Fallback reference row: only workflows the answer NAMED but that weren't
               linked inline (never the whole surfaced set — that would flood on a big list). -->
          <div v-if="m.role === 'assistant' && !m.streaming && mentionedRefs(m).length" class="refrow">
            <span class="muted reflabel">Referenced:</span>
            <button v-for="r in mentionedRefs(m)" :key="r.instanceId + '/' + r.id" class="wf-ref wf-ref--pill" data-testid="chat-workflow-ref" @click="openWorkflow(r)">{{ refLabel(r) }}<span class="ext" aria-hidden="true"> ↗</span></button>
          </div>

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
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing--md); margin-bottom: var(--spacing--sm); }
.head h1 { margin: 0; }
.sub { margin: var(--spacing--4xs) 0 0; font-size: var(--font-size--2xs); max-width: 40rem; }

.messages {
  flex: 1 1 auto;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing--md);
  padding: var(--spacing--sm) var(--spacing--3xs);
}

.empty { margin: auto 0; }
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

.wf-ref {
  appearance: none;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--background--brand);
  font-weight: var(--font-weight--medium);
  cursor: pointer;
  border-bottom: 1px dotted currentColor;
}
.wf-ref:hover { opacity: 0.8; }
.wf-ref .ext { font-size: 0.85em; opacity: 0.7; }
.wf-ref--pill {
  border-bottom: 0;
  border: 1px solid var(--border-color--subtle);
  border-radius: var(--radius--full);
  padding: var(--spacing--5xs) var(--spacing--2xs);
  background: var(--background--subtle);
  font-size: var(--font-size--3xs);
}
.refrow { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing--4xs); margin-top: var(--spacing--2xs); }
.reflabel { font-size: var(--font-size--3xs); }

.thinking { display: inline-flex; gap: 4px; margin: var(--spacing--3xs) 0; }
.tdot { width: 6px; height: 6px; border-radius: var(--radius--full); background: var(--color--text--tint-1); animation: blink 1.2s infinite ease-in-out; }
.tdot:nth-child(2) { animation-delay: 0.2s; }
.tdot:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

.err { color: var(--text-color--danger, var(--color--danger)); font-size: var(--font-size--2xs); margin: var(--spacing--3xs) 0 0; }
.pad { padding: var(--spacing--2xs) 0; }

.composer { display: flex; gap: var(--spacing--2xs); align-items: flex-end; padding-top: var(--spacing--sm); border-top: 1px solid var(--border-color--subtle); }
.composer-input { flex: 1 1 auto; resize: none; min-height: 2.5rem; max-height: 8rem; font-family: inherit; }
.send { flex: none; }

@media (max-width: 30rem) {
  .chat { height: calc(100vh - 10rem); }
  .bubble { max-width: 100%; }
}
</style>
