import { z } from 'zod';

/**
 * The S7 chat contract (server ↔ web). Chat is a THIN narration layer over the
 * deterministic S1b–S6 reads (spec .agents/specs/chat.md): the model chooses which
 * existing tool to call and phrases the result — it computes nothing. Every name and
 * number in an answer comes from a tool result.
 *
 * The wire is Server-Sent Events over `POST /api/chat`. The server streams a
 * discriminated union of events; the web renders text, tool-call chips, and clickable
 * workflow references. Conversation history is passed by the client (in-memory per
 * session, not persisted).
 */

/** A workflow the tools SURFACED this turn — the ONLY thing the UI linkifies. */
export const chatWorkflowRefSchema = z.object({
  instanceId: z.string(),
  id: z.string(),
  name: z.string(),
  /** The instance's human label ("prod"/"staging") — lets the UI tell apart same-named
   * workflows on different instances. Optional (absent when a surface has no label). */
  instance: z.string().optional(),
});
export type ChatWorkflowRef = z.infer<typeof chatWorkflowRefSchema>;

/**
 * One SSE event. `text` carries an answer chunk; `tool_call`/`tool_result` drive the
 * chips; `refs` carries the workflows the tools surfaced (built from tool output, NOT
 * parsed from prose — a fabricated workflow has no ref to render); `done` ends a turn;
 * `error` reports a transport/loop failure honestly (never a fabricated answer).
 */
export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    id: z.string(),
    name: z.string(),
    /** Short human phrasing of the call for the chip, e.g. "system = Salesforce". */
    arg: z.string(),
  }),
  z.object({
    type: z.literal('tool_result'),
    id: z.string(),
    name: z.string(),
    ok: z.boolean(),
    /** Short human phrasing of the result for the chip, e.g. "5 workflows". */
    summary: z.string(),
  }),
  z.object({ type: z.literal('refs'), workflows: z.array(chatWorkflowRefSchema) }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;

/**
 * One turn of conversation. History is held SERVER-SIDE, per session (in-memory, not
 * persisted) — the client never supplies prior turns, so it cannot seed fabricated
 * "prior tool results" for the model to narrate as fact (S7 security review, Finding 1).
 */
export const chatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});
export type ChatTurn = z.infer<typeof chatTurnSchema>;

/**
 * The `POST /api/chat` request body. The client sends only the new message and an opaque
 * `conversationId` that partitions its own chat windows — the server keys history by the
 * AUTHENTICATED actor + this id, so it can never read or seed another user's context, and
 * no client-supplied history/roles are trusted.
 */
export const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  /** Opaque client-generated id for one chat window (namespaced under the actor server-side). */
  conversationId: z.string().min(1).max(200),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;
