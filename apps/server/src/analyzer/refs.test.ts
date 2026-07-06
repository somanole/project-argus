import { describe, it, expect } from 'vitest';
import type { N8nNode } from '@argus/shared';
import { extractDirectRefs, parseWorkflowId, refFromNode, isExpression } from './refs.js';

const node = (over: Partial<N8nNode> & { type: string }): N8nNode => ({
  id: 'n1',
  name: 'Node',
  parameters: {},
  ...over,
});

describe('parseWorkflowId', () => {
  it('reads a bare-string id (executeWorkflow typeVersion 1)', () => {
    expect(parseWorkflowId('abc123')).toEqual({ mode: 'id', rawValue: 'abc123', cachedName: null, isExpression: false });
  });

  it('reads a resource locator in list mode (the id lives in `value`)', () => {
    const rl = { __rl: true, mode: 'list', value: 'szF9uw2j9YjIVLCR', cachedResultName: 'Enrich Customer' };
    expect(parseWorkflowId(rl)).toEqual({
      mode: 'list',
      rawValue: 'szF9uw2j9YjIVLCR',
      cachedName: 'Enrich Customer',
      isExpression: false,
    });
  });

  it('reads a resource locator in id and name modes', () => {
    expect(parseWorkflowId({ __rl: true, mode: 'id', value: 'x1' })?.mode).toBe('id');
    expect(parseWorkflowId({ __rl: true, mode: 'name', value: 'My Workflow' })?.mode).toBe('name');
  });

  it('flags an expression-valued id', () => {
    const p = parseWorkflowId({ __rl: true, mode: 'id', value: '={{ $json.wfId }}' });
    expect(p?.isExpression).toBe(true);
  });

  it('returns null when there is nothing to reference', () => {
    expect(parseWorkflowId(null)).toBeNull();
    expect(parseWorkflowId(undefined)).toBeNull();
    expect(parseWorkflowId('')).toBeNull();
    expect(parseWorkflowId({ __rl: true, mode: 'list', value: '' })).toBeNull();
  });

  it('drops an empty cachedResultName to null (display hint only)', () => {
    const p = parseWorkflowId({ __rl: true, mode: 'list', value: '1xUz5j2iin71WFaI', cachedResultName: '' });
    expect(p?.cachedName).toBeNull();
  });
});

describe('isExpression', () => {
  it('detects n8n expressions', () => {
    expect(isExpression('={{ $json.x }}')).toBe(true);
    expect(isExpression('plain-id')).toBe(false);
    expect(isExpression('has {{ mustache }}')).toBe(true);
    expect(isExpression(42)).toBe(false);
  });
});

describe('refFromNode (allow-listed, version-aware)', () => {
  it('extracts a subWorkflow ref from executeWorkflow (RL list mode)', () => {
    const n = node({
      type: 'n8n-nodes-base.executeWorkflow',
      name: 'Call Enrich Customer',
      parameters: { source: 'database', workflowId: { __rl: true, mode: 'list', value: 'szF9uw2j9YjIVLCR', cachedResultName: 'Enrich Customer' } },
    });
    expect(refFromNode(n)).toMatchObject({ kind: 'subWorkflow', mode: 'list', rawValue: 'szF9uw2j9YjIVLCR', dynamicSource: false });
  });

  it('extracts a bare-string subWorkflow ref (typeVersion 1)', () => {
    const n = node({ type: 'n8n-nodes-base.executeWorkflow', parameters: { source: 'database', workflowId: 'billingId' } });
    expect(refFromNode(n)).toMatchObject({ kind: 'subWorkflow', mode: 'id', rawValue: 'billingId' });
  });

  it('marks inline / non-database source as dynamic (no id)', () => {
    const n = node({ type: 'n8n-nodes-base.executeWorkflow', parameters: { source: 'parameter', workflowJson: '{...}' } });
    expect(refFromNode(n)).toMatchObject({ kind: 'subWorkflow', dynamicSource: true, rawValue: null });
  });

  it('extracts a toolWorkflow ref (langchain)', () => {
    const n = node({
      type: '@n8n/n8n-nodes-langchain.toolWorkflow',
      parameters: { workflowId: { __rl: true, mode: 'list', value: '1xUz5j2iin71WFaI', cachedResultName: '' } },
    });
    expect(refFromNode(n)).toMatchObject({ kind: 'toolWorkflow', mode: 'list', rawValue: '1xUz5j2iin71WFaI' });
  });

  it('emits NOTHING for agentTool with workflowId=null (never a broken ref)', () => {
    const n = node({ type: '@n8n/n8n-nodes-langchain.agentTool', parameters: { workflowId: null } });
    expect(refFromNode(n)).toBeNull();
  });

  it('ignores non-ref node types', () => {
    expect(refFromNode(node({ type: 'n8n-nodes-base.set' }))).toBeNull();
    expect(refFromNode(node({ type: 'n8n-nodes-base.slack' }))).toBeNull();
  });
});

describe('extractDirectRefs', () => {
  it('collects node refs plus the workflow-level errorWorkflow', () => {
    const refs = extractDirectRefs({
      nodes: [
        node({ type: 'n8n-nodes-base.executeWorkflow', parameters: { source: 'database', workflowId: { __rl: true, mode: 'list', value: 'sub1' } } }),
        node({ type: 'n8n-nodes-base.set' }),
      ],
      settings: { errorWorkflow: 'errWf1' },
    });
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.kind).sort()).toEqual(['errorWorkflow', 'subWorkflow']);
    const err = refs.find((r) => r.kind === 'errorWorkflow');
    expect(err).toMatchObject({ mode: 'id', rawValue: 'errWf1', nodeId: null });
  });

  it('emits no errorWorkflow ref when settings has none', () => {
    const refs = extractDirectRefs({ nodes: [], settings: { executionOrder: 'v1' } });
    expect(refs).toHaveLength(0);
  });
});
