import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import GovernanceView from './GovernanceView.vue';

// The view reads a ?view=… deep-link on mount; stub a bare route so it mounts without a
// full router (these tests assert the register table + summary/filter presence).
vi.mock('vue-router', async (orig) => ({ ...(await orig<object>()), useRoute: () => ({ query: {}, hash: '' }) }));

/**
 * Rule-11 UI-presence for the S4 Ownership view: the accountability summary strip (which
 * doubles as the primary filter), the clickable register table with owner · backup · risk,
 * and the pager all render. Rows open the shared detail drawer (assign-owner flow).
 */
const listItem = (over: Record<string, unknown>) => ({
  instanceId: 'a', instanceLabel: 'prod', id: 'w1', name: 'Refund Processor',
  active: true, isArchived: false, project: 'Revenue Ops', updatedAt: '2026-07-05T00:00:00.000Z',
  systems: [], triggers: [], mcpExposed: false, nodeCount: 2, understood: true, brokenRefCount: 0, canMaskFailures: false,
  enrichment: { status: 'analyzed', provider: 'o', model: 'm', enrichedAt: '2026-07-05T00:00:00.000Z', corrected: false,
    summary: 's', description: 'd', category: 'revenue-ops', criticality: 'critical', criticalityReason: 'money', riskFlags: [], suggestedOwnerRationale: null, businessContext: null },
  health: null,
  owner: { status: 'inferred', owner: { email: 'nathan@n8n.io', name: 'Nathan Owner' }, backupOwner: null, reason: 'member', source: 'project-member', memberRole: 'project:admin', assignedBy: null, assignedAt: null },
  risks: ['no-confirmed-owner'],
  ...over,
});

const registerBody = {
  rows: [
    listItem({}),
    listItem({ id: 'w2', name: 'Route Asset #32', owner: { status: 'assigned', owner: { email: 'sam@corp.io', name: 'Sam Rivers' }, backupOwner: null, reason: null, source: 'assigned', memberRole: null, assignedBy: null, assignedAt: '2026-07-05T00:00:00.000Z' }, risks: ['no-backup'] }),
  ],
  summary: { total: 201, confirmed: 2, inferred: 199, unowned: 0, criticalAtRisk: 2, noBackup: 0 },
  total: 199,
  limit: 50,
  offset: 0,
  generatedAt: '2026-07-07T00:00:00.000Z',
};

function stubFetch(register: unknown = registerBody) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const b = u.includes('/api/ownership/register') ? register : u.includes('/api/connections') ? { connections: [] } : {};
    return { ok: true, status: 200, json: async () => b };
  }));
}

const mountView = () => mount(GovernanceView, { global: { stubs: { 'router-link': RouterLinkStub } } });

describe('Ownership view — register (rule 11)', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('renders the summary strip, the clickable register table (owner/backup/risk), and the pager', async () => {
    stubFetch();
    const w = mountView();
    await flushPromises();
    const tid = (id: string) => w.find(`[data-testid="${id}"]`);

    expect(tid('governance-view').exists()).toBe(true);

    // Summary strip (posture) with the confirmed count + clickable filter tiles.
    expect(tid('ownership-summary').exists()).toBe(true);
    expect(tid('ownership-confirmed').text()).toContain('2');
    for (const v of ['needs-owner', 'unowned', 'critical-at-risk', 'no-backup']) {
      expect(tid(`ownership-filter-${v}`).exists()).toBe(true);
    }
    expect(tid('ownership-filter-no-backup').text()).toContain('No backup owner');

    // Poll-fresh indicator (consistent with Explore/Health) + synced + Refresh.
    expect(tid('ownership-freshness').exists()).toBe(true);
    expect(tid('ownership-freshness').text()).toContain('Polling');
    expect(tid('synced-indicator').exists()).toBe(true);

    // The register table with owner + backup + risk.
    expect(tid('ownership-register').exists()).toBe(true);
    expect(tid('ownership-register').text()).toContain('Refund Processor');
    expect(tid('ownership-register').text()).toContain('Nathan Owner'); // owner (inferred)
    expect(tid('ownership-register').text()).toContain('Sam Rivers'); // assigned owner
    expect(tid('ownership-register').text()).toContain('no confirmed owner'); // risk chip
    expect(tid('ownership-register').text()).toContain('no backup'); // risk chip

    // Pager (199 > 50 → shows).
    expect(tid('pager').exists()).toBe(true);
    expect(tid('pager-range').text()).toContain('1–50 of 199');
    w.unmount();
  });

  it('a filter tile switches the working set (fetches state/risk params)', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      fetched.push(u);
      const b = u.includes('/api/ownership/register') ? registerBody : u.includes('/api/connections') ? { connections: [] } : {};
      return { ok: true, status: 200, json: async () => b };
    }));
    const w = mountView();
    await flushPromises();

    await w.find('[data-testid="ownership-filter-critical-at-risk"]').trigger('click');
    await flushPromises();
    expect(fetched.some((u) => u.includes('criticalAtRisk=true'))).toBe(true);
    w.unmount();
  });

  it('opens the detail drawer when a row is clicked (assign-owner surface)', async () => {
    stubFetch();
    const w = mountView();
    await flushPromises();
    expect(w.find('.drawer, [data-testid="workflow-drawer"]').exists()).toBe(false);
    await w.find('[data-testid="ownership-register"] tbody tr').trigger('click');
    await flushPromises();
    // The drawer renders the selected workflow's name.
    expect(w.text()).toContain('Refund Processor');
    w.unmount();
  });

  it('shows an honest empty state when nothing matches', async () => {
    stubFetch({ rows: [], summary: { total: 201, confirmed: 201, inferred: 0, unowned: 0, criticalAtRisk: 0, noBackup: 0 }, total: 0, limit: 50, offset: 0, generatedAt: '2026-07-07T00:00:00.000Z' });
    const w = mountView();
    await flushPromises();
    expect(w.find('[data-testid="ownership-empty"]').text()).toContain('no workflows match');
    w.unmount();
  });
});
