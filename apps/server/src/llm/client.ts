import { createOpenAiAdapter } from './adapters/openai.js';
import { createAnthropicAdapter } from './adapters/anthropic.js';
import { LlmError, type LlmClient, type LlmClientConfig, type StructuredOutputArgs, type StructuredResult } from './types.js';

/**
 * The one entry point (standing rule 6): pick the provider adapter and wrap its
 * structured-output seam with a single retry on RETRYABLE failures (rate_limit /
 * overloaded / timeout). Non-retryable errors (auth, schema_parse) surface immediately;
 * the caller (enrich.ts) turns a final failure into a labelled STUB, never a guess.
 *
 * `openai` and `openai_compatible` share the OpenAI-wire adapter (DECISION #30); the
 * adapter reads `provider` to decide destination, auth header, and token-cap field.
 * An exhaustive switch — never a ternary that would silently route a new provider to
 * the wrong adapter.
 */
export function createLlmClient(config: LlmClientConfig): LlmClient {
  const base = adapterFor(config);
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

function adapterFor(config: LlmClientConfig): LlmClient {
  switch (config.provider) {
    case 'openai':
    case 'openai_compatible':
      return createOpenAiAdapter(config);
    case 'anthropic':
      return createAnthropicAdapter(config);
    default: {
      // Exhaustiveness: a new provider must claim an adapter here, not inherit one.
      const never: never = config.provider;
      throw new LlmError('unknown', `no adapter for provider "${String(never)}"`, false);
    }
  }
}
