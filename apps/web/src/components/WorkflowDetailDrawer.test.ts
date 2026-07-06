import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { WorkflowListItem } from '@argus/shared';
import WorkflowDetailDrawer from './WorkflowDetailDrawer.vue';

/**
 * Rule-11: the on-demand execution-debug subsection (S3) — recent runs + the REDACTED
 * failure summary (failing node + error type/code) with per-run n8n deep links.
 */
const item: WorkflowListItem = {
  instanceId: 'a', instanceLabel: 'prod', id: 'w1', name: 'Daily Stripe Reconciliation',
  active: false, isArchived: false, project: 'Revenue Ops', updatedAt: '2026-07-05T00:00:00.000Z',
  systems: [], triggers: [], mcpExposed: false, nodeCount: 2, understood: true, brokenRefCount: 0,
  enrichment: null,
  health: { status: 'failing', failureRate: 1, runsInWindow: 4, failuresInWindow: 4, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'error', avgDurationMs: 5, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null },
};
const detailBody = { workflow: item, facts: null, deepLink: 'http://localhost:5678/workflow/w1' };
const executionsBody = {
  runs: [
    { executionId: '9', status: 'error', startedAt: '2026-07-05T00:00:00.000Z', stoppedAt: '2026-07-05T00:00:00.005Z', mode: 'manual', durationMs: 5, deepLink: 'http://localhost:5678/workflow/w1/executions/9' },
    { executionId: '8', status: 'error', startedAt: '2026-07-04T00:00:00.000Z', stoppedAt: '2026-07-04T00:00:00.004Z', mode: 'manual', durationMs: 4, deepLink: 'http://localhost:5678/workflow/w1/executions/8' },
  ],
  failure: { executionId: '9', failedNode: 'Fetch Stripe Ledger', errorType: 'NodeApiError', errorCode: 'ECONNREFUSED', deepLink: 'http://localhost:5678/workflow/w1/executions/9' },
  unavailable: false, unavailableReason: null, generatedAt: '2026-07-05T00:00:00.000Z',
};

function stubFetch(execBody: unknown = executionsBody) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.includes('/executions') ? execBody : detailBody;
    return { ok: true, status: 200, json: async () => body };
  }));
}

describe('WorkflowDetailDrawer — execution debug (rule 11)', () => {
  beforeEach(() => stubFetch());
  afterEach(() => vi.unstubAllGlobals());

  it('shows the redacted failure summary (failing node + error class) and the deep link', async () => {
    const w = mount(WorkflowDetailDrawer, { props: { selected: item } });
    await flushPromises();
    const fail = w.find('[data-testid="execution-failure"]');
    expect(fail.exists()).toBe(true);
    expect(fail.text()).toContain('Fetch Stripe Ledger');
    expect(fail.text()).toContain('NodeApiError');
    expect(fail.text()).toContain('ECONNREFUSED');
    // Never renders raw logs/messages — only the classification + a link to n8n.
    expect(fail.find('a').attributes('href')).toBe('http://localhost:5678/workflow/w1/executions/9');
  });

  it('lists recent runs with per-run n8n deep links', async () => {
    const w = mount(WorkflowDetailDrawer, { props: { selected: item } });
    await flushPromises();
    const runs = w.find('[data-testid="execution-runs"]');
    expect(runs.exists()).toBe(true);
    const links = runs.findAll('a');
    expect(links).toHaveLength(2);
    expect(links[0]?.attributes('href')).toBe('http://localhost:5678/workflow/w1/executions/9');
  });

  it('degrades honestly when executions are unavailable (no fabricated runs)', async () => {
    stubFetch({ runs: [], failure: null, unavailable: true, unavailableReason: 'executions unavailable — the API key may lack execution:list', generatedAt: '2026-07-05T00:00:00.000Z' });
    const w = mount(WorkflowDetailDrawer, { props: { selected: item } });
    await flushPromises();
    expect(w.find('[data-testid="execution-runs"]').exists()).toBe(false);
    expect(w.text()).toContain('execution:list');
  });
});
