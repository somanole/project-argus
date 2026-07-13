import { describe, it, expect } from 'vitest';
import { detectCanMaskFailures } from './mask.js';
import type { N8nWorkflowListItem } from '@argus/shared';

/** Minimal workflow-list-item builder for the detector (only nodes/connections/settings matter). */
function wf(over: Partial<N8nWorkflowListItem>): N8nWorkflowListItem {
  return {
    id: 'w', name: 'WF', active: true, isArchived: false, createdAt: 't', updatedAt: 't',
    versionId: null, shared: [], nodes: [], connections: {}, settings: {}, tags: [],
    ...over,
  } as N8nWorkflowListItem;
}
const node = (name: string, extra: Record<string, unknown> = {}) =>
  ({ id: name, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, parameters: {}, ...extra }) as N8nWorkflowListItem['nodes'] extends (infer T)[] ? T : never;

describe('detectCanMaskFailures — Layer 1 static config-risk (from intent)', () => {
  it('flags onError: continueRegularOutput, naming the node + mechanism', () => {
    const r = detectCanMaskFailures(wf({ nodes: [node('Push to Warehouse', { onError: 'continueRegularOutput' })] }));
    expect(r.flagged).toBe(true);
    expect(r.reasons).toEqual([{ nodeName: 'Push to Warehouse', mechanism: 'continue-regular-output' }]);
  });

  it('flags the legacy continueOnFail: true', () => {
    const r = detectCanMaskFailures(wf({ nodes: [node('Legacy', { continueOnFail: true })] }));
    expect(r.reasons).toEqual([{ nodeName: 'Legacy', mechanism: 'legacy-continue-on-fail' }]);
  });

  it('flags continueErrorOutput ONLY when the error output dead-ends (no downstream node)', () => {
    // Dead-end: no connections at all → error output goes nowhere → masks.
    const deadEnd = detectCanMaskFailures(wf({ nodes: [node('Risky', { onError: 'continueErrorOutput' })], connections: {} }));
    expect(deadEnd.flagged).toBe(true);
    expect(deadEnd.reasons[0]?.mechanism).toBe('dead-end-error-branch');

    // Handled: the error output (main index 1) IS connected → real handling, NOT a mask.
    const handled = detectCanMaskFailures(
      wf({
        nodes: [node('Risky', { onError: 'continueErrorOutput' }), node('Handle Error', {})],
        connections: { Risky: { main: [[], [{ node: 'Handle Error', type: 'main', index: 0 }]] } },
      }),
    );
    expect(handled.flagged).toBe(false);
  });

  it('does NOT flag a clean workflow (no swallow config) or a disabled swallowing node', () => {
    expect(detectCanMaskFailures(wf({ nodes: [node('Clean', {})] })).flagged).toBe(false);
    expect(detectCanMaskFailures(wf({ nodes: [node('Off', { onError: 'continueRegularOutput', disabled: true })] })).flagged).toBe(false);
    // Explicit stopWorkflow is the safe default → not a mask.
    expect(detectCanMaskFailures(wf({ nodes: [node('Safe', { onError: 'stopWorkflow' })] })).flagged).toBe(false);
  });

  it('is honest when unparsed: no nodes → not flagged, never a fabricated risk (rule 5)', () => {
    expect(detectCanMaskFailures(wf({ nodes: undefined })).flagged).toBe(false);
  });

  it('reports noErrorWorkflow context (amplifying, not the trigger)', () => {
    expect(detectCanMaskFailures(wf({ settings: {} })).noErrorWorkflow).toBe(true);
    expect(detectCanMaskFailures(wf({ settings: { errorWorkflow: 'wf-err' } })).noErrorWorkflow).toBe(false);
  });
});
