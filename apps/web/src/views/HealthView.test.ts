import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import HealthView from './HealthView.vue';

// A controllable route so the deep-link (?view=…) behaviour can be exercised; empty by
// default (matches the no-router case the other tests rely on).
const { mockRoute } = vi.hoisted(() => ({ mockRoute: { query: {} as Record<string, unknown> } }));
vi.mock('vue-router', () => ({ useRoute: () => mockRoute }));

/**
 * Rule-11 UI-presence for the S3 "what's failing right now" view: the failing list,
 * summary, retention window, and the poll-fresh/honest-stale indicator all render.
 */
const item = (over: Record<string, unknown>) => ({
  instanceId: 'a', instanceLabel: 'prod', id: 'w1', name: 'Daily Stripe Reconciliation',
  active: false, isArchived: false, project: 'Revenue Ops', updatedAt: '2026-07-05T00:00:00.000Z',
  systems: [], triggers: [], mcpExposed: false, nodeCount: 2, understood: true, brokenRefCount: 0, canMaskFailures: false,
  enrichment: { status: 'analyzed', provider: 'openai', model: 'm', enrichedAt: '2026-07-05T00:00:00.000Z', corrected: false,
    summary: 's', description: 'd', category: 'revenue-ops', criticality: 'critical', criticalityReason: 'money', riskFlags: [], suggestedOwnerRationale: null, businessContext: null },
  health: { status: 'failing', failureRate: 1, runsInWindow: 4, failuresInWindow: 4, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'error', avgDurationMs: 5, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null, silentFailures: null },
  owner: null,
  ...over,
});

const healthyItem = (id: string, name: string) => item({ id, name, enrichment: null,
  health: { status: 'healthy', failureRate: 0, runsInWindow: 10, failuresInWindow: 0, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'success', avgDurationMs: 5, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null, silentFailures: null } });
const idleItem = (id: string, name: string) => item({ id, name, enrichment: null,
  health: { status: 'idle', failureRate: null, runsInWindow: 0, failuresInWindow: 0, lastRunAt: null, lastStatus: null, avgDurationMs: null, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null, silentFailures: null } });

