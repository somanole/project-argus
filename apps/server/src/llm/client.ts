import { createOpenAiAdapter } from './adapters/openai.js';
import { createAnthropicAdapter } from './adapters/anthropic.js';
import { LlmError, type LlmClient, type LlmClientConfig, type StructuredOutputArgs, type StructuredResult } from './types.js';

/**
 * The one entry point (standing rule 6): pick the provider adapter and wrap its
 * structured-output seam with a single retry on RETRYABLE failures (rate_limit /
 * overloaded / timeout). Non-retryable errors (auth, schema_parse) surface immediately;
 * the caller (enrich.ts) turns a final failure into a labelled STUB, never a guess.
 */
export function createLlmClient(config: LlmClientConfig): LlmClient {
  const base = config.provider === 'openai' ? createOpenAiAdapter(config) : createAnthropicAdapter(config);
  const retryDelayMs = config.retryDelayMs ?? 0;

  return {
    provider: base.provider,
    model: base.model,

    async structuredOutput<T>(args: StructuredOutputArgs<T>): Promise<StructuredResult<T>> {
      try {
        return await base.structuredOutput(args);
      } catch (err) {
        if (err instanceof LlmError && err.retryable) {
          if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
          return await base.structuredOutput(args); // retry once
        }
        throw err;
      }
    },

    streamToolLoop: base.streamToolLoop.bind(base),
  };
}
