import { describe, it, expect } from 'vitest';
import type { N8nWorkflowListItem, WorkflowFacts } from '@argus/shared';
import { buildEnrichmentInput } from './allowlist.js';

function facts(partial: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    schemaVersion: 1,
    analyzedAt: '2026-07-06T00:00:00.000Z',
    nodeCount: 3,
    nodeTypes: [],
    triggers: [{ type: 'n8n-nodes-base.webhook', display: 'Webhook', source: 'manifest' }],
    triggerCountDetected: 1,
    triggerCountReported: 1,
    systems: [
      { system: 'Stripe', via: 'credential', credentialType: 'stripeApi', nodeType: null, resolved: true, raw: 'stripeApi' },
      { system: 'Slack', via: 'node', credentialType: null, nodeType: 'n8n-nodes-base.slack', resolved: true, raw: 'n8n-nodes-base.slack' },
      { system: null, via: 'node', credentialType: null, nodeType: 'n8n-nodes-base.httpRequest', resolved: false, raw: 'n8n-nodes-base.httpRequest' },
    ],
    credentialTypes: ['stripeApi', 'slackApi'],
    dataTableRefs: [],
    mcpExposed: false,
    directDeps: [],
    callerPolicy: { policy: null, callerIds: [] },
    coverage: { understood: true, unknownNodeTypes: [], unresolvedRefs: 0, reasons: [] },
    ...partial,
  };
}

function workflow(partial: Partial<N8nWorkflowListItem> = {}): N8nWorkflowListItem {
  return {
    id: 'w1',
    name: 'Stripe Dunning',
    active: true,
    isArchived: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    versionId: 'v1',
    shared: [],
    nodes: [
      { type: 'n8n-nodes-base.stripeTrigger', name: 'On failed charge', parameters: { event: 'charge.failed' } },
      // A parameter carrying a would-be secret value — must NEVER surface in the input.
      { type: 'n8n-nodes-base.httpRequest', name: 'Call API', parameters: { url: 'https://api.internal.example/x?token=SUPERSECRET' } },
    ],
    connections: { 'On failed charge': { main: [[{ node: 'Call API' }]] } },
    settings: {},
    triggerCount: 1,
    tags: [{ id: 't1', name: 'billing' }, { id: 't2', name: 'production' }],
    ...partial,
  };
}

describe('buildEnrichmentInput — the strict allowlist', () => {
  it('includes only safe fields; NO parameters or URLs ever surface', () => {
    const { input } = buildEnrichmentInput(workflow(), facts(), { project: 'Revenue Ops' });
    const serialized = JSON.stringify(input);
    // The planted parameter value and URL must be absent (DECISION #26).
    expect(serialized).not.toContain('SUPERSECRET');
    expect(serialized).not.toContain('api.internal.example');
    expect(serialized).not.toContain('charge.failed');
    expect(serialized).not.toMatch(/https?:\/\//);
    // Node names + types are present; parameters are not.
    expect(input.nodes).toEqual([
      { name: 'On failed charge', type: 'n8n-nodes-base.stripeTrigger' },
      { name: 'Call API', type: 'n8n-nodes-base.httpRequest' },
    ]);
    expect(input.name).toBe('Stripe Dunning');
    expect(input.project).toBe('Revenue Ops');
    expect(input.tags).toEqual(['billing', 'production']);
  });

  it('derives systems from credential/node-mapped facts only (never URL-derived)', () => {
    const { input } = buildEnrichmentInput(workflow(), facts(), { project: null });
    // Stripe (credential) + Slack (node) resolved; the unresolved httpRequest system is excluded.
    expect(input.systems).toEqual(['Slack', 'Stripe']);
    expect(input.systems).not.toContain(null);
  });

  it('summarizes topology as counts only', () => {
    const { input } = buildEnrichmentInput(workflow(), facts(), { project: null });
    expect(input.topology).toMatch(/nodes/);
    expect(input.topology).not.toContain('http');
  });
});
