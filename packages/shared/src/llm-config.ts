import { z } from 'zod';

/**
 * The LLM provider configuration contract (server ↔ web). One active provider at a
 * time; the user brings their own key, stored ENCRYPTED at rest (like n8n API keys)
 * and NEVER returned by any API (standing rule 6, DECISION #25). The write schema
 * carries the key; the read (safe view) schema never does.
 *
 * Three providers (DECISION #30): the two hosted ones, plus `openai_compatible` — the
 * OpenAI wire format against a user-supplied base URL (vLLM / TGI / Ollama / LM Studio /
 * a corporate gateway). Pointed at an in-VPC endpoint, no estate data leaves the
 * customer's network. Its API key is OPTIONAL (self-hosted endpoints are often keyless)
 * and its model is user-chosen, so nothing about it can be pinned by us.
 */

export const llmProviderSchema = z.enum(['openai', 'anthropic', 'openai_compatible']);
export type LlmProvider = z.infer<typeof llmProviderSchema>;

/** Providers whose endpoint + model Argus pins itself. */
export const HOSTED_PROVIDERS = ['openai', 'anthropic'] as const;

/**
 * Base-URL validation — an SSRF-adjacent surface: the API key is sent to whatever host
 * is configured (DECISION #30). We validate the SCHEME and reject embedded credentials.
 *
 * We deliberately DO NOT block private/loopback addresses: pointing at an in-VPC
 * `http://10.x` vLLM is the entire point of this provider. `http://` is therefore
 * allowed, but it means estate metadata travels UNENCRYPTED on the internal network —
 * stated in the data-flow docs and flagged in Settings, never silently accepted.
 */
export const BASE_URL_HINT = 'Must be an http(s) URL with no embedded credentials, e.g. http://127.0.0.1:11434/v1';

/**
 * `URL` is a WHATWG global present in Node 22 and every browser, but this package is
 * compiled env-agnostically (`lib: ES2023`, `types: []`) so the server↔web contract stays
 * portable. Declare just the surface we use rather than pulling DOM/node libs in here.
 */
interface ParsedUrl {
  protocol: string;
  username: string;
  password: string;
  search: string;
  hash: string;
  origin: string;
  pathname: string;
}
declare const URL: new (input: string) => ParsedUrl;

export interface BaseUrlCheck {
  ok: boolean;
  /** Normalized (trailing slashes stripped) — only when ok. */
  normalized?: string;
  /** True when the scheme is plain http (allowed, but surfaced as a warning). */
  insecure?: boolean;
  reason?: string;
}

export function checkBaseUrl(raw: string): BaseUrlCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'Base URL is required.' };
  let u: ParsedUrl;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: `Not a valid URL. ${BASE_URL_HINT}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported scheme "${u.protocol}". ${BASE_URL_HINT}` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'Base URL must not embed a username or password — put the key in the API-key field.' };
  }
  if (u.search || u.hash) {
    return { ok: false, reason: 'Base URL must not carry a query string or fragment.' };
  }
  const normalized = (u.origin + u.pathname).replace(/\/+$/, '');
  return { ok: true, normalized, insecure: u.protocol === 'http:' };
}

const baseUrlSchema = z
  .string()
  .superRefine((val, ctx) => {
    const c = checkBaseUrl(val);
    if (!c.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: c.reason ?? 'Invalid base URL.' });
  })
  .transform((val) => checkBaseUrl(val).normalized as string);

/**
 * Setting the active provider. A discriminated union because the providers genuinely
 * differ: the hosted two need a key and pin their own model; `openai_compatible` needs
 * a base URL + a model id, and its key is optional.
 */
export const llmConfigInputSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('openai'), apiKey: z.string().min(1) }),
  z.object({ provider: z.literal('anthropic'), apiKey: z.string().min(1) }),
  z.object({
    provider: z.literal('openai_compatible'),
    baseUrl: baseUrlSchema,
    model: z.string().trim().min(1, 'Model id is required (the endpoint chooses no default for us).'),
    /** Optional — many self-hosted endpoints are keyless. Absent ⇒ no Authorization header. */
    apiKey: z.string().optional(),
  }),
]);
export type LlmConfigInput = z.infer<typeof llmConfigInputSchema>;

/**
 * What the two wrapper seams (rule 6) can actually do on the configured endpoint —
 * CAPABILITY-PROBED at configuration time, never assumed (DECISION #30, Principle 7).
 * `null` for the hosted providers, where both seams are known-good and contract-tested.
 *
 *  - `structuredOutput`    — seam 1 (enrichment). Broadly supported.
 *  - `streamingToolCalls`  — seam 2 (chat). The fragile one: varies by model AND server.
 *
 * When `streamingToolCalls` is false, chat says so ("chat unavailable on this provider")
 * and enrichment carries on. It never guesses (rule 5).
 */
export const llmCapabilitiesSchema = z.object({
  structuredOutput: z.boolean(),
  streamingToolCalls: z.boolean(),
  probedAt: z.string(),
  /** Plain-English note when a seam probe failed, for Settings to show. */
  note: z.string().nullable(),
});
export type LlmCapabilities = z.infer<typeof llmCapabilitiesSchema>;

/**
 * The SAFE view returned to the UI — never includes the key.
 *  - `enabled`  — the in-app master switch (persisted; the owner toggles it).
 *  - `envLocked`— ops forced enrichment off via ENRICHMENT_ENABLED=false; the master
 *                 switch is then locked off and can't be turned on from the UI.
 *  - `configured` — a provider is stored.
 *  - `provider`/`model` — the selected provider + its model.
 *  - `baseUrl` — the configured endpoint (openai_compatible only; null otherwise).
 *  - `capabilities` — the probe result (openai_compatible only; null otherwise).
 * Enrichment is actively running only when `enabled && !envLocked && configured`.
 */
export const llmConfigSchema = z.object({
  provider: llmProviderSchema.nullable(),
  model: z.string().nullable(),
  baseUrl: z.string().nullable(),
  capabilities: llmCapabilitiesSchema.nullable(),
  configured: z.boolean(),
  enabled: z.boolean(),
  envLocked: z.boolean(),
});
export type LlmConfig = z.infer<typeof llmConfigSchema>;

export const llmConfigResponseSchema = z.object({ config: llmConfigSchema });
export type LlmConfigResponse = z.infer<typeof llmConfigResponseSchema>;

/**
 * Is chat available on this config? Chat needs seam 2. The hosted providers always have
 * it; a custom endpoint has it only if the probe saw a real tool call. Used by the
 * server to degrade explicitly and by the UI to say so up front.
 */
export function chatSupported(config: Pick<LlmConfig, 'provider' | 'capabilities'>): boolean {
  if (!config.provider) return false;
  if (config.provider !== 'openai_compatible') return true;
  return config.capabilities?.streamingToolCalls === true;
}

/** Toggling the in-app enrichment master switch. */
export const enrichmentToggleSchema = z.object({ enabled: z.boolean() });
export type EnrichmentToggle = z.infer<typeof enrichmentToggleSchema>;
