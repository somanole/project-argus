import type Database from 'better-sqlite3';
import type { ChatEvent, ChatTurn, ChatWorkflowRef } from '@argus/shared';
import { createLlmClient, LlmError, type LlmClient, type LlmClientConfig } from '../llm/index.js';
import { getLlmConfigRow, getDecryptedApiKey } from '../settings/repo.js';
import { buildChatTools } from './tools.js';
import { CHAT_SYSTEM_PROMPT } from './prompt.js';

/**
 * The S7 chat orchestrator (spec .agents/specs/chat.md). It runs the ONE wrapper's
 * streaming tool loop over the chat tools and maps the generic ToolLoopEvents to
 * client-facing ChatEvents, injecting a `refs` event with the workflows the tools
 * surfaced (the only things the UI linkifies — faithfulness by construction). It uses
 * the SAME provider config Argus uses for enrichment (Settings); if none is configured
 * it says so honestly rather than failing. It NEVER writes — read-only tools only.
 */
export interface ChatDeps {
  db: Database.Database;
  encryptionKey: string;
  /** Opt-in (default off): egress owner/actor emails in tool results (DECISION #29). */
  egressEmails?: boolean;
  /** Injectable for tests (a stub client with no network); defaults to the real wrapper. */
  clientFactory?: (cfg: LlmClientConfig) => LlmClient;
}

/** The new message plus the SERVER-HELD history (never client-supplied — Finding 1). */
export interface ChatTurnInput {
  message: string;
  history?: ChatTurn[];
}

const MAX_ITERATIONS = 8;

export async function* runChat(deps: ChatDeps, input: ChatTurnInput, signal?: AbortSignal): AsyncIterable<ChatEvent> {
  const { db, encryptionKey } = deps;
  const cfg = getLlmConfigRow(db);
  const apiKey = cfg ? getDecryptedApiKey(db, encryptionKey) : null;
  if (!cfg || !apiKey) {
    yield {
      type: 'text',
      text: 'Chat needs an LLM provider configured. Add one in Settings — the same provider and key Argus uses for enrichment. Everything else in Argus works without it.',
    };
    yield { type: 'done' };
    return;
  }

  // Collect the workflows the tools surface, deduped — the UI's only link source.
  const refs: ChatWorkflowRef[] = [];
  const seen = new Set<string>();
  const recordRefs = (list: ChatWorkflowRef[]): void => {
    for (const r of list) {
      const k = `${r.instanceId}:${r.id}`;
      if (!seen.has(k)) {
        seen.add(k);
        refs.push(r);
      }
    }
  };

  const tools = buildChatTools(db, recordRefs, { egressEmails: deps.egressEmails ?? false });
  // Chat calls are per-iteration tool-selection turns over a large tool set — allow more
  // headroom than a single enrichment call (default 30s) before we time out honestly.
  const factory = deps.clientFactory ?? ((c) => createLlmClient({ ...c, timeoutMs: 90_000, retryDelayMs: 1000 }));
  const client = factory({ provider: cfg.provider, apiKey, model: cfg.model });
  // History is server-held; roles are ours (user/assistant), never client-asserted.
  const messages = [...(input.history ?? []), { role: 'user' as const, content: input.message }];

  let flushed = 0;
  const flushRefs = function* (): Generator<ChatEvent> {
    if (refs.length > flushed) {
      yield { type: 'refs', workflows: refs.slice(flushed) };
      flushed = refs.length;
    }
  };

  try {
    for await (const ev of client.streamToolLoop({ system: CHAT_SYSTEM_PROMPT, messages, tools, maxIterations: MAX_ITERATIONS, signal })) {
      if (ev.type === 'tool_call') {
        yield { type: 'tool_call', id: ev.id, name: ev.name, arg: describeCall(ev.input) };
      } else if (ev.type === 'tool_result') {
        yield { type: 'tool_result', id: ev.id, name: ev.name, ok: ev.ok, summary: ev.summary };
        yield* flushRefs();
      } else if (ev.type === 'text') {
        yield { type: 'text', text: ev.text };
      } else if (ev.type === 'done') {
        yield* flushRefs();
        yield { type: 'done' };
      }
    }
  } catch (err) {
    yield { type: 'error', message: friendlyError(err) };
    yield { type: 'done' };
  }
}

/** A short chip label from the model's tool arguments (non-empty fields only). */
function describeCall(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) parts.push(`${k} = ${v.trim()}`);
    else if (Array.isArray(v) && v.length) parts.push(`${k} = ${v.join(', ')}`);
    else if (typeof v === 'number') parts.push(`${k} = ${v}`);
    else if (typeof v === 'string' && v && v !== 'any' && v !== 'all') parts.push(`${k} = ${v}`);
  }
  const label = parts.join(', ');
  return label.length > 80 ? `${label.slice(0, 77)}…` : label;
}

/** Provider failures become one honest sentence — never a fabricated answer. */
function friendlyError(err: unknown): string {
  if (err instanceof LlmError) {
    switch (err.kind) {
      case 'auth':
        return 'The configured LLM API key was rejected. Check the provider key in Settings.';
      case 'rate_limit':
      case 'overloaded':
        return 'The LLM provider is busy right now. Please try again in a moment.';
      case 'timeout':
        return 'That took too long and timed out. Try a narrower question.';
      default:
        return 'Something went wrong reaching the LLM provider. Please try again.';
    }
  }
  return 'Something went wrong answering that. Please try again.';
}
