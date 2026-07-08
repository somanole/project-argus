import { redactText } from '../llm/redact.js';

/**
 * The chat egress backstop (spec .agents/specs/chat.md; docs/DATA-FLOW-CHAT.md). Every
 * chat tool result is run through this before it is handed to the model, so a secret
 * pasted into a workflow name, an ownership `reason`, a credential name, a host, etc.
 * is scrubbed to `[REDACTED:<kind>]` — the same defence-in-depth enrichment applies to
 * its allowlist (DECISION #7).
 *
 * We deliberately DO NOT touch identifier fields: n8n/Argus ids (`instanceId`, `id`,
 * `credentialId`, `entityId`, …) are opaque handles, not secrets, and one of them — the
 * per-connection `instanceId` — is a UUID long enough to trip the high-entropy sweep.
 * Redacting it would break clickable workflow references and any follow-up tool call that
 * passes an id back, with no security benefit. So id-bearing keys pass through verbatim;
 * every other string is scrubbed.
 */
export const ID_KEYS = new Set(['instanceId', 'id', 'credentialId', 'entityId', 'nodeId', 'resolvedId', 'workflowId']);

/** Fields that hold an email address — dropped to null by default (DECISION #29). */
export const EMAIL_KEYS = new Set(['email', 'actorEmail', 'ownerEmail', 'backupOwnerEmail']);

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export interface RedactToolOpts {
  /** When false (default), owner/actor emails are removed from the egress (DECISION #29). */
  egressEmails: boolean;
}

export function redactToolOutput<T>(value: T, opts: RedactToolOpts = { egressEmails: false }): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key && ID_KEYS.has(key)) return v; // ids are opaque handles, never scrubbed
      if (!opts.egressEmails && key && EMAIL_KEYS.has(key)) return null; // drop the email value
      let s = redactText(v).text; // secret backstop (keys/JWTs/tokens/connection-strings)
      if (!opts.egressEmails) s = s.replace(EMAIL_RE, '[REDACTED:email]'); // stray emails in free text
      return s;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, k);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
