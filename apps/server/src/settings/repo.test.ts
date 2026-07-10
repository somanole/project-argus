import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { SessionActor } from '@argus/shared';
import { migrate } from '../db/migrate.js';
import { setLlmConfig, getLlmConfigRow, getDecryptedApiKey, getCapabilities, toSafeLlmConfig } from './repo.js';

/**
 * The `openai_compatible` provider's config surface (DECISION #30): the API key is
 * optional, the base URL is an egress destination that must land in the audit trail
 * (Principle 9), and nothing here may ever return or log the key.
 */

const ACTOR: SessionActor = { name: 'Ops', email: 'ops@argus.io' };
const ENC = 'test-encryption-key';
const LOCAL = 'http://127.0.0.1:11434/v1';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
const auditRows = (db: Database.Database) =>
  db.prepare("SELECT action, entity_type, entity_id, detail_json FROM audit_log WHERE action = 'llm.configure' ORDER BY id").all() as Array<{
    action: string;
    entity_type: string;
    entity_id: string;
    detail_json: string;
  }>;

const CAPS = { structuredOutput: true, streamingToolCalls: false, note: 'chat is unavailable' };

describe('setLlmConfig — openai_compatible', () => {
  it('persists a KEYLESS endpoint: configured, empty key, never null', () => {
    const db = freshDb();
    setLlmConfig(db, ACTOR, { provider: 'openai_compatible', apiKey: '', baseUrl: LOCAL, model: 'llama3.1:8b', capabilities: CAPS }, ENC);

    const row = getLlmConfigRow(db)!;
    expect(row.provider).toBe('openai_compatible');
    expect(row.base_url).toBe(LOCAL);
    expect(row.model).toBe('llama3.1:8b');
    // '' means "keyless", null means "unconfigured". The distinction is load-bearing.
    expect(getDecryptedApiKey(db, ENC)).toBe('');
  });

  it('uses the user-chosen model — it never invents a default for a custom endpoint', () => {
    const db = freshDb();
    setLlmConfig(db, ACTOR, { provider: 'openai_compatible', apiKey: '', baseUrl: LOCAL, model: 'qwen2.5:14b', capabilities: CAPS }, ENC);
    expect(getLlmConfigRow(db)!.model).toBe('qwen2.5:14b');
  });

  it('refuses to store a custom endpoint without a base URL or model', () => {
    const db = freshDb();
    expect(() => setLlmConfig(db, ACTOR, { provider: 'openai_compatible', apiKey: '', model: 'm' }, ENC)).toThrow();
    expect(() => setLlmConfig(db, ACTOR, { provider: 'openai_compatible', apiKey: '', baseUrl: LOCAL }, ENC)).toThrow();
  });

  it('stores the probed capabilities and exposes them in the safe view', () => {
    const db = freshDb();
    setLlmConfig(db, ACTOR, { provider: 'openai_compatible', apiKey: '', baseUrl: LOCAL, model: 'm', capabilities: CAPS }, ENC);
    const caps = getCapabilities(getLlmConfigRow(db))!;
    expect(caps.structuredOutput).toBe(true);
    expect(caps.streamingToolCalls).toBe(false);
    expect(caps.probedAt).toBeTruthy();

    const safe = toSafeLlmConfig(getLlmConfigRow(db), true, true);
    expect(safe.baseUrl).toBe(LOCAL);
    expect(safe.capabilities?.streamingToolCalls).toBe(false);
    expect(JSON.stringify(safe)).not.toContain('api_key');
  });

  it('reports NO capabilities for a hosted provider (both seams are contract-tested)', () => {
    const db = freshDb();
    setLlmConfig(db, ACTOR, { provider: 'anthropic', apiKey: 'sk-ant' }, ENC);
    const safe = toSafeLlmConfig(getLlmConfigRow(db), true, true);
    expect(safe.baseUrl).toBeNull();
    expect(safe.capabilities).toBeNull();
    expect(safe.model).toBe('claude-haiku-4-5');
  });
});

describe('audit trail — a base-URL change is a change of egress destination', () => {
  it('records the endpoint, keyless flag, insecure transport, and probed seams — never the key', () => {
    const db = freshDb();
    setLlmConfig(db, ACTOR, { provider: 'openai_compatible', apiKey: 'sk-secret-gateway', baseUrl: LOCAL, model: 'm', capabilities: CAPS }, ENC);

    const [entry] = auditRows(db);
    expect(entry!.entity_type).toBe('llm_config');
    expect(entry!.entity_id).toBe('active');
    const detail = JSON.parse(entry!.detail_json) as Record<string, unknown>;
    expect(detail.provider).toBe('openai_compatible');
    expect(detail.baseUrl).toBe(LOCAL);
    expect(detail.keyless).toBe(false);
    expect(detail.insecureTransport).toBe(true); // http:// — stated, not assumed
    expect(detail.capabilities).toEqual({ structuredOutput: true, streamingToolCalls: false });
    // The key must never reach the audit log.
    expect(entry!.detail_json).not.toContain('sk-secret-gateway');
  });

  it('writes a SECOND audit entry when the endpoint is repointed', () => {
    const db = freshDb();
    setLlmConfig(db, ACTOR, { provider: 'openai_compatible', apiKey: '', baseUrl: LOCAL, model: 'm', capabilities: CAPS }, ENC);
    setLlmConfig(db, ACTOR, { provider: 'openai_compatible', apiKey: '', baseUrl: 'https://gw.acme.example/v1', model: 'm', capabilities: CAPS }, ENC);

    const rows = auditRows(db);
    expect(rows).toHaveLength(2);
    const second = JSON.parse(rows[1]!.detail_json) as Record<string, unknown>;
    expect(second.baseUrl).toBe('https://gw.acme.example/v1');
    expect(second.keyless).toBe(true);
    expect(second.insecureTransport).toBe(false); // https
  });
});
