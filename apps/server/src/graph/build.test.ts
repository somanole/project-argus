import { describe, it, expect } from 'vitest';
import type { WorkflowFacts } from '@argus/shared';
import { buildEdges, normalizeHost, nodeIdOf, type GraphWorkflow, type GraphInstance } from './build.js';

/** Minimal facts with only the fields a given test needs. */
function facts(over: Partial<WorkflowFacts>): WorkflowFacts {
  return {
    schemaVersion: 3,
    analyzedAt: 't',
    nodeCount: 1,
    nodeTypes: [],
    triggers: [],
    triggerCountDetected: 0,
    triggerCountReported: null,
    systems: [],
    credentialTypes: [],
    dataTableRefs: [],
    mcpExposed: false,
    canMaskFailures: { flagged: false, reasons: [], noErrorWorkflow: true },
    directDeps: [],
    webhookEndpoints: [],
    httpCallsites: [],
    credentialRefs: [],
    callerPolicy: { policy: null, callerIds: [] },
    coverage: { understood: true, unknownNodeTypes: [], unresolvedRefs: 0, reasons: [] },
    ...over,
  };
}

const wf = (instanceId: string, id: string, name: string, f: Partial<WorkflowFacts>): GraphWorkflow => ({
  instanceId,
  id,
  name,
  active: true,
  archived: false,
  facts: facts(f),
});

const resolvedDep = (kind: 'subWorkflow' | 'toolWorkflow' | 'agentTool' | 'errorWorkflow', id: string, name: string) => ({
  kind,
  nodeId: 'n',
  nodeName: 'Caller Node',
  mode: 'list' as const,
  rawValue: id,
  cachedName: name,
  resolution: 'resolved' as const,
  resolvedId: id,
  resolvedName: name,
});

describe('normalizeHost', () => {
  it('normalizes full URL and bare host:port to the same host', () => {
    expect(normalizeHost('http://localhost:5678')).toBe('localhost:5678');
    expect(normalizeHost('localhost:5678')).toBe('localhost:5678');
    expect(normalizeHost(null)).toBeNull();
  });
});

describe('buildEdges — confirmed call edges (blast-radius fan-in)', () => {
  it('turns resolved sub-workflow refs into confirmed call edges; fan-in is countable', () => {
    const target = wf('p', 'slack', 'Send Slack Alert', {});
    const callers = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      wf('p', id, `Caller ${id}`, { directDeps: [resolvedDep('subWorkflow', 'slack', 'Send Slack Alert')] }),
    );
    const edges = buildEdges([target, ...callers], [{ instanceId: 'p', label: 'prod', webhookHost: null }]);
    const toSlack = edges.filter((e) => e.dst.id === 'slack' && e.type === 'call');
    expect(toSlack).toHaveLength(5);
    expect(toSlack.every((e) => e.confidence === 'confirmed')).toBe(true);
  });

  it('does NOT emit an edge for a broken or dynamic ref (node badge, never a phantom edge)', () => {
    const brokenDep = { ...resolvedDep('subWorkflow', 'ghost', 'Ghost'), resolution: 'broken' as const, resolvedId: null, resolvedName: null };
    const dynDep = { ...resolvedDep('subWorkflow', 'x', 'X'), resolution: 'dynamic' as const, resolvedId: null };
    const w = wf('p', 'caller', 'Caller', { directDeps: [brokenDep, dynDep] });
    const edges = buildEdges([w], [{ instanceId: 'p', label: 'prod', webhookHost: null }]);
    expect(edges.filter((e) => e.type === 'call')).toHaveLength(0);
  });
});

describe('buildEdges — cross-instance webhook edge (the money finding)', () => {
  const instances: GraphInstance[] = [
    { instanceId: 'prod', label: 'prod', webhookHost: 'http://localhost:5678' },
    { instanceId: 'staging', label: 'staging', webhookHost: 'http://localhost:5679' },
  ];

  it('matches a staging HTTP call to a prod webhook by host + path → CONFIRMED cross-instance', () => {
    const prodOrderIntake = wf('prod', 'order-intake', 'Order Intake', {
      webhookEndpoints: [{ nodeName: 'Order Webhook', path: 'order-intake', isExpression: false }],
    });
    const stagingBridge = wf('staging', 'bridge', 'Staging → Prod Order Sync', {
      httpCallsites: [{ nodeName: 'Call Prod', rawUrl: 'http://localhost:5678/webhook/order-intake', host: 'localhost:5678', webhookPath: 'order-intake', isExpression: false }],
    });
    const edges = buildEdges([prodOrderIntake, stagingBridge], instances);
    const xi = edges.filter((e) => e.type === 'cross_instance_webhook');
    expect(xi).toHaveLength(1);
    expect(xi[0]).toMatchObject({ confidence: 'confirmed', crossInstance: true });
    expect(xi[0]?.src.instanceId).toBe('staging');
    expect(xi[0]?.dst.instanceId).toBe('prod');
  });

  it('an intra-instance HTTP→webhook match is POSSIBLE, never confirmed', () => {
    const target = wf('prod', 'wh', 'Webhook WF', { webhookEndpoints: [{ nodeName: 'W', path: 'foo', isExpression: false }] });
    const caller = wf('prod', 'http', 'HTTP WF', {
      httpCallsites: [{ nodeName: 'H', rawUrl: 'http://localhost:5678/webhook/foo', host: 'localhost:5678', webhookPath: 'foo', isExpression: false }],
    });
    const edges = buildEdges([target, caller], [{ instanceId: 'prod', label: 'prod', webhookHost: 'http://localhost:5678' }]);
    const wh = edges.filter((e) => e.type === 'webhook_http');
    expect(wh).toHaveLength(1);
    expect(wh[0]?.confidence).toBe('possible');
  });

  it('an expression-valued HTTP URL yields no edge (never a guess)', () => {
    const target = wf('prod', 'wh', 'Webhook WF', { webhookEndpoints: [{ nodeName: 'W', path: 'foo', isExpression: false }] });
    const caller = wf('prod', 'http', 'HTTP WF', {
      httpCallsites: [{ nodeName: 'H', rawUrl: '={{ $env.X }}', host: null, webhookPath: null, isExpression: true }],
    });
    const edges = buildEdges([target, caller], [{ instanceId: 'prod', label: 'prod', webhookHost: 'http://localhost:5678' }]);
    expect(edges.filter((e) => e.type === 'webhook_http' || e.type === 'cross_instance_webhook')).toHaveLength(0);
  });
});

describe('buildEdges — credential bindings (rotate impact)', () => {
  it('emits a confirmed binds_credential edge to a shared credential node', () => {
    const a = wf('p', 'a', 'A', { credentialRefs: [{ nodeName: 'n', credentialType: 'postgres', credentialId: 'C1', credentialName: 'Warehouse' }] });
    const b = wf('p', 'b', 'B', { credentialRefs: [{ nodeName: 'n', credentialType: 'postgres', credentialId: 'C1', credentialName: 'Warehouse' }] });
    const edges = buildEdges([a, b], [{ instanceId: 'p', label: 'prod', webhookHost: null }]);
    const binds = edges.filter((e) => e.type === 'binds_credential');
    expect(binds).toHaveLength(2);
    // Both point at the SAME credential node — that node's fan-in is the SPOF.
    expect(new Set(binds.map((e) => nodeIdOf(e.dst))).size).toBe(1);
    expect(binds.every((e) => e.confidence === 'confirmed')).toBe(true);
  });
});
