import { describe, it, expect } from 'vitest';
import type { EnrichmentInput } from './allowlist.js';
import { hashEnrichmentInput } from './input-hash.js';

function input(partial: Partial<EnrichmentInput> = {}): EnrichmentInput {
  return {
    name: 'Stripe Dunning',
    project: 'Revenue Ops',
    tags: ['billing', 'production'],
    triggerTypes: ['n8n-nodes-base.stripeTrigger'],
    nodes: [
      { name: 'On failed charge', type: 'n8n-nodes-base.stripeTrigger' },
      { name: 'Send email', type: 'n8n-nodes-base.emailSend' },
    ],
    topology: '3 nodes, 1 trigger(s), 2 connection(s), linear',
    credentialTypes: ['stripeApi', 'smtp'],
    systems: ['Email', 'Stripe'],
    failureStats: null,
    facts: { nodeCount: 3, mcpExposed: false, brokenRefCount: 0, understood: true },
    ...partial,
  };
}

describe('hashEnrichmentInput', () => {
  it('is stable for identical input', () => {
    expect(hashEnrichmentInput(input())).toBe(hashEnrichmentInput(input()));
  });

  it('changes when the workflow is renamed (what versionId misses)', () => {
    expect(hashEnrichmentInput(input({ name: 'Stripe Dunning' }))).not.toBe(
      hashEnrichmentInput(input({ name: 'Stripe Dunning v2' })),
    );
  });

  it('is order-independent: reordering arrays does not change the hash', () => {
    const a = input({ tags: ['billing', 'production'], systems: ['Email', 'Stripe'] });
    const b = input({ tags: ['production', 'billing'], systems: ['Stripe', 'Email'] });
    expect(hashEnrichmentInput(a)).toBe(hashEnrichmentInput(b));
  });

  it('changes when a meaningful field changes (a node added)', () => {
    const more = input({
      nodes: [...input().nodes, { name: 'Log', type: 'n8n-nodes-base.noOp' }],
    });
    expect(hashEnrichmentInput(more)).not.toBe(hashEnrichmentInput(input()));
  });
});
