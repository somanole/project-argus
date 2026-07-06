import { describe, it, expect } from 'vitest';
import type { N8nWorkflowListItem, WorkflowFacts, EnrichmentOutput } from '@argus/shared';
import type { LlmClient, StructuredOutputArgs, StructuredResult } from '../llm/index.js';
import { buildEnrichmentInput } from './allowlist.js';
import { enrichWorkflow } from './enrich.js';

/**
 * THE GATE (spec: the deliberate slow-down). Before any live LLM call is enabled, this
 * test proves that NO secret can reach the model — from parameters (excluded by
 * inclusion), from URLs (DECISION #26, never in the allowlist), or from the free-text
 * that does leave (name/tags/node names — scrubbed by the redaction backstop). It works
 * by capturing the EXACT egress payload a real provider would receive and asserting
 * every planted secret literal is absent. Provider-agnostic: the payload is identical
 * for OpenAI and Anthropic, so one capture covers both.
 */

// Distinct planted secrets, one per hiding place + kind.
const SECRETS = {
  awsInParam: 'AKIAIOSFODNN7EXAMPLE',
  jwtInParam: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5OTkifQ.abc123def456ghi789jkl012',
  connStringInParam: 'postgres://dbuser:HunterYellow42Pass@prod-db.internal:5432/main',
  urlWithCreds: 'https://apiuser:P4ssw0rdLeak99@api.vendor.example/v1?api_key=tok9xKq2mVn7Pw4Lr8Ts5Yb1',
  internalHost: 'api.vendor.example',
  secretInNodeName: 'sk-proj-NODENAMELEAKabcdefghij0123456789',
  secretInTag: 'xoxb-999888777666-TAGLEAKtokenvalue',
};

function facts(): WorkflowFacts {
  return {
    schemaVersion: 1,
    analyzedAt: '2026-07-06T00:00:00.000Z',
    nodeCount: 3,
    nodeTypes: [],
    triggers: [{ type: 'n8n-nodes-base.webhook', display: 'Webhook', source: 'manifest' }],
    triggerCountDetected: 1,
    triggerCountReported: 1,
    systems: [{ system: 'Postgres', via: 'credential', credentialType: 'postgres', nodeType: null, resolved: true, raw: 'postgres' }],
    credentialTypes: ['postgres', 'httpHeaderAuth'],
    dataTableRefs: [],
    mcpExposed: false,
    directDeps: [],
    callerPolicy: { policy: null, callerIds: [] },
    coverage: { understood: true, unknownNodeTypes: [], unresolvedRefs: 0, reasons: [] },
  };
}

function plantedWorkflow(): N8nWorkflowListItem {
  return {
    id: 'w1',
    name: 'Vendor Sync',
    active: true,
    isArchived: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    versionId: 'v1',
    shared: [],
    nodes: [
      { type: 'n8n-nodes-base.webhook', name: 'Incoming', parameters: {} },
      {
        type: 'n8n-nodes-base.httpRequest',
        // Secret hidden in a URL parameter (creds in host + token in query) — DECISION #26.
        name: 'Call vendor',
        parameters: { url: SECRETS.urlWithCreds, authorization: `Bearer ${SECRETS.jwtInParam}` },
      },
      {
        type: 'n8n-nodes-base.postgres',
        // Secret hidden in the NODE NAME (free-text that DOES leave → backstop must scrub).
        name: `Store ${SECRETS.secretInNodeName}`,
        parameters: { connectionString: SECRETS.connStringInParam, awsKey: SECRETS.awsInParam },
      },
    ],
    connections: { Incoming: { main: [[{ node: 'Call vendor' }]] } },
    settings: {},
    triggerCount: 1,
    tags: [{ id: 't1', name: 'production' }, { id: 't2', name: SECRETS.secretInTag }],
  };
}

/** A fake client that CAPTURES the exact egress and returns a canned valid result. */
function capturingClient(): { client: LlmClient; captured: string[] } {
  const captured: string[] = [];
  const output: EnrichmentOutput = {
    summary: 's', description: 'd', category: 'integration', criticality: 'medium',
    criticalityReason: 'r', riskFlags: [], suggestedOwnerRationale: 'o', businessContext: 'b',
  };
  const client: LlmClient = {
    provider: 'openai',
    model: 'gpt-5-mini',
    async structuredOutput<T>(args: StructuredOutputArgs<T>): Promise<StructuredResult<T>> {
      captured.push(args.system, args.user);
      return { value: output as unknown as T, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
    // eslint-disable-next-line require-yield
    async *streamToolLoop() {
      throw new Error('unused');
    },
  };
  return { client, captured };
}

describe('planted-secrets gate — nothing sensitive reaches the model', () => {
  it('excludes parameter values and URLs from the built allowlist', () => {
    const { input, redactions } = buildEnrichmentInput(plantedWorkflow(), facts(), { project: 'Data Platform' });
    const serialized = JSON.stringify(input);
    for (const [label, secret] of Object.entries(SECRETS)) {
      expect(serialized, `allowlist must not contain ${label}`).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/https?:\/\//);
    // The node-name and tag secrets were free-text → the backstop fired.
    expect(redactions).toBeGreaterThanOrEqual(2);
  });

  it('captures the exact egress and finds no planted secret in it', async () => {
    const { client, captured } = capturingClient();
    const { input } = buildEnrichmentInput(plantedWorkflow(), facts(), { project: 'Data Platform' });
    const result = await enrichWorkflow(client, input);
    expect(result.status).toBe('analyzed');

    const egress = captured.join('\n');
    expect(egress.length).toBeGreaterThan(0);
    for (const [label, secret] of Object.entries(SECRETS)) {
      expect(egress, `egress must not contain ${label}`).not.toContain(secret);
    }
    // Redaction markers prove the free-text backstop scrubbed the node name + tag.
    expect(egress).toContain('[REDACTED:');
  });
});
