import type { ZodType } from 'zod';
import { HOSTED_PROVIDERS, type LlmProvider } from '@argus/shared';

/**
 * The one provider-abstracting LLM wrapper's shared types (standing rule 6, DECISIONS
 * #25 + #30). Every LLM call in Argus goes through the `LlmClient` interface, which hides
 * OpenAI vs Anthropic vs any OpenAI-compatible endpoint behind two stable seams:
 *   1. structuredOutput — a Zod-validated object (used by S2 enrichment).
 *   2. streamToolLoop   — a streaming tool loop (declared now, built in S7 chat).
 * Callers never see provider specifics.
 */

export type { LlmProvider };

/** Classification of an LLM failure. `retryable` drives the client's retry-once. */
export type LlmErrorKind =
  | 'auth' // bad/again missing key — never retry
  | 'rate_limit' // 429 — retryable
  | 'overloaded' // 5xx / provider overloaded — retryable
  | 'timeout' // request timed out — retryable
  | 'schema_parse' // model returned unparseable / schema-invalid / a refusal — not retryable here
  | 'not_implemented' // seam not built yet (streamToolLoop until S7)
  | 'unknown';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface StructuredOutputArgs<T> {
  /** System prompt (instructions). */
  system: string;
  /** User content — workflow-derived text, delimited as DATA (injection posture). */
  user: string;
  /** The Zod schema the result MUST satisfy; also drives the strict JSON schema sent. */
  schema: ZodType<T>;
  /** A stable name for the schema (provider requires one). */
  schemaName: string;
  /** Output token ceiling. */
  maxTokens: number;
  /** Caller cancellation (composed with the client's own timeout). */
  signal?: AbortSignal | undefined;
}

export interface StructuredResult<T> {
  value: T;
  usage: TokenUsage;
}

// --- Seam 2: streaming tool loop (S7 chat). One manual loop, both providers. ---

/**
 * A tool the model may call during the loop. `execute` runs the DETERMINISTIC read and
 * returns the data fed back to the model — the seam stays domain-agnostic; the caller
 * (chat) supplies tools that wrap Argus's own reads. `execute` receives schema-VALIDATED
 * input; a thrown error is surfaced to the model as a tool error (rule 5: "couldn't
 * analyze"), never as an invented result. `summarize` shapes the chip's result label.
 */
export interface LlmTool {
  name: string;
  description: string;
  schema: ZodType<unknown>;
  execute: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
  /** Short human phrasing of the result for the tool-call chip; default is generic. */
  summarize?: (result: unknown) => string;
}

export interface StreamToolLoopArgs {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: LlmTool[];
  /** Hard cap on model↔tool round-trips (PLAN: 8). */
  maxIterations: number;
  /** Output token ceiling per model call. */
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * A streamed step of the loop. `tool_call`/`tool_result` are paired by `id` and drive
 * the chips; `text` is answer content (emitted once the model stops calling tools);
 * `done` ends the turn with accumulated usage.
 */
export type ToolLoopEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'done'; usage: TokenUsage };

export interface LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  structuredOutput<T>(args: StructuredOutputArgs<T>): Promise<StructuredResult<T>>;
  streamToolLoop(args: StreamToolLoopArgs): AsyncIterable<ToolLoopEvent>;
}

export interface LlmClientConfig {
  provider: LlmProvider;
  /**
   * The provider key. EMPTY STRING is legal for `openai_compatible` only — self-hosted
   * endpoints are commonly keyless, and we then omit the Authorization header entirely
   * (contracts/llm-openai-compatible.json → keyless_no_auth_header).
   */
  apiKey: string;
  /** Model id. Pinned by us for the hosted providers; user-chosen for openai_compatible. */
  model: string;
  /**
   * REQUIRED for `openai_compatible`: the OpenAI-shaped API root, already validated +
   * normalized by `checkBaseUrl` (e.g. `http://127.0.0.1:11434/v1`). Ignored otherwise.
   */
  baseUrl?: string | undefined;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** OpenAI gpt-5 family only: reasoning effort. Enrichment pins 'minimal' (probe-tuned). */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Backoff before the single retry (ms). Default 0 in tests. */
  retryDelayMs?: number;
}

/**
 * Model pinned per provider — the fast/cheap tier (probe-confirmed). `openai_compatible`
 * is absent BY DESIGN: its model is customer-chosen, so we have no default to offer and
 * must never invent one (rule 5).
 */
export const DEFAULT_MODELS: Record<(typeof HOSTED_PROVIDERS)[number], string> = {
  openai: 'gpt-5-mini',
  anthropic: 'claude-haiku-4-5',
};

/** Result of capability-probing the two seams against a configured endpoint. */
export interface CapabilityProbeResult {
  structuredOutput: boolean;
  streamingToolCalls: boolean;
  note: string | null;
}
