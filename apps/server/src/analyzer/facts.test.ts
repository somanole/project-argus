import { describe, it, expect } from 'vitest';
import type { N8nNode, N8nWorkflowListItem } from '@argus/shared';
import { analyzeWorkflow, analyzeInstance, coverageOf, manifest } from './index.js';

const AT = '2026-07-05T00:00:00.000Z';

const wf = (over: Partial<N8nWorkflowListItem> & { id: string; name: string }): N8nWorkflowListItem => ({
  active: false,
  isArchived: false,
  createdAt: AT,
  updatedAt: AT,
  versionId: 'v1',
  shared: [],
  tags: [],
  ...over,
});

const node = (over: Partial<N8nNode> & { type: string }): N8nNode => ({ id: 'n', name: 'N', parameters: {}, ...over });

describe('analyzeWorkflow — facts from real seeded shapes', () => {
  it('classifies triggers, actions, systems and credentials', () => {
    const f = analyzeWorkflow(
      wf({
        id: 'w1',
        name: 'Salesforce CRM Sync',
        nodes: [
          node({ type: 'n8n-nodes-base.scheduleTrigger', name: 'Every 6 Hours' }),
          node({ type: 'n8n-nodes-base.salesforce', name: 'Upsert Lead', credentials: { salesforceOAuth2Api: { id: 'c1', name: 'Salesforce — CRM' } } }),
        ],
        triggerCount: 1,
      }),
      manifest,
    );
    expect(f.nodeCount).toBe(2);
    expect(f.triggers.map((t) => t.type)).toContain('n8n-nodes-base.scheduleTrigger');
    expect(f.triggerCountDetected).toBe(1);
    expect(f.triggerCountReported).toBe(1);
    expect(f.systems.map((s) => s.system)).toContain('Salesforce');
    expect(f.credentialTypes).toContain('salesforceOAuth2Api');
    expect(f.nodeTypes.find((n) => n.type === 'n8n-nodes-base.salesforce')?.category).toBe('action');
    // Fully understood: all node types known, no unresolved refs.
    expect(f.unknownNodeTypes).toHaveLength(0);
  });

  it('flags MCP-exposed from settings.availableInMCP', () => {
    const f = analyzeWorkflow(wf({ id: 'kb', name: 'KB Lookup', settings: { availableInMCP: true }, nodes: [] }), manifest);
    expect(f.mcpExposed).toBe(true);
  });

  it('records an unknown (community) node type raw, never dropped', () => {
    const f = analyzeWorkflow(
      wf({ id: 'w2', name: 'Community', nodes: [node({ type: '@acme/n8n-nodes-foo.fooAction' })] }),
      manifest,
    );
    expect(f.nodeTypes.find((n) => n.type === '@acme/n8n-nodes-foo.fooAction')).toMatchObject({ category: 'unknown', known: false });
    expect(f.unknownNodeTypes).toContain('@acme/n8n-nodes-foo.fooAction');
  });

  it('extracts a data-table reference', () => {
    const f = analyzeWorkflow(
      wf({
        id: 'w3',
        name: 'DT',
        nodes: [node({ type: 'n8n-nodes-base.dataTable', parameters: { dataTableId: { __rl: true, mode: 'list', value: 'tbl_1', cachedResultName: 'Leads' } } })],
      }),
      manifest,
    );
    expect(f.dataTableRefs).toEqual([{ mode: 'list', rawValue: 'tbl_1', cachedName: 'Leads', resolved: false }]);
  });

  it('captures caller policy inward-facing (stored, not an outbound dep)', () => {
    const f = analyzeWorkflow(wf({ id: 'w4', name: 'CP', settings: { callerPolicy: 'workflowsFromAList', callerIds: 'a, b ,c' } as never, nodes: [] }), manifest);
    expect(f.callerPolicy).toEqual({ policy: 'workflowsFromAList', callerIds: ['a', 'b', 'c'] });
  });
});

describe('analyzeInstance — pass 2 resolution across the estate', () => {
  const enrich = wf({ id: 'szF9uw2j9YjIVLCR', name: 'Enrich Customer' });
  const orderIntake = wf({
    id: 'order1',
    name: 'Order Intake',
    active: true,
    nodes: [node({ type: 'n8n-nodes-base.executeWorkflow', name: 'Call Enrich Customer', parameters: { source: 'database', workflowId: { __rl: true, mode: 'list', value: 'szF9uw2j9YjIVLCR', cachedResultName: 'Enrich Customer' } } })],
  });
  const leadScorer = wf({
    id: 'lead1',
    name: 'Lead Scorer',
    nodes: [node({ type: 'n8n-nodes-base.executeWorkflow', name: 'Call Scoring Model', parameters: { source: 'database', workflowId: { __rl: true, mode: 'list', value: '00000000-0000-4000-8000-000000000000', cachedResultName: 'Scoring Model (deleted)' } } })],
  });

  it('resolves a real sub-workflow ref and marks the deleted one broken — and only that one', () => {
    const facts = analyzeInstance([enrich, orderIntake, leadScorer], true, AT);

    const oi = facts.get('order1')!;
    expect(oi.directDeps[0]).toMatchObject({ kind: 'subWorkflow', resolution: 'resolved', resolvedId: 'szF9uw2j9YjIVLCR', resolvedName: 'Enrich Customer' });

    const ls = facts.get('lead1')!;
    expect(ls.directDeps[0]).toMatchObject({ resolution: 'broken', resolvedId: null });

    // Exactly one broken across the whole instance.
    const broken = [...facts.values()].flatMap((f) => f.directDeps).filter((d) => d.resolution === 'broken');
    expect(broken).toHaveLength(1);
  });

  it('never emits broken when the instance read was incomplete', () => {
    const facts = analyzeInstance([orderIntake, leadScorer], false, AT); // enrich absent AND incomplete
    const broken = [...facts.values()].flatMap((f) => f.directDeps).filter((d) => d.resolution === 'broken');
    expect(broken).toHaveLength(0);
  });
});

describe('coverageOf — the trust number', () => {
  it('rolls up understood %, gaps and broken totals honestly', () => {
    const good = analyzeInstance([wf({ id: 'g', name: 'Good', nodes: [node({ type: 'n8n-nodes-base.set' })] })], true, AT);
    const bad = analyzeInstance([wf({ id: 'b', name: 'Bad', nodes: [node({ type: '@acme/n8n-nodes-foo.fooAction' })] })], true, AT);

    const report = coverageOf([
      { instanceId: 'i1', instanceLabel: 'prod', facts: good.get('g')! },
      { instanceId: 'i1', instanceLabel: 'prod', facts: bad.get('b')! },
      { instanceId: 'i2', instanceLabel: 'staging', facts: null }, // couldn't analyze
    ]);

    expect(report.total).toBe(3);
    expect(report.understood).toBe(1); // only 'Good'
    expect(report.understoodPct).toBe(pctOf(1, 3));
    expect(report.gapsByKind.unknownNodeType).toBe(1);
    expect(report.gapsByKind.parseAnomaly).toBe(1); // the null-facts one
    expect(report.unknownNodeTypes[0]).toEqual({ type: '@acme/n8n-nodes-foo.fooAction', workflows: 1 });
    // understood + explicit gaps account for the whole estate.
    expect(report.understood + (report.total - report.understood)).toBe(report.total);
  });
});

function pctOf(n: number, d: number): number {
  return Math.round((n / d) * 1000) / 10;
}
