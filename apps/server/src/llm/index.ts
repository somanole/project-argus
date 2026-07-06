/**
 * The one provider-abstracting LLM wrapper (standing rule 6, DECISION #25).
 * Callers import only from here; they never touch an adapter or provider SDK.
 */
export { createLlmClient } from './client.js';
export { redactText, redactDeep, type RedactionResult } from './redact.js';
export { zodToStrictJsonSchema, type JsonSchema } from './schema-to-jsonschema.js';
export { SpendMeter, type SpendSnapshot } from './spend.js';
export {
  LlmError,
  DEFAULT_MODELS,
  type LlmClient,
  type LlmClientConfig,
  type LlmProvider,
  type LlmErrorKind,
  type TokenUsage,
  type StructuredOutputArgs,
  type StructuredResult,
  type StreamToolLoopArgs,
  type ToolLoopEvent,
} from './types.js';
