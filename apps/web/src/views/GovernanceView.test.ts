import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import GovernanceView from './GovernanceView.vue';

/**
 * Rule-11 UI-presence for the S4 Governance view: the governance-gaps panel with each
 * gap group renders. (The audit timeline moved to its own Activity view — see
 * ActivityView.test.ts.)
 */
const gap = (over: Record<string, unknown>) => ({
  instanceId: 'a', instanceLabel: 'prod', workflowId: 'w1', name: 'Daily Stripe Reconciliation',
  criticality: 'critical', criticalityReason: 'money', ...over,
});

const gapsBody = {
  unowned: [gap({ workflowId: 'u1', name: 'Orphan Report', inferred: null })],
  singleOwnerCritical: [{
    owner: { email: 'sam@corp.io', name: 'Sam Rivers' },
    workflows: [gap({}), gap({ workflowId: 'w2', name: 'Refund Processor', instanceLabel: 'staging', instanceId: 'b' })],
    crossInstance: true,
  }],
  personalSpaceCritical: [gap({ workflowId: 'p1', name: 'Personal Ops Hack', person: { email: 'diana@n8n.io', name: 'Diana' } })],
  noBackupOwner: [gap({ workflowId: 'nb1', name: 'Invoice Dispatch', owner: { email: 'sam@corp.io', name: 'Sam' } })],
  generatedAt: '2026-07-07T00:00:00.000Z',
};

const auditBody = {
  entries: [
    { id: 2, ts: '2026-07-07T10:00:00.000Z', actorName: 'Ops Admin', actorEmail: 'ops@argus.io', action: 'ownership.assign', entityType: 'workflow_ownership', entityId: 'a/w1', detail: { after: { ownerEmail: 'sam@corp.io' } } },
  ],
  actions: ['ownership.assign', 'connection.register'],
  generatedAt: '2026-07-07T00:00:00.000Z',
};

function stubFetch(gaps: unknown = gapsBody, audit: unknown = auditBody) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const b = u.includes('/api/ownership/gaps') ? gaps : u.includes('/api/ownership/audit') ? audit : {};
    return { ok: true, status: 200, json: async () => b };
  }));
}

const mountView = () => mount(GovernanceView, { global: { stubs: { 'router-link': RouterLinkStub } } });

describe('Governance view — UI-presence (rule 11)', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('renders the view and all four gap groups', async () => {
    stubFetch();
    const w = mountView();
    await flushPromises();
    const tid = (id: string) => w.find(`[data-testid="${id}"]`);

    expect(tid('governance-view').exists()).toBe(true);
    expect(tid('governance-gaps').exists()).toBe(true);

    // Each governance-gap group renders with its content.
    expect(tid('gap-unowned').text()).toContain('Orphan Report');
    expect(tid('gap-single-owner').text()).toContain('Sam Rivers');
    expect(tid('gap-single-owner').text()).toContain('across instances');
    expect(tid('gap-personal-space').text()).toContain('Personal Ops Hack');
    expect(tid('gap-no-backup').text()).toContain('Invoice Dispatch');

    // The audit timeline no longer lives here — it moved to the Activity view.
    expect(tid('governance-audit-timeline').exists()).toBe(false);
    w.unmount();
  });

  it('shows a clean state when there are no gaps', async () => {
    stubFetch({ unowned: [], singleOwnerCritical: [], personalSpaceCritical: [], noBackupOwner: [], generatedAt: '2026-07-07T00:00:00.000Z' });
    const w = mountView();
    await flushPromises();
    expect(w.find('[data-testid="governance-gaps"]').text()).toContain('No governance gaps');
    w.unmount();
  });
});
