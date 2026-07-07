import type { N8nNode, WebhookEndpoint, HttpCallsite, CredentialRef } from '@argus/shared';
import { isExpression } from './refs.js';

/**
 * Cross-workflow endpoint extraction (S5) — the facts S1b deliberately held back.
 *
 * These feed the estate-wide edge pass:
 *   - webhook entry points (path)         → the target of a webhook↔HTTP match
 *   - HTTP call sites (host + webhookPath) → the source of a webhook↔HTTP / cross-instance match
 *   - credential bindings (id)            → binds_credential / shared_credential edges
 *
 * Shapes are rule-1 verified in contracts/n8n-20-graph-shapes.json. Nothing is
 * guessed: expression-valued URLs/paths are flagged unmatchable (no edge, ever).
 */

const WEBHOOK_NODE_TYPES = new Set(['n8n-nodes-base.webhook', 'n8n-nodes-base.formTrigger']);
const HTTP_NODE_TYPE = 'n8n-nodes-base.httpRequest';

/** Webhook path segment out of a full n8n webhook URL path (/webhook/<path> or /webhook-test/<path>). */
export function webhookPathFromUrlPath(pathname: string): string | null {
  const m = pathname.match(/^\/(?:webhook|webhook-test|form|form-test)\/(.+)$/);
  const captured = m?.[1];
  if (!captured) return null;
  return captured.replace(/^\/+|\/+$/g, '') || null;
}

/** Parse a literal HTTP Request URL into { host, webhookPath }. Expression/unparseable → nulls. */
export function parseHttpUrl(rawUrl: unknown): { host: string | null; webhookPath: string | null; isExpression: boolean } {
  if (typeof rawUrl !== 'string' || rawUrl === '') return { host: null, webhookPath: null, isExpression: false };
  if (isExpression(rawUrl)) return { host: null, webhookPath: null, isExpression: true };
  try {
    const u = new URL(rawUrl);
    return { host: u.host, webhookPath: webhookPathFromUrlPath(u.pathname), isExpression: false };
  } catch {
    // A literal that isn't a well-formed absolute URL (relative, malformed) — no host to match.
    return { host: null, webhookPath: null, isExpression: false };
  }
}

/** Webhook entry points declared by webhook/form-trigger nodes. */
export function webhookEndpointsForNode(node: N8nNode): WebhookEndpoint[] {
  if (!WEBHOOK_NODE_TYPES.has(node.type)) return [];
  const path = (node.parameters as Record<string, unknown>)?.path;
  // Expression-valued or absent path → unmatchable (uses the node's generated
  // webhookId, or is an n8n expression). Never guessed (rule 5).
  if (typeof path !== 'string' || path === '' || isExpression(path)) {
    return [{ nodeName: node.name ?? null, path: null, isExpression: isExpression(path) }];
  }
  return [{ nodeName: node.name ?? null, path: path.replace(/^\/+|\/+$/g, '') || null, isExpression: false }];
}

/** Outbound HTTP call sites (n8n-nodes-base.httpRequest). */
export function httpCallsitesForNode(node: N8nNode): HttpCallsite[] {
  if (node.type !== HTTP_NODE_TYPE) return [];
  const rawUrl = (node.parameters as Record<string, unknown>)?.url;
  const parsed = parseHttpUrl(rawUrl);
  return [
    {
      nodeName: node.name ?? null,
      rawUrl: typeof rawUrl === 'string' ? rawUrl : null,
      host: parsed.host,
      webhookPath: parsed.webhookPath,
      isExpression: parsed.isExpression,
    },
  ];
}

/** Credential bindings on a node — the estate-unique credential id + type + name. */
export function credentialRefsForNode(node: N8nNode): CredentialRef[] {
  const creds = node.credentials;
  if (!creds || typeof creds !== 'object') return [];
  const out: CredentialRef[] = [];
  for (const [credentialType, val] of Object.entries(creds)) {
    const v = (val ?? {}) as { id?: unknown; name?: unknown };
    out.push({
      nodeName: node.name ?? null,
      credentialType,
      credentialId: typeof v.id === 'string' && v.id !== '' ? v.id : null,
      credentialName: typeof v.name === 'string' && v.name !== '' ? v.name : null,
    });
  }
  return out;
}
