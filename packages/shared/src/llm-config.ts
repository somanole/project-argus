import { z } from 'zod';

/**
 * The LLM provider configuration contract (server ↔ web). One active provider at a
 * time; the user brings their own key, stored ENCRYPTED at rest (like n8n API keys)
 * and NEVER returned by any API (standing rule 6, DECISION #25). The write schema
 * carries the key; the read (safe view) schema never does.
 */

/** OpenAI or Anthropic only — no third provider in S2. */
export const llmProviderSchema = z.enum(['openai', 'anthropic']);
export type LlmProvider = z.infer<typeof llmProviderSchema>;

/** Setting the active provider + its key (the key is the only secret; encrypted at rest). */
export const llmConfigInputSchema = z.object({
  provider: llmProviderSchema,
  apiKey: z.string().min(1),
});
export type LlmConfigInput = z.infer<typeof llmConfigInputSchema>;

/**
 * The SAFE view returned to the UI — never includes the key.
 *  - `enabled`  — the in-app master switch (persisted; the owner toggles it).
 *  - `envLocked`— ops forced enrichment off via ENRICHMENT_ENABLED=false; the master
 *                 switch is then locked off and can't be turned on from the UI.
 *  - `configured` — a provider key is stored.
 *  - `provider`/`model` — the selected provider + its pinned model.
 * Enrichment is actively running only when `enabled && !envLocked && configured`.
 */
export const llmConfigSchema = z.object({
  provider: llmProviderSchema.nullable(),
  model: z.string().nullable(),
  configured: z.boolean(),
  enabled: z.boolean(),
  envLocked: z.boolean(),
});
export type LlmConfig = z.infer<typeof llmConfigSchema>;

export const llmConfigResponseSchema = z.object({ config: llmConfigSchema });
export type LlmConfigResponse = z.infer<typeof llmConfigResponseSchema>;

/** Toggling the in-app enrichment master switch. */
export const enrichmentToggleSchema = z.object({ enabled: z.boolean() });
export type EnrichmentToggle = z.infer<typeof enrichmentToggleSchema>;