const failingBody = {
  failing: [item({})],
  degraded: [item({ id: 'w2', name: 'Zendesk Sync', health: { status: 'degraded', failureRate: 0.5, runsInWindow: 6, failuresInWindow: 3, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'error', avgDurationMs: 5, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null, silentFailures: null } })],
  healthy: [healthyItem('w3', 'Order Intake'), healthyItem('w4', 'Nightly Backup')],
  idle: [idleItem('w5', 'Send Slack Alert')],
  unknown: [],
  silentlyFailing: [],
  canMask: [],
  summary: { failing: 1, degraded: 1, healthy: 2, idle: 1, unknown: 0, silentlyFailing: 0, canMask: 0 },
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
  beforeEach(() => { setActivePinia(createPinia()); mockRoute.query = {}; });
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
    // S4: a failing workflow shows its owner (start of the incident view).
    expect(tid('incident-owner').exists()).toBe(true);
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

  it('shows a reassuring empty state when nothing is failing (default view)', async () => {
    stubFetch({ failing: [], degraded: [], healthy: [healthyItem('w3', 'Order Intake')], idle: [], unknown: [], silentlyFailing: [], canMask: [],
      summary: { failing: 0, degraded: 0, healthy: 5, idle: 2, unknown: 0, silentlyFailing: 0, canMask: 0 },
      windows: [{ instanceId: 'a', instanceLabel: 'prod', windowHours: 336, available: true }], generatedAt: '2026-07-05T00:00:00.000Z' });
    const w = mountView();
    await flushPromises();
    expect(w.find('[data-testid="health-empty"]').exists()).toBe(true);
    expect(w.find('[data-testid="health-empty"]').text()).toContain('Nothing failing');
    w.unmount();
  });

  it('summary tiles are clickable filters — every state (incl. healthy/idle) browses its list', async () => {
    stubFetch();
    const w = mountView();
    await flushPromises();
    const tid = (id: string) => w.find(`[data-testid="${id}"]`);
    const list = () => tid('health-failing-list');

    // Default view = failing; the failing tile is pressed and its row shows.
    expect(tid('health-tile-failing').attributes('aria-pressed')).toBe('true');
    expect(list().text()).toContain('Daily Stripe Reconciliation');

    // Click "healthy" → the list switches to the healthy workflows (browsable now).
    await tid('health-tile-healthy').trigger('click');
    expect(tid('health-tile-healthy').attributes('aria-pressed')).toBe('true');
    expect(tid('health-tile-failing').attributes('aria-pressed')).toBe('false');
    expect(list().text()).toContain('Order Intake');
    expect(list().text()).not.toContain('Daily Stripe Reconciliation');

    // Click "idle" → the idle set, which failing-only used to hide entirely.
    await tid('health-tile-idle').trigger('click');
    expect(list().text()).toContain('Send Slack Alert');
    w.unmount();
  });

  it('honest freshness: a not-syncing connection flips the pill to danger, never healthy', async () => {
    stubFetch(failingBody, [
      { id: 'b', label: 'staging', baseUrl: 'http://localhost:5679', webhookHost: null,
        createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-05T00:00:00.000Z',
        health: { status: 'unauthorized', lastSyncedAt: null, lastError: 'n8n rejected the API key (HTTP 401)', workflowCount: 0, analyzerDrift: null } },
    ]);
    const w = mountView();
    await flushPromises();
    const pill = w.find('[data-testid="health-freshness"]');
    expect(pill.attributes('data-state')).toBe('failing');
    expect(pill.text()).toContain('not syncing');
    w.unmount();
  });

  it('S6.3 — a silently-failing tile filters to the silently-failing list (green-but-broken)', async () => {
    const silent = item({ id: 'w9', name: 'Inventory Sync', enrichment: null,
      health: { status: 'healthy', failureRate: 0, runsInWindow: 4, failuresInWindow: 0, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'success', avgDurationMs: 5, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null,
        silentFailures: { runsAffected: 4, runsInspected: 4, lastNode: 'Push to Warehouse', lastErrorType: 'Error', lastErrorCode: 'ECONNREFUSED', lastSeenAt: '2026-07-05T00:00:00.000Z' } } });
    stubFetch({ ...failingBody, silentlyFailing: [silent], summary: { ...failingBody.summary, silentlyFailing: 1 } });
    const w = mountView();
    await flushPromises();
    const tile = w.find('[data-testid="health-tile-silent"]');
    expect(tile.exists()).toBe(true);
    expect(tile.text()).toContain('1');
    expect(tile.text()).toContain('silently failing');
    await tile.trigger('click');
    await flushPromises();
    const list = w.find('[data-testid="health-silent-list"]');
    expect(list.exists()).toBe(true);
    expect(list.text()).toContain('Inventory Sync');
    w.unmount();
  });

  it('S6.3 — a can-mask-failures tile filters to the config-risk set (distinct from health states)', async () => {
    const masker = item({ id: 'w8', name: 'Resilient Notifier', canMaskFailures: true, enrichment: null,
      health: { status: 'healthy', failureRate: 0, runsInWindow: 3, failuresInWindow: 0, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'success', avgDurationMs: 5, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null, silentFailures: null } });
    stubFetch({ ...failingBody, canMask: [masker], summary: { ...failingBody.summary, canMask: 1 } });
    const w = mountView();
    await flushPromises();
    const tile = w.find('[data-testid="health-tile-can-mask"]');
    expect(tile.exists()).toBe(true);
    expect(tile.text()).toContain('1');
    expect(tile.text()).toContain('can mask failures');
    await tile.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Resilient Notifier');
    w.unmount();
  });

  it('S6.3 — a ?view=silentlyFailing deep-link (from the Overview tile) lands on the silently-failing list', async () => {
    mockRoute.query = { view: 'silentlyFailing' };
    const silent = item({ id: 'w9', name: 'Inventory Sync', enrichment: null,
      health: { status: 'healthy', failureRate: 0, runsInWindow: 4, failuresInWindow: 0, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'success', avgDurationMs: 5, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null,
        silentFailures: { runsAffected: 4, runsInspected: 4, lastNode: 'Push to Warehouse', lastErrorType: 'Error', lastErrorCode: 'ECONNREFUSED', lastSeenAt: '2026-07-05T00:00:00.000Z' } } });
    stubFetch({ ...failingBody, silentlyFailing: [silent], summary: { ...failingBody.summary, silentlyFailing: 1 } });
    const w = mountView();
    await flushPromises();
    // Arrives already filtered to the silently-failing list (tile selected, list shows it).
    expect(w.find('[data-testid="health-tile-silent"]').classes()).toContain('on');
    const list = w.find('[data-testid="health-silent-list"]');
    expect(list.exists()).toBe(true);
    expect(list.text()).toContain('Inventory Sync');
    w.unmount();
  });

  it('consistency with Ownership — instance scope + search narrow the list; tiles stay estate-wide', async () => {
    const conn = (id: string, label: string, port: number) => ({ id, label, baseUrl: `http://localhost:${port}`, webhookHost: null,
      createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-05T00:00:00.000Z',
      health: { status: 'ok', lastSyncedAt: '2026-07-05T00:00:00.000Z', lastError: null, workflowCount: 1, analyzerDrift: null } });
    const prodWf = item({ id: 'p1', name: 'Prod Alpha', instanceId: 'a', instanceLabel: 'prod' });
    const stagingWf = item({ id: 's1', name: 'Staging Beta', instanceId: 'b', instanceLabel: 'staging' });
    stubFetch({ ...failingBody, failing: [prodWf, stagingWf], summary: { ...failingBody.summary, failing: 2 } }, [conn('a', 'prod', 5678), conn('b', 'staging', 5679)]);
    const w = mountView();
    await flushPromises();
    // The scope control + search field render (same as the Ownership register).
    expect(w.find('[data-testid="health-scope"]').exists()).toBe(true);
    expect(w.find('[data-testid="health-search"]').exists()).toBe(true);
    // Both instances' failing workflows show by default.
    expect(w.text()).toContain('Prod Alpha');
    expect(w.text()).toContain('Staging Beta');
    // Scope to staging → only staging remains, BUT the failing tile still reads 2 (estate-wide).
    const stagingBtn = w.findAll('[data-testid="health-scope"] button').find((b) => b.text().includes('staging'));
    await stagingBtn!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Staging Beta');
    expect(w.text()).not.toContain('Prod Alpha');
    expect(w.find('[data-testid="health-tile-failing"]').text()).toContain('2');
    w.unmount();
  });
});
