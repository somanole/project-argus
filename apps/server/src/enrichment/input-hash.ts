import { createHash } from 'node:crypto';
import type { EnrichmentInput } from './allowlist.js';

/**
 * The enrichment-input hash — the gating identity. Re-enrichment happens ONLY when this
 * changes (spec: renames and settings-only edits that don't bump n8n's `versionId` still
 * change it; a re-run over an unchanged fleet makes 0 API calls). Computed over a
 * CANONICAL form (sorted object keys, sorted arrays) so logically-identical input hashes
 * identically regardless of the order n8n happened to return things.
 */
export function hashEnrichmentInput(input: EnrichmentInput): string {
  return createHash('sha256').update(canonicalString(input)).digest('hex');
}

function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map(canonicalize);
    // Order-independent: sort by canonical serialization.
    return [...mapped].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
