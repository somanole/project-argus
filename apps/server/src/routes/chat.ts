import { Router } from 'express';
import type Database from 'better-sqlite3';
import { chatRequestSchema } from '@argus/shared';
import { runChat } from '../chat/service.js';
import { actorOf } from '../auth/middleware.js';
import { getEnrichmentEnabled } from '../settings/repo.js';
import type { ChatSessionStore } from '../chat/session.js';

/**
 * The S7 chat API (spec .agents/specs/chat.md). `POST /api/chat` streams a grounded
 * answer over Server-Sent Events (no compression, server origin) behind the session
 * guard. Read-only: it runs the chat tool loop over the deterministic S1b–S6 reads and
 * forwards each event; it mutates nothing.
 *
 * Conversation history is held SERVER-SIDE (Finding 1): keyed by the AUTHENTICATED actor
 * + the client's opaque `conversationId`, so a client can neither read another user's
 * context nor inject fabricated prior turns. The client sends only the new message.
 */
export function chatRouter(db: Database.Database, encryptionKey: string, egressEmails: boolean, sessions: ChatSessionStore, envAllowed: boolean): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid chat request (message required ≤2000 chars, conversationId required)' });
      return;
    }
    const { message, conversationId } = parsed.data;

    // Namespace history under the SERVER-VALIDATED actor — never anything client-asserted.
    const actor = actorOf(res);
    const key = `${actor.email}::${conversationId}`;
    const history = sessions.get(key);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
    res.flushHeaders?.();

    const ac = new AbortController();
    res.on('close', () => ac.abort());

    // The smart-features switch is read per request (env override AND the in-app master
    // switch), so flipping it in Settings takes effect immediately — including mid-session.
    const enabled = envAllowed && getEnrichmentEnabled(db);

    let answer = '';
    let errored = false;
    try {
      for await (const ev of runChat({ db, encryptionKey, enabled, egressEmails }, { message, history }, ac.signal)) {
        if (ev.type === 'text') answer += ev.text;
        if (ev.type === 'error') errored = true;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      // Persist the turn server-side only on a clean, non-error completion — so the stored
      // history is always real (user question + the model's own grounded answer), never a
      // client-supplied or error turn.
      if (!errored && answer.trim()) {
        sessions.append(key, { role: 'user', content: message });
        sessions.append(key, { role: 'assistant', content: answer });
      }
    } catch {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'error', message: 'The chat stream failed unexpectedly.' })}\n\n`);
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}
