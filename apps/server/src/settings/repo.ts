import type Database from 'better-sqlite3';
import type { LlmProvider, LlmConfig, LlmCapabilities, SessionActor } from '@argus/shared';
import { withAudit } from '../db/audit.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { DEFAULT_MODELS, type CapabilityProbeResult } from '../llm/index.js';

/**
 * The single active LLM provider config (one row, id='active'). Holds the provider's
 * API key ENCRYPTED at rest (like connection keys) — never returned by any API, never
 * logged. Writes go through the audit DAO (configuring a provider is a mutating action,
 * DECISION #6); the audit detail carries provider + model + base URL, never the key.
 *
 * For `openai_compatible` (DECISION #30) the row also carries the user-supplied base URL
 * and the capability-probe verdict for the two wrapper seams.
 */
export interface LlmConfigRow {
  id: 'active';
  provider: LlmProvider;
  model: string;
  api_key_cipher: string;
  updated_at: string;
  /** openai_compatible only; null for the hosted providers. */
  base_url: string | null;
  caps_structured_output: number | null;
  caps_streaming_tool_calls: number | null;
  caps_note: string | null;
  caps_probed_at: string | null;
}

export function getLlmConfigRow(db: Database.Database): LlmConfigRow | undefined {
  return db.prepare("SELECT * FROM llm_config WHERE id = 'active'").get() as LlmConfigRow | undefined;
}

/**
 * The active provider's key, decrypted in-process for a call.
 *  - `null`  → no provider configured at all.
 *  - `''`    → configured, but KEYLESS. Legal only for openai_compatible (self-hosted
 *              endpoints commonly need no key). Callers must test `=== null`, never
 *              truthiness, or a keyless endpoint reads as "unconfigured".
 */
export function getDecryptedApiKey(db: Database.Database, encryptionKey: string): string | null {
  const row = getLlmConfigRow(db);
  return row ? decryptSecret(row.api_key_cipher, encryptionKey) : null;
}

/** The probed seam support, or null for the hosted providers (both seams known-good). */
export function getCapabilities(row: LlmConfigRow | undefined): LlmCapabilities | null {
  if (!row || row.provider !== 'openai_compatible' || row.caps_probed_at == null) return null;
  return {
    structuredOutput: row.caps_structured_output === 1,
    streamingToolCalls: row.caps_streaming_tool_calls === 1,
    probedAt: row.caps_probed_at,
    note: row.caps_note,
  };
}

/**
 * The persisted in-app enrichment master switch (default on). This is the owner's
 * toggle; it is AND-ed with the ENRICHMENT_ENABLED ops override at the effective layer.
 */
export function getEnrichmentEnabled(db: Database.Database): boolean {
  const row = db.prepare("SELECT enrichment_enabled FROM app_settings WHERE id = 'app'").get() as
    | { enrichment_enabled: number }
    | undefined;
  return row ? row.enrichment_enabled === 1 : true;
}

/** Flip the master switch (audited — a config mutation, DECISION #6). */
export function setEnrichmentEnabled(db: Database.Database, actor: SessionActor, enabled: boolean): void {
  withAudit(
    db,
    actor,
    { action: 'enrichment.toggle', entityType: 'app_settings', entityId: 'app', detail: { enabled } },
    () => {
      db.prepare("UPDATE app_settings SET enrichment_enabled = ? WHERE id = 'app'").run(enabled ? 1 : 0);
    },
  );
}

/**
 * Safe view for the UI — never the key. `enabled` is the persisted master-switch intent;
 * `envLocked` is true when ops forced enrichment off (ENRICHMENT_ENABLED=false).
 */
export function toSafeLlmConfig(row: LlmConfigRow | undefined, envAllowed: boolean, enabled: boolean): LlmConfig {
  return {
    provider: row?.provider ?? null,
    model: row?.model ?? null,
    baseUrl: row?.base_url ?? null,
    capabilities: getCapabilities(row),
    configured: row != null,
    enabled,
    envLocked: !envAllowed,
  };
}

export interface SetLlmConfigParams {
  provider: LlmProvider;
  /** '' for a keyless openai_compatible endpoint. */
  apiKey: string;
  /** Required for openai_compatible (validated + normalized upstream); ignored otherwise. */
  baseUrl?: string | undefined;
  /** Required for openai_compatible (user-chosen); the hosted providers pin their own. */
  model?: string | undefined;
  /** The probe verdict for openai_compatible; null for the hosted providers. */
  capabilities?: CapabilityProbeResult | null | undefined;
}

/**
 * Set the active provider (audited; replaces the single row). The audit detail names the
 * DESTINATION — provider, model, base URL, and probed seam support — so the trail says
 * where estate metadata was configured to go, and what it could do (DECISION #30,
 * Principle 9). The key is never in the detail.
 */
export function setLlmConfig(db: Database.Database, actor: SessionActor, params: SetLlmConfigParams, encryptionKey: string): LlmConfigRow {
  const { provider, apiKey, capabilities } = params;
  const isCompat = provider === 'openai_compatible';

  if (isCompat && (!params.baseUrl || !params.model)) {
    throw new Error('openai_compatible requires a base URL and a model id');
  }
  // Never invent a model for a customer-chosen endpoint (rule 5).
  const model = isCompat ? (params.model as string) : DEFAULT_MODELS[provider as 'openai' | 'anthropic'];

  const row: LlmConfigRow = {
    id: 'active',
    provider,
    model,
    api_key_cipher: encryptSecret(apiKey, encryptionKey),
    updated_at: new Date().toISOString(),
    base_url: isCompat ? (params.baseUrl as string) : null,
    caps_structured_output: isCompat && capabilities ? (capabilities.structuredOutput ? 1 : 0) : null,
    caps_streaming_tool_calls: isCompat && capabilities ? (capabilities.streamingToolCalls ? 1 : 0) : null,
    caps_note: isCompat && capabilities ? capabilities.note : null,
    caps_probed_at: isCompat && capabilities ? new Date().toISOString() : null,
  };

  return withAudit(
    db,
    actor,
    {
      action: 'llm.configure',
      entityType: 'llm_config',
      entityId: 'active',
      detail: {
        provider,
        model,
        // A base-URL change is a change of egress destination — it belongs in the trail.
        baseUrl: row.base_url,
        keyless: isCompat && apiKey === '',
        insecureTransport: row.base_url ? row.base_url.startsWith('http://') : false,
        capabilities: capabilities ? { structuredOutput: capabilities.structuredOutput, streamingToolCalls: capabilities.streamingToolCalls } : null,
      },
    },
    () => {
      db.prepare(
        `INSERT INTO llm_config (id, provider, model, api_key_cipher, updated_at, base_url,
                                 caps_structured_output, caps_streaming_tool_calls, caps_note, caps_probed_at)
         VALUES (@id, @provider, @model, @api_key_cipher, @updated_at, @base_url,
                 @caps_structured_output, @caps_streaming_tool_calls, @caps_note, @caps_probed_at)
         ON CONFLICT(id) DO UPDATE SET provider=@provider, model=@model, api_key_cipher=@api_key_cipher,
                 updated_at=@updated_at, base_url=@base_url, caps_structured_output=@caps_structured_output,
                 caps_streaming_tool_calls=@caps_streaming_tool_calls, caps_note=@caps_note, caps_probed_at=@caps_probed_at`,
      ).run(row);
      return row;
    },
  );
}
