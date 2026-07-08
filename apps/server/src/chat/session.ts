import type { ChatTurn } from '@argus/shared';

/**
 * Server-side, in-memory chat history (S7 security review, Finding 1; PLAN: "in-memory
 * per session; not persisted"). Conversation history is NEVER accepted from the client —
 * the client cannot inject fabricated prior turns for the model to narrate as fact, so
 * the faithfulness guarantee (invented facts = 0) and the redaction/egress controls hold
 * across a whole conversation, not just the current turn.
 *
 * Only user messages and the assistant's final answers are stored — never raw tool
 * results — so nothing that skipped the current turn's redaction can be replayed. Keys are
 * namespaced by the AUTHENTICATED actor (see the route), so one user can never read
 * another's context. Bounded in turns-per-session and total sessions; lost on restart.
 */
const MAX_TURNS = 20; // the recent window kept as context
const MAX_SESSIONS = 1000; // memory backstop; oldest session evicted first

export interface ChatSessionStore {
  get(key: string): ChatTurn[];
  append(key: string, turn: ChatTurn): void;
  reset(key: string): void;
}

export function createChatSessionStore(): ChatSessionStore {
  // Insertion-ordered Map → evict the oldest session when over the cap.
  const sessions = new Map<string, ChatTurn[]>();

  return {
    get(key) {
      return sessions.get(key) ?? [];
    },
    append(key, turn) {
      let arr = sessions.get(key);
      if (!arr) {
        if (sessions.size >= MAX_SESSIONS) {
          const oldest = sessions.keys().next().value;
          if (oldest !== undefined) sessions.delete(oldest);
        }
        arr = [];
        sessions.set(key, arr);
      }
      arr.push(turn);
      if (arr.length > MAX_TURNS) arr.splice(0, arr.length - MAX_TURNS);
    },
    reset(key) {
      sessions.delete(key);
    },
  };
}
