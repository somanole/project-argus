import { checkBaseUrl } from '../../packages/shared/src/index.js';
import { DEFAULT_MODELS, type LlmClientConfig, type LlmProvider } from '../../apps/server/src/llm/index.js';

/**
 * The eval harnesses' provider selection, in one place (DECISION #25: one pre-registered
 * bar, reported PER PROVIDER — never a per-provider target).
 *
 *   pnpm eval                                   # OpenAI (the reference provider)
 *   pnpm eval --provider anthropic
 *   pnpm eval --provider openai_compatible      # a customer-chosen endpoint + model
 *
 * For `openai_compatible` the MODEL IS CUSTOMER-CHOSEN, so H1 cannot be pre-certified:
 * the bar is a property of Argus's prompt AND the model behind the endpoint. We measure
 * it against reference open-weight models and report the model alongside the score
 * (DECISION #30). A score from one open-weight model says nothing about another.
 *
 * Config comes from .env:
 *   OPENAI_API_KEY · ANTHROPIC_API_KEY
 *   ARGUS_LLM_BASE_URL  (required for openai_compatible, e.g. http://127.0.0.1:11434/v1)
 *   ARGUS_LLM_MODEL     (required for openai_compatible, e.g. llama3.1:8b)
 *   ARGUS_LLM_API_KEY   (optional — self-hosted endpoints are usually keyless)
 */
export interface EvalProvider {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string | undefined;
  /** A human label for the scorecard header — names the destination honestly. */
  label: string;
  /** True when H1 cannot be pre-certified because the model is customer-chosen. */
  customerChosenModel: boolean;
}

const PROVIDERS: readonly LlmProvider[] = ['openai', 'anthropic', 'openai_compatible'];

export function resolveEvalProvider(argv: string[]): EvalProvider {
  const i = argv.indexOf('--provider');
  const raw = i >= 0 ? argv[i + 1] : 'openai';
  if (!PROVIDERS.includes(raw as LlmProvider)) {
    fail(`Unknown --provider "${raw}". One of: ${PROVIDERS.join(', ')}.`);
  }
  const provider = raw as LlmProvider;

  if (provider === 'openai_compatible') {
    const baseUrl = process.env.ARGUS_LLM_BASE_URL;
    const model = process.env.ARGUS_LLM_MODEL;
    if (!baseUrl || !model) {
      fail('openai_compatible needs ARGUS_LLM_BASE_URL and ARGUS_LLM_MODEL in .env (e.g. http://127.0.0.1:11434/v1 and llama3.1:8b).');
    }
    const check = checkBaseUrl(baseUrl as string);
    if (!check.ok) fail(`ARGUS_LLM_BASE_URL is invalid: ${check.reason}`);
    return {
      provider,
      // Keyless is normal for a self-hosted endpoint.
      apiKey: process.env.ARGUS_LLM_API_KEY ?? '',
      model: model as string,
      baseUrl: check.normalized as string,
      label: `${provider} · ${model} @ ${check.normalized}`,
      customerChosenModel: true,
    };
  }

  const envVar = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const apiKey = process.env[envVar];
  if (!apiKey) fail(`No ${envVar} in .env — cannot run the eval for ${provider}.`);
  const model = DEFAULT_MODELS[provider];
  return { provider, apiKey: apiKey as string, model, baseUrl: undefined, label: `${provider} · ${model}`, customerChosenModel: false };
}

/** The client config for this provider — reasoningEffort is inert off hosted OpenAI. */
export function evalClientConfig(p: EvalProvider): LlmClientConfig {
  return { provider: p.provider, apiKey: p.apiKey, model: p.model, baseUrl: p.baseUrl, reasoningEffort: 'minimal', retryDelayMs: 1000 };
}

/**
 * The honesty line printed with every openai_compatible scorecard. H1 is a joint property
 * of prompt + model; a customer-chosen model was never pre-certified against it.
 */
export function h1Caveat(p: EvalProvider): string | null {
  if (!p.customerChosenModel) return null;
  return `NOTE: H1 was pre-registered against the reference provider. "${p.model}" is customer-chosen, so this score certifies THIS model on THIS endpoint — nothing more. A different open-weight model can score very differently on the same prompt.`;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
