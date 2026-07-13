import type Database from 'better-sqlite3';
import { chatSupported, type ChatEvent, type ChatTurn, type ChatWorkflowRef } from '@argus/shared';
import { createLlmClient, LlmError, type LlmClient, type LlmClientConfig } from '../llm/index.js';
import { getLlmConfigRow, getDecryptedApiKey, getCapabilities } from '../settings/repo.js';
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
  /**
   * The smart-features master switch (the SAME switch that governs enrichment — Settings).
   * Chat is one of the two smart features; when the switch is off, chat makes ZERO LLM
   * calls and says so honestly. `undefined` is treated as on (backward-compat for callers
   * that predate the switch / tests that only exercise the provider path).
   */
  enabled?: boolean;
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

  // The smart-features kill switch (Settings). Off → chat is unavailable and makes ZERO
  // LLM calls; the rest of Argus is deterministic and unaffected. Checked before touching
  // the provider config so "off" short-circuits regardless of whether a key is stored.
  if (deps.enabled === false) {
    yield {
      type: 'text',
      text: 'Smart features are off, so chat is unavailable. Turn them on in Settings — the same switch that powers AI enrichment — to ask questions here. Everything else in Argus works without it.',
    };
    yield { type: 'done' };
    return;
  }

  const cfg = getLlmConfigRow(db);
  // `''` is a legal key for a keyless self-hosted endpoint — only `null` means unconfigured.
  const apiKey = cfg ? getDecryptedApiKey(db, encryptionKey) : null;
  if (!cfg || apiKey === null) {
    yield {
      type: 'text',
      text: 'Chat needs an LLM provider configured. Add one in Settings — the same provider and key Argus uses for enrichment. Everything else in Argus works without it.',
    };
    yield { type: 'done' };
    return;
  }

  // Chat needs seam 2 (tool calls). On a custom endpoint that seam is capability-probed,
  // never assumed (DECISION #30). A model that ignores `tools` would answer governance
  // questions from nothing — so we refuse, out loud, instead of guessing (rule 5).
  if (!chatSupported({ provider: cfg.provider, capabilities: getCapabilities(cfg) })) {
    yield {
      type: 'text',
      text:
        `Chat is unavailable on this provider. The configured endpoint (model "${cfg.model}") did not emit a tool call when probed, ` +
        `and chat can only answer from real tool results — never from guesses. Enrichment and the rest of Argus keep working. ` +
        `To enable chat, point the endpoint at a tool-calling model (Llama 3.1+, Qwen, Mistral); on vLLM, start it with --enable-auto-tool-choice.`,
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
  const client = factory({ provider: cfg.provider, apiKey, model: cfg.model, baseUrl: cfg.base_url ?? undefined });
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
