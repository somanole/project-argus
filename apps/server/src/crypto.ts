import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for secrets at rest — specifically each connection's n8n
 * API key (standing rule 6 / S1a security: keys are encrypted in the sacred
 * connections table and never stored, logged, or returned in clear text).
 *
 * AES-256-GCM. The 32-byte key is derived from the configured secret via SHA-256
 * so any passphrase length works. Ciphertext is serialized as `iv:tag:ct`, all
 * base64 — self-describing and easy to store in one TEXT column.
 */
const ALGO = 'aes-256-gcm';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptSecret(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(blob: string, secret: string): string {
  const parts = blob.split(':');
  if (parts.length !== 3) throw new Error('malformed ciphertext');
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, deriveKey(secret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
