import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ChatWorkflowRef } from '@argus/shared';
import { streamChat } from '../lib/chatStream';

/**
 * The S7 chat session (spec .agents/specs/chat.md). Holds the in-memory conversation
 * (not persisted) and drives one streamed turn at a time over `POST /api/chat`. The
 * store only accumulates what the server streams — text, tool-call chips, and the
 * workflow refs the tools surfaced (the ONLY things the UI linkifies). It invents
 * nothing (rule 5): a transport failure becomes a visible error on the message.
 */
export interface ChatToolChip {
  id: string;
  name: string;
  arg: string;
  ok: boolean | null;
  summary: string | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: ChatToolChip[];
  refs: ChatWorkflowRef[];
  streaming: boolean;
  error: string | null;
}

/** A per-conversation id (history lives server-side, keyed by actor + this — Finding 1). */
function newConversationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([]);
  const sending = ref(false);
  let seq = 0;
  // The server holds history; the client only tags which conversation this is. "New chat"
  // starts a fresh id, so the server's history for the old one is simply left behind.
  let conversationId = newConversationId();

  function reset(): void {
    messages.value = [];
    conversationId = newConversationId();
  }

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || sending.value) return;

    messages.value.push({ id: `u${seq++}`, role: 'user', text: trimmed, tools: [], refs: [], streaming: false, error: null });
    const assistant: ChatMessage = { id: `a${seq++}`, role: 'assistant', text: '', tools: [], refs: [], streaming: true, error: null };
    messages.value.push(assistant);
    sending.value = true;

    try {
      for await (const ev of streamChat({ message: trimmed, conversationId })) {
        if (ev.type === 'text') {
          assistant.text += ev.text;
        } else if (ev.type === 'tool_call') {
          assistant.tools.push({ id: ev.id, name: ev.name, arg: ev.arg, ok: null, summary: null });
        } else if (ev.type === 'tool_result') {
          const chip = assistant.tools.find((t) => t.id === ev.id);
          if (chip) {
            chip.ok = ev.ok;
            chip.summary = ev.summary;
          }
        } else if (ev.type === 'refs') {
          for (const w of ev.workflows) {
            if (!assistant.refs.some((r) => r.instanceId === w.instanceId && r.id === w.id)) assistant.refs.push(w);
          }
        } else if (ev.type === 'error') {
          assistant.error = ev.message;
        }
      }
    } catch (err) {
      assistant.error = err instanceof Error ? err.message : 'the chat request failed';
    } finally {
      assistant.streaming = false;
      sending.value = false;
    }
  }

  return { messages, sending, send, reset };
});
