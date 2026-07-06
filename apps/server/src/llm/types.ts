import type { ZodType } from 'zod';
import type { LlmProvider } from '@argus/shared';

/**
 * The one provider-abstracting LLM wrapper's shared types (standing rule 6, DECISION
 * #25). Every LLM call in Argus goes through the `LlmClient` interface, which hides
 * OpenAI vs Anthropic behind two stable seams:
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

// --- Seam 2: streaming tool loop. Declared for S7; bodies throw not_implemented in S2. ---
export interface StreamToolLoopArgs {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: Array<{ name: string; description: string; schema: ZodType<unknown> }>;
  maxIterations: number;
  signal?: AbortSignal | undefined;
}
export type ToolLoopEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'done' };

export interface LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  structuredOutput<T>(args: StructuredOutputArgs<T>): Promise<StructuredResult<T>>;
  streamToolLoop(args: StreamToolLoopArgs): AsyncIterable<ToolLoopEvent>;
}

export interface LlmClientConfig {
  provider: LlmProvider;
  apiKey: string;
  /** Pinned model id for this provider. */
  model: string;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** OpenAI gpt-5 family only: reasoning effort. Enrichment pins 'minimal' (probe-tuned). */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Backoff before the single retry (ms). Default 0 in tests. */
  retryDelayMs?: number;
}

/** Model pinned per provider — the fast/cheap tier (probe-confirmed). */
export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: 'gpt-5-mini',
  anthropic: 'claude-haiku-4-5',
};
