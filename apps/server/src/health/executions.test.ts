import { describe, it, expect } from 'vitest';
import type { N8nExecution } from '@argus/shared';
import { fetchWorkflowExecutions, type ExecutionDebugReader } from './executions.js';

const ex = (o: Partial<N8nExecution> & { id: string; status: string }): N8nExecution => ({ workflowId: 'wf1', ...o });
const BASE = 'http://localhost:5678';

describe('fetchWorkflowExecutions (on-demand drawer debug)', () => {
  it('maps recent runs with duration + per-run n8n deep link, and a redacted failure summary', async () => {
    const reader: ExecutionDebugReader = {
      recentExecutions: async () => [
        ex({ id: '9', status: 'error', startedAt: '2026-07-06T00:00:00.000Z', stoppedAt: '2026-07-06T00:00:00.005Z', mode: 'manual' }),
        ex({ id: '8', status: 'success', startedAt: '2026-07-05T00:00:00.000Z', stoppedAt: '2026-07-05T00:00:02.000Z', mode: 'webhook' }),
      ],
      executionDebug: async (id) => (id === '9' ? { failedNode: 'Fetch Stripe Ledger', errorType: 'NodeApiError', errorCode: 'ECONNREFUSED' } : null),
    };
    const r = await fetchWorkflowExecutions(reader, { baseUrl: BASE, workflowId: 'wf1' });
    expect(r.unavailable).toBe(false);
    expect(r.runs).toHaveLength(2);
    expect(r.runs[0]).toMatchObject({ executionId: '9', status: 'error', durationMs: 5, mode: 'manual' });
    expect(r.runs[0]?.deepLink).toBe('http://localhost:5678/workflow/wf1/executions/9');
    expect(r.runs[1]?.durationMs).toBe(2000);
    // Failure = the most recent failed run, redacted classification only.
    expect(r.failure).toEqual({
      executionId: '9', failedNode: 'Fetch Stripe Ledger', errorType: 'NodeApiError', errorCode: 'ECONNREFUSED',
      deepLink: 'http://localhost:5678/workflow/wf1/executions/9',
    });
  });

  it('no failure summary when recent runs all succeeded', async () => {
    const reader: ExecutionDebugReader = {
      recentExecutions: async () => [ex({ id: '1', status: 'success', startedAt: '2026-07-06T00:00:00.000Z', stoppedAt: '2026-07-06T00:00:01.000Z' })],
      executionDebug: async () => { throw new Error('should not be called'); },
    };
    const r = await fetchWorkflowExecutions(reader, { baseUrl: BASE, workflowId: 'wf1' });
    expect(r.failure).toBeNull();
    expect(r.runs).toHaveLength(1);
  });

  it('degrades honestly to unavailable when executions can\'t be read (rule 5)', async () => {
    const reader: ExecutionDebugReader = {
      recentExecutions: async () => { throw new Error('HTTP 403'); },
      executionDebug: async () => null,
    };
    const r = await fetchWorkflowExecutions(reader, { baseUrl: BASE, workflowId: 'wf1', reasonForError: () => 'missing execution:list' });
    expect(r.unavailable).toBe(true);
    expect(r.unavailableReason).toContain('execution:list');
    expect(r.runs).toEqual([]);
  });

  it('a failed run with no readable debug detail still lists + links, with null classification', async () => {
    const reader: ExecutionDebugReader = {
      recentExecutions: async () => [ex({ id: '5', status: 'error', startedAt: '2026-07-06T00:00:00.000Z', stoppedAt: '2026-07-06T00:00:00.001Z' })],
      executionDebug: async () => null, // e.g. detail 404 / redaction empty
    };
    const r = await fetchWorkflowExecutions(reader, { baseUrl: BASE, workflowId: 'wf1' });
    expect(r.failure).toMatchObject({ executionId: '5', failedNode: null, errorType: null, errorCode: null });
  });
});
