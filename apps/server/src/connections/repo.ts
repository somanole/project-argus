import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConnectionInput, SessionActor } from '@argus/shared';
import { withAudit } from '../db/audit.js';
import { encryptSecret, decryptSecret } from '../crypto.js';

/**
 * Data access for the sacred `connections` table. Every mutation goes through
 * `withAudit` (mutation + audit entry in one transaction — rule 6). The API key
 * is encrypted at rest here and only ever decrypted in-process for a sync call;
 * it is never exposed by `toSafe`.
 */
export interface ConnectionRow {
  id: string;
  label: string;
  base_url: string;
  api_key_cipher: string;
  webhook_host: string | null;
  created_at: string;
  updated_at: string;
}

/** The non-secret projection safe to send to the client (no key). */
export interface SafeConnection {
  id: string;
  label: string;
  baseUrl: string;
  webhookHost: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toSafe(row: ConnectionRow): SafeConnection {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.base_url,
    webhookHost: row.webhook_host,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listConnectionRows(db: Database.Database): ConnectionRow[] {
  return db.prepare('SELECT * FROM connections ORDER BY created_at ASC').all() as ConnectionRow[];
}

export function getConnectionRow(db: Database.Database, id: string): ConnectionRow | undefined {
  return db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined;
}

/** The instance's API key, decrypted for an outbound n8n call. In-process only. */
export function decryptApiKey(row: ConnectionRow, encryptionKey: string): string {
  return decryptSecret(row.api_key_cipher, encryptionKey);
}

export function createConnection(
  db: Database.Database,
  actor: SessionActor,
  input: ConnectionInput,
  encryptionKey: string,
): ConnectionRow {
  const now = new Date().toISOString();
  const row: ConnectionRow = {
    id: randomUUID(),
    label: input.label,
    base_url: input.baseUrl,
    api_key_cipher: encryptSecret(input.apiKey, encryptionKey),
    webhook_host: input.webhookHost ?? null,
    created_at: now,
    updated_at: now,
  };
  return withAudit(
    db,
    actor,
    // detail carries only non-secret context — never the key.
    { action: 'connection.register', entityType: 'connection', entityId: row.id, detail: { label: row.label, baseUrl: row.base_url } },
    () => {
      db.prepare(
        `INSERT INTO connections (id, label, base_url, api_key_cipher, webhook_host, created_at, updated_at)
         VALUES (@id, @label, @base_url, @api_key_cipher, @webhook_host, @created_at, @updated_at)`,
      ).run(row);
      return row;
    },
  );
}

/** Remove a connection (its cached workflows cascade). Returns false if absent. */
export function deleteConnection(db: Database.Database, actor: SessionActor, id: string): boolean {
  const existing = getConnectionRow(db, id);
  if (!existing) return false;
  return withAudit(
    db,
    actor,
    { action: 'connection.remove', entityType: 'connection', entityId: id, detail: { label: existing.label, baseUrl: existing.base_url } },
    () => {
      db.prepare('DELETE FROM connections WHERE id = ?').run(id);
      return true;
    },
  );
}
