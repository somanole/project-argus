import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from './crypto.js';

describe('secret encryption (API keys at rest)', () => {
  it('round-trips a value and does not store it in clear text', () => {
    const key = 'a-strong-secret';
    const plaintext = 'n8n_api_key_1234567890';
    const blob = encryptSecret(plaintext, key);
    expect(blob).not.toContain(plaintext);
    expect(blob.split(':')).toHaveLength(3);
    expect(decryptSecret(blob, key)).toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptSecret('same', 'k')).not.toBe(encryptSecret('same', 'k'));
  });

  it('fails to decrypt with the wrong key', () => {
    const blob = encryptSecret('secret', 'right-key');
    expect(() => decryptSecret(blob, 'wrong-key')).toThrow();
  });
});
