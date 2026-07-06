import type Database from 'better-sqlite3';
import type { LlmProvider, LlmConfig, SessionActor } from '@argus/shared';
import { withAudit } from '../db/audit.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { DEFAULT_MODELS } from '../llm/index.js';

/**
 * The single active LLM provider config (one row, id='active'). Holds the provider's
 * API key ENCRYPTED at rest (like connection keys) — never returned by any API, never
 * logged. Writes go through the audit DAO (configuring a provider is a mutating action,
 * DECISION #6); the audit detail carries provider + model only, never the key.
 */
export interface LlmConfigRow {
  id: 'active';
  provider: LlmProvider;
  model: string;
  api_key_cipher: string;
  updated_at: string;
}

export function getLlmConfigRow(db: Database.Database): LlmConfigRow | undefined {
  return db.prepare("SELECT * FROM llm_config WHERE id = 'active'").get() as LlmConfigRow | undefined;
}

/** The active provider's key, decrypted in-process for a call. Null when unconfigured. */
export function getDecryptedApiKey(db: Database.Database, encryptionKey: string): string | null {
  const row = getLlmConfigRow(db);
  return row ? decryptSecret(row.api_key_cipher, encryptionKey) : null;
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
    configured: row != null,
    enabled,
    envLocked: !envAllowed,
  };
}

/** Set the active provider + key (model pinned per provider). Audited; replaces the single row. */
export function setLlmConfig(
  db: Database.Database,
  actor: SessionActor,
  provider: LlmProvider,
  apiKey: string,
  encryptionKey: string,
): LlmConfigRow {
  const row: LlmConfigRow = {
    id: 'active',
    provider,
    model: DEFAULT_MODELS[provider],
    api_key_cipher: encryptSecret(apiKey, encryptionKey),
    updated_at: new Date().toISOString(),
  };
  return withAudit(
    db,
    actor,
    { action: 'llm.configure', entityType: 'llm_config', entityId: 'active', detail: { provider, model: row.model } },
    () => {
      db.prepare(
        `INSERT INTO llm_config (id, provider, model, api_key_cipher, updated_at)
         VALUES (@id, @provider, @model, @api_key_cipher, @updated_at)
         ON CONFLICT(id) DO UPDATE SET provider=@provider, model=@model, api_key_cipher=@api_key_cipher, updated_at=@updated_at`,
      ).run(row);
      return row;
    },
  );
}
