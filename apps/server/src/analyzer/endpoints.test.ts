import { describe, it, expect } from 'vitest';
import type { N8nNode } from '@argus/shared';
import {
  webhookPathFromUrlPath,
  webhookEndpointsForNode,
  httpCallsitesForNode,
  credentialRefsForNode,
} from './endpoints.js';

const node = (over: Partial<N8nNode>): N8nNode => ({ type: 'x', name: 'n', parameters: {}, ...over });

describe('S5 endpoint extraction — webhook paths', () => {
  it('extracts a literal webhook path, trimmed of slashes', () => {
    const eps = webhookEndpointsForNode(node({ type: 'n8n-nodes-base.webhook', name: 'Order Webhook', parameters: { path: 'order-intake' } }));
    expect(eps).toEqual([{ nodeName: 'Order Webhook', path: 'order-intake', isExpression: false }]);
  });

  it('flags an expression-valued path as unmatchable (never a guess)', () => {
    const eps = webhookEndpointsForNode(node({ type: 'n8n-nodes-base.webhook', parameters: { path: '={{ $json.slug }}' } }));
    expect(eps[0]?.path).toBeNull();
    expect(eps[0]?.isExpression).toBe(true);
  });

  it('ignores non-webhook node types', () => {
    expect(webhookEndpointsForNode(node({ type: 'n8n-nodes-base.httpRequest' }))).toEqual([]);
  });
});

describe('S5 endpoint extraction — HTTP call sites', () => {
  it('parses host + webhook path from a literal /webhook/ URL (the cross-instance shape)', () => {
    const cs = httpCallsitesForNode(node({ type: 'n8n-nodes-base.httpRequest', name: 'Call Prod', parameters: { url: 'http://localhost:5678/webhook/order-intake' } }));
    expect(cs[0]).toMatchObject({ host: 'localhost:5678', webhookPath: 'order-intake', isExpression: false });
  });

  it('flags an expression URL as unmatchable — no host, no path', () => {
    const cs = httpCallsitesForNode(node({ type: 'n8n-nodes-base.httpRequest', parameters: { url: '={{ $env.BASE }}/webhook/x' } }));
    expect(cs[0]).toMatchObject({ host: null, webhookPath: null, isExpression: true });
  });

  it('a non-webhook URL parses a host but no webhook path (no false edge)', () => {
    const cs = httpCallsitesForNode(node({ type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://api.stripe.com/v1/charges' } }));
    expect(cs[0]).toMatchObject({ host: 'api.stripe.com', webhookPath: null });
  });

  it('a malformed literal URL yields no host (never throws)', () => {
    const cs = httpCallsitesForNode(node({ type: 'n8n-nodes-base.httpRequest', parameters: { url: 'not a url' } }));
    expect(cs[0]).toMatchObject({ host: null, webhookPath: null, isExpression: false });
  });

  it('webhookPathFromUrlPath handles webhook, webhook-test, and form paths', () => {
    expect(webhookPathFromUrlPath('/webhook/order-intake')).toBe('order-intake');
    expect(webhookPathFromUrlPath('/webhook-test/abc')).toBe('abc');
    expect(webhookPathFromUrlPath('/api/v1/charges')).toBeNull();
  });
});

describe('S5 endpoint extraction — credential bindings', () => {
  it('captures the credential id + type + name (S1b captured only the type)', () => {
    const refs = credentialRefsForNode(
      node({ type: 'n8n-nodes-base.salesforce', name: 'Upsert Lead', credentials: { salesforceOAuth2Api: { id: 'WSFvwndLPU3zdbI1', name: 'Salesforce — CRM' } } }),
    );
    expect(refs).toEqual([{ nodeName: 'Upsert Lead', credentialType: 'salesforceOAuth2Api', credentialId: 'WSFvwndLPU3zdbI1', credentialName: 'Salesforce — CRM' }]);
  });

  it('tolerates a binding with no id (null, not a crash)', () => {
    const refs = credentialRefsForNode(node({ type: 'x', credentials: { httpHeaderAuth: { name: 'H' } } }));
    expect(refs[0]).toMatchObject({ credentialType: 'httpHeaderAuth', credentialId: null });
  });

  it('no credentials → no refs', () => {
    expect(credentialRefsForNode(node({ type: 'x' }))).toEqual([]);
  });
});
