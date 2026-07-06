/**
 * The redaction backstop (DECISION #7 & #26). The enrichment allowlist already excludes
 * parameters and — per DECISION #26 — every URL/hostname/domain, so the ONLY thing that
 * leaves is short free-text (workflow name, tags, node names). A pasted secret could
 * still hide there, so this pass scrubs those strings before storage and before any LLM
 * call, verified by the planted-secrets test. It is defence-in-depth, not the primary
 * control (inclusion is). Matches become `[REDACTED:<kind>]`; nothing is dropped
 * silently.
 */

interface Pattern {
  kind: string;
  re: RegExp;
}

// High-signal secret shapes. Ordered; each runs globally.
const PATTERNS: Pattern[] = [
  { kind: 'pem', re: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  // Connection strings with embedded user:pass@ (scheme required so we don't eat prose).
  { kind: 'connection-string', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]+@[^\s]+/gi },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi },
];

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// A standalone high-entropy token (long, mixed) that no pattern named — likely a secret.
const TOKEN_RE = /[A-Za-z0-9+/=_-]{24,}/g;
const ENTROPY_BITS_PER_CHAR = 3.5;

export interface RedactionResult {
  text: string;
  count: number;
  kinds: string[];
}

/** Redact a single free-text string. Returns the scrubbed text + what was hit. */
export function redactText(input: string): RedactionResult {
  if (!input) return { text: input, count: 0, kinds: [] };
  let text = input;
  let count = 0;
  const kinds: string[] = [];

  for (const { kind, re } of PATTERNS) {
    text = text.replace(re, () => {
      count++;
      kinds.push(kind);
      return `[REDACTED:${kind}]`;
    });
  }

  // Entropy sweep for unnamed high-entropy blobs (skip our own markers).
  text = text.replace(TOKEN_RE, (m) => {
    if (m.startsWith('REDACTED')) return m;
    if (entropy(m) >= ENTROPY_BITS_PER_CHAR) {
      count++;
      kinds.push('high-entropy');
      return '[REDACTED:high-entropy]';
    }
    return m;
  });

  return { text, count, kinds };
}

/**
 * Deep-redact every string in an object/array (the assembled allowlist). Returns a new
 * value plus the total redaction count — the planted-secrets test asserts count/output.
 */
export function redactDeep<T>(value: T): { value: T; count: number; kinds: string[] } {
  let count = 0;
  const kinds: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactText(v);
      count += r.count;
      kinds.push(...r.kinds);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, count, kinds };
}
