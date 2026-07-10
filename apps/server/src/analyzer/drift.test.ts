import { describe, it, expect } from 'vitest';
import type { WorkflowFacts } from '@argus/shared';
import { computeAnalyzerDrift, isCoreNodeType } from './drift.js';

// The drift computation reads ONLY facts.coverage.unknownNodeTypes, so fixtures are minimal.
const facts = (unknownNodeTypes: string[]): WorkflowFacts =>
  ({ coverage: { understood: unknownNodeTypes.length === 0, unknownNodeTypes, unresolvedRefs: 0, reasons: [] } } as unknown as WorkflowFacts);

describe('isCoreNodeType', () => {
  it('recognizes both core namespaces', () => {
    expect(isCoreNodeType('n8n-nodes-base.slack')).toBe(true);
    expect(isCoreNodeType('@n8n/n8n-nodes-langchain.agent')).toBe(true);
  });
  it('treats any other namespace as community/custom', () => {
    expect(isCoreNodeType('n8n-nodes-acme.thing')).toBe(false);
    expect(isCoreNodeType('CUSTOM.node')).toBe(false);
  });
});

describe('computeAnalyzerDrift', () => {
  it('no unrecognized types → current, no alert', () => {
    const d = computeAnalyzerDrift([facts([]), facts([])], '2.29.0');
    expect(d.status).toBe('current');
    expect(d.coreUnknown).toEqual({ types: 0, workflows: 0 });
    expect(d.communityUnknown).toEqual({ types: 0, workflows: 0 });
    expect(d.manifestN8nVersion).toBe('2.29.0');
  });

  it('unrecognized CORE type → core-drift with distinct-type + workflow counts', () => {
    const d = computeAnalyzerDrift([
      facts(['n8n-nodes-base.__futureNode']),
      facts(['n8n-nodes-base.__futureNode', '@n8n/n8n-nodes-langchain.__newAgent']),
      facts([]),
    ], '2.29.0');
    expect(d.status).toBe('core-drift');
    // 2 DISTINCT core types across 2 workflows.
    expect(d.coreUnknown).toEqual({ types: 2, workflows: 2 });
    expect(d.communityUnknown.types).toBe(0);
    // The listed names are the ACTUAL unrecognized core types, not illustrations.
    expect(d.coreExamples).toContain('n8n-nodes-base.__futureNode');
    expect(d.communityExamples).toEqual([]);
  });

  it('only community/custom types → community-only (no regenerate case)', () => {
    const d = computeAnalyzerDrift([facts(['n8n-nodes-acme.foo']), facts(['n8n-nodes-acme.bar'])], '2.29.0');
    expect(d.status).toBe('community-only');
    expect(d.communityUnknown).toEqual({ types: 2, workflows: 2 });
    expect(d.coreUnknown.types).toBe(0);
  });

  it('when both kinds are present, core-drift wins (the regenerate case is actionable)', () => {
    const d = computeAnalyzerDrift([facts(['n8n-nodes-base.__futureNode', 'n8n-nodes-acme.foo'])], '2.29.0');
    expect(d.status).toBe('core-drift');
    expect(d.coreUnknown).toEqual({ types: 1, workflows: 1 });
    // The single workflow contributes to BOTH buckets.
    expect(d.communityUnknown).toEqual({ types: 1, workflows: 1 });
  });

  it('null facts (couldn\'t-analyze workflows) contribute no drift signal', () => {
    const d = computeAnalyzerDrift([null, facts([]), null], '2.29.0');
    expect(d.status).toBe('current');
  });

  it('lists the ACTUAL types split by kind, capped, with the total preserved for "+N more"', () => {
    const many = Array.from({ length: 10 }, (_, i) => `n8n-nodes-base.__n${i}`);
    const d = computeAnalyzerDrift([facts([...many, 'n8n-nodes-acme.z'])], '2.29.0');
    // Core list is capped but the true total is kept, so the UI can show "+N more".
    expect(d.coreExamples.length).toBeLessThanOrEqual(6);
    expect(d.coreUnknown.types).toBe(10);
    expect(d.coreExamples.every((t) => isCoreNodeType(t))).toBe(true);
    // Community names live in their OWN list — never mixed into the core-drift message.
    expect(d.communityExamples).toEqual(['n8n-nodes-acme.z']);
    expect(d.coreExamples).not.toContain('n8n-nodes-acme.z');
  });
});
