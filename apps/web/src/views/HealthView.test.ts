import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import HealthView from './HealthView.vue';

/**
 * Rule-11 UI-presence for the S3 "what's failing right now" view: the failing list,
 * summary, retention window, and the poll-fresh/honest-stale indicator all render.
 */
const item = (over: Record<string, unknown>) => ({
  instanceId: 'a', instanceLabel: 'prod', id: 'w1', name: 'Daily Stripe Reconciliation',
  active: false, isArchived: false, project: 'Revenue Ops', updatedAt: '2026-07-05T00:00:00.000Z',
  systems: [], triggers: [], mcpExposed: false, nodeCount: 2, understood: true, brokenRefCount: 0,
  enrichment: { status: 'analyzed', provider: 'openai', model: 'm', enrichedAt: '2026-07-05T00:00:00.000Z', corrected: false,
    summary: 's', description: 'd', category: 'revenue-ops', criticality: 'critical', criticalityReason: 'money', riskFlags: [], suggestedOwnerRationale: null, businessContext: null },
  health: { status: 'failing', failureRate: 1, runsInWindow: 4, failuresInWindow: 4, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'error', avgDurationMs: 5, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null },
  ...over,
});

const failingBody = {
  failing: [item({})],
  degraded: [item({ id: 'w2', name: 'Zendesk Sync', health: { status: 'degraded', failureRate: 0.5, runsInWindow: 6, failuresInWindow: 3, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'error', avgDurationMs: 5, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null } })],
  summary: { failing: 1, degraded: 1, healthy: 3, idle: 2, unknown: 0 },
  windows: [{ instanceId: 'a', instanceLabel: 'prod', windowHours: 336, available: true }],
  generatedAt: '2026-07-05T00:00:00.000Z',
};

function stubFetch(body: unknown = failingBody, connections: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const b = u.includes('/api/workflows/failing') ? body
      : u.includes('/api/connections') ? { connections }
        : {};
    return { ok: true, status: 200, json: async () => b };
  }));
}

const mountView = () => mount(HealthView, { global: { stubs: { 'router-link': RouterLinkStub } } });

describe('Health view — UI-presence (rule 11)', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('renders the view, failing list, summary, window and freshness indicator', async () => {
    stubFetch();
    const w = mountView();
    await flushPromises();
    const tid = (id: string) => w.find(`[data-testid="${id}"]`);

    expect(tid('health-view').exists()).toBe(true);
    expect(tid('health-failing-list').exists()).toBe(true);
    expect(tid('health-failing-list').text()).toContain('Daily Stripe Reconciliation');
    // Criticality rides along from S2.
    expect(tid('health-failing-list').text()).toContain('critical');
    // Summary strip + retention window shown honestly.
    expect(tid('health-summary').text()).toContain('failing');
    expect(tid('health-window').text()).toContain('~14 days');
    // Poll-fresh indicator present (healthy connections → "Polling").
    expect(tid('health-freshness').exists()).toBe(true);
    expect(tid('health-freshness').text()).toContain('Polling');
    w.unmount();
  });

  it('clicking a failing row opens the detail drawer for that workflow', async () => {
    stubFetch();
    const w = mountView();
    await flushPromises();
    // Drawer closed initially.
    expect(w.find('[role="dialog"]').exists()).toBe(false);
    // Click the first failing row.
    await w.find('[data-testid="health-failing-list"] tbody tr').trigger('click');
    await flushPromises();
    const drawer = w.find('[role="dialog"]');
    expect(drawer.exists()).toBe(true);
    expect(drawer.text()).toContain('Daily Stripe Reconciliation');
    w.unmount();
  });

  it('shows an empty state when nothing is failing or degraded', async () => {
    stubFetch({ failing: [], degraded: [], summary: { failing: 0, degraded: 0, healthy: 5, idle: 2, unknown: 0 },
      windows: [{ instanceId: 'a', instanceLabel: 'prod', windowHours: 336, available: true }], generatedAt: '2026-07-05T00:00:00.000Z' });
    const w = mountView();
    await flushPromises();
    expect(w.find('[data-testid="health-empty"]').exists()).toBe(true);
    expect(w.find('[data-testid="health-empty"]').text()).toContain('Nothing failing');
    w.unmount();
  });

  it('honest freshness: a not-syncing connection flips the pill to danger, never healthy', async () => {
    stubFetch(failingBody, [
      { id: 'b', label: 'staging', baseUrl: 'http://localhost:5679', webhookHost: null,
        createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-05T00:00:00.000Z',
        health: { status: 'unauthorized', lastSyncedAt: null, lastError: 'n8n rejected the API key (HTTP 401)', workflowCount: 0 } },
    ]);
    const w = mountView();
    await flushPromises();
    const pill = w.find('[data-testid="health-freshness"]');
    expect(pill.attributes('data-state')).toBe('failing');
    expect(pill.text()).toContain('not syncing');
    w.unmount();
  });
});
