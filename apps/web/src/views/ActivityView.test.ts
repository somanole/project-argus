import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ActivityView from './ActivityView.vue';

/**
 * Rule-11 UI-presence for the Activity view: the filterable + CSV-exportable audit
 * timeline renders (moved out of the Ownership lens into its own side-panel page).
 */
const auditBody = {
  entries: [
    { id: 2, ts: '2026-07-07T10:00:00.000Z', actorName: 'Ops Admin', actorEmail: 'ops@argus.io', action: 'ownership.assign', entityType: 'workflow_ownership', entityId: 'a/w1', detail: { after: { ownerEmail: 'sam@corp.io' } } },
  ],
  actions: ['ownership.assign', 'connection.register'],
  total: 120,
  limit: 50,
  offset: 0,
  generatedAt: '2026-07-07T00:00:00.000Z',
};

// Captures the URLs the store fetches so pagination assertions can inspect limit/offset.
let fetched: string[] = [];
function stubFetch(audit: unknown = auditBody) {
  fetched = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    fetched.push(u);
    const b = u.includes('/api/ownership/audit') ? audit : {};
    return { ok: true, status: 200, json: async () => b };
  }));
}

const mountView = () => mount(ActivityView, { global: { stubs: { 'router-link': RouterLinkStub } } });

describe('Activity view — UI-presence (rule 11)', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('renders the audit timeline, filters, and CSV export', async () => {
    stubFetch();
    const w = mountView();
    await flushPromises();
    const tid = (id: string) => w.find(`[data-testid="${id}"]`);

    expect(tid('activity-view').exists()).toBe(true);

    // The audit timeline with its entries.
    expect(tid('governance-audit-timeline').exists()).toBe(true);
    expect(tid('governance-audit-timeline').text()).toContain('ownership.assign');
    expect(tid('governance-audit-timeline').text()).toContain('Ops Admin');

    // Filter controls.
    expect(tid('audit-filter-action').exists()).toBe(true);
    expect(tid('audit-filter-actor').exists()).toBe(true);

    // Export control — filter-only, no pagination params leak into the CSV link.
    const exportLink = tid('governance-audit-export');
    expect(exportLink.exists()).toBe(true);
    expect(exportLink.attributes('href')).toContain('/api/ownership/audit/export.csv');
    expect(exportLink.attributes('href')).not.toContain('offset');

    // Pager shows the range + of-total; the first page fetched offset=0.
    expect(tid('audit-pager').exists()).toBe(true);
    expect(tid('audit-pager-range').text()).toContain('1–1 of 120');
    expect(fetched.some((u) => u.includes('limit=50') && u.includes('offset=0'))).toBe(true);
    w.unmount();
  });

  it('pages forward: Next is enabled and fetches the next offset', async () => {
    stubFetch();
    const w = mountView();
    await flushPromises();
    const tid = (id: string) => w.find(`[data-testid="${id}"]`);

    // 120 total, 50/page → Previous disabled on page 1, Next enabled.
    expect(tid('audit-pager-prev').attributes('disabled')).toBeDefined();
    expect(tid('audit-pager-next').attributes('disabled')).toBeUndefined();

    await tid('audit-pager-next').trigger('click');
    await flushPromises();
    expect(fetched.some((u) => u.includes('offset=50'))).toBe(true);
    w.unmount();
  });

  it('shows an honest empty state (and no pager) when no entries match', async () => {
    stubFetch({ entries: [], actions: [], total: 0, limit: 50, offset: 0, generatedAt: '2026-07-07T00:00:00.000Z' });
    const w = mountView();
    await flushPromises();
    expect(w.find('[data-testid="governance-audit-timeline"]').text()).toContain('No audit entries match');
    expect(w.find('[data-testid="audit-pager"]').exists()).toBe(false);
    w.unmount();
  });
});
