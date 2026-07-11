import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import OverviewView from './OverviewView.vue';

/**
 * Rule-11 UI-presence for the S6 governance overview: the score + pillar breakdown and
 * every headline metric tile render, each tile NAVIGATES to its exact set (no inline
 * drill), and the uncertainty caveats (advisory owner, health-unavailable, confirmed-
 * reach-only) are preserved in the tooltips — nothing laundered.
 */
const listItem = (over: Record<string, unknown>) => ({
  instanceId: 'a', instanceLabel: 'prod', id: 'w1', name: 'Daily Stripe Reconciliation',
  active: true, isArchived: false, project: 'Revenue Ops', updatedAt: '2026-07-05T00:00:00.000Z',
  systems: [], triggers: [], mcpExposed: false, nodeCount: 2, understood: true, brokenRefCount: 0,
  enrichment: { status: 'analyzed', provider: 'openai', model: 'm', enrichedAt: '2026-07-05T00:00:00.000Z', corrected: false,
    summary: 's', description: 'd', category: 'revenue-ops', criticality: 'critical', criticalityReason: 'money', riskFlags: [], suggestedOwnerRationale: null, businessContext: null },
  health: { status: 'failing', failureRate: 0.75, runsInWindow: 4, failuresInWindow: 3, lastRunAt: '2026-07-05T00:00:00.000Z', lastStatus: 'error', avgDurationMs: 5, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null },
  owner: { status: 'assigned', owner: { email: 'sam@corp.io', name: 'Sam Rivers' }, backupOwner: null, reason: null, source: 'assigned', memberRole: null, assignedBy: null, assignedAt: '2026-07-05T00:00:00.000Z' },
  ...over,
});

const pillar = (key: string, label: string, score: number | null, inputs: Record<string, number> = { total: 3 }) => ({
  key, label, weight: 0.2, effectiveWeight: score == null ? 0 : 0.25, score, scored: score != null,
  reason: `${label} reason`, inputs,
});

const overviewBody = {
  score: {
    score: 62.5,
    pillars: [
      pillar('ownership', 'Ownership', 70, { total: 201, assigned: 2, unowned: 199, criticalUnowned: 2 }),
      pillar('reliability', 'Reliability', null), // one unscored — "couldn't score" must render
      pillar('resilience', 'Accountability resilience', 55),
      pillar('hygiene', 'Hygiene', 90),
      pillar('exposure', 'Exposure', 40),
    ],
  },
  unowned: {
    total: 2,
    byCriticality: { critical: 1, high: 0, medium: 1, low: 0, none: 0 },
    workflows: [
      { instanceId: 'a', instanceLabel: 'prod', workflowId: 'u1', name: 'Unowned Critical', criticality: 'critical', criticalityReason: 'r',
        inferred: { status: 'inferred', owner: { email: 'lee@corp.io', name: 'Lee' }, backupOwner: null, reason: 'member', source: 'project-member', memberRole: 'project:admin', assignedBy: null, assignedAt: null } },
      { instanceId: 'a', instanceLabel: 'prod', workflowId: 'u2', name: 'Unowned Medium', criticality: 'medium', criticalityReason: 'r', inferred: null },
    ],
  },
  spofOwners: [
    { owner: { email: 'sam@corp.io', name: 'Sam Rivers' }, crossInstance: true, workflows: [
      { instanceId: 'a', instanceLabel: 'prod', workflowId: 'w1', name: 'Billing', criticality: 'critical', criticalityReason: 'r' },
      { instanceId: 'b', instanceLabel: 'staging', workflowId: 'w2', name: 'Payouts', criticality: 'critical', criticalityReason: 'r' },
    ] },
  ],
  personalSpaceCritical: [
    { instanceId: 'a', instanceLabel: 'prod', workflowId: 'p1', name: 'Personal Critical', criticality: 'critical', criticalityReason: 'r', person: { email: 'jo@corp.io', name: 'Jo' } },
  ],
  noBackupOwner: [],
  failingWithOwner: { count: 1, workflows: [listItem({})] },
  hygiene: {
    brokenRefs: { count: 1, workflows: [listItem({ id: 'b1', name: 'Broken Refs WF', brokenRefCount: 2 })] },
    staleEnrichment: { count: 0, workflows: [] },
    activeNoExecutions: { count: 1, workflows: [listItem({ id: 'i1', name: 'Idle Active WF', health: { status: 'idle', failureRate: null, runsInWindow: 0, failuresInWindow: 0, lastRunAt: null, lastStatus: null, avgDurationMs: null, windowHours: 336, computedAt: '2026-07-05T00:00:00.000Z', unavailableReason: null } })] },
  },
  exposure: {
    mcpExposed: 2, reachingSensitive: 1, reachingSensitiveUnowned: 1,
    surfaces: [
      { instanceId: 'a', instanceLabel: 'prod', workflowId: 'm1', name: 'Public Agent', owned: false, ownerLabel: null, reachesSensitive: true, sensitiveSystems: ['stripe'], reachableWorkflows: 3 },
      { instanceId: 'a', instanceLabel: 'prod', workflowId: 'm2', name: 'Safe Agent', owned: true, ownerLabel: 'Sam', reachesSensitive: false, sensitiveSystems: [], reachableWorkflows: 1 },
    ],
  },
  changelog: [
    { id: 5, ts: '2026-07-06T00:00:00.000Z', actorName: 'Ops', actorEmail: 'ops@argus.io', action: 'ownership.assign', entityType: 'workflow_ownership', entityId: 'a/w1', detail: null },
  ],
  health: {
    summary: { failing: 1, degraded: 0, healthy: 3, idle: 1, unknown: 2 },
    windows: [
      { instanceId: 'a', instanceLabel: 'prod', windowHours: 336, available: true },
      { instanceId: 'b', instanceLabel: 'staging', windowHours: 336, available: false },
    ],
  },
  generatedAt: '2026-07-06T00:00:00.000Z',
};

function stubFetch(body: unknown = overviewBody) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const b = u.includes('/api/governance/overview') ? body : {};
    return { ok: true, status: 200, json: async () => b };
  }));
}

const mountView = () => mount(OverviewView, { global: { stubs: { 'router-link': RouterLinkStub } } });

describe('Governance overview — UI-presence (rule 11)', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('renders the score, five-pillar breakdown, and every headline tile', async () => {
    stubFetch();
    const w = mountView();
    await flushPromises();
    const tid = (id: string) => w.find(`[data-testid="${id}"]`);

    expect(tid('overview-view').exists()).toBe(true);
    // Score + breakdown + band.
    expect(tid('overview-score').text()).toContain('62.5');
    expect(tid('overview-score').text()).toContain('Fair'); // 62.5 → Fair band
    expect(tid('overview-score-breakdown').exists()).toBe(true);
    expect(tid('overview-score-breakdown').text()).toContain('Ownership');
    // An unscored pillar shows "couldn't score", never a fabricated number.
    expect(tid('overview-score-breakdown').text()).toContain('couldn’t score');
    // The pillar's headline VALUE is surfaced inline (from inputs), not just hidden in the ⓘ.
    expect(tid('overview-score-breakdown').text()).toContain('199 of 201 unowned');
    // The unscored pillar surfaces no value line (no fabricated figure).
    expect(w.findAll('[data-testid="pillar-value"]').length).toBe(4); // 4 of 5 pillars scored

    // Every headline tile renders (hygiene is now three peer tiles: broken/stale/idle-active).
    for (const id of ['overview-unowned', 'overview-spof', 'overview-incidents', 'overview-broken', 'overview-stale', 'overview-idle-active', 'overview-exposure', 'overview-personal-space', 'overview-changelog', 'overview-export']) {
      expect(tid(id).exists()).toBe(true);
    }
    // Unowned tile shows its criticality context + count.
    expect(tid('overview-unowned').text()).toContain('1 critical');
    expect(tid('overview-unowned').text()).toContain('2');

    // "View all →" points at the Activity view (not the old ownership page).
    const auditLink = tid('overview-changelog').findComponent(RouterLinkStub);
    expect(auditLink.props('to')).toBe('/activity');
    w.unmount();
  });

  it('every tile navigates to its exact set (no inline drill)', async () => {
    stubFetch();
    const w = mountView();
    await flushPromises();
    const linkTo = (id: string) => w.find(`[data-testid="${id}"]`).findComponent(RouterLinkStub).props('to');

    // Accountability tiles deep-link to the matching Ownership gap section.
    expect(linkTo('overview-unowned')).toEqual({ path: '/estate/ownership', hash: '#gap-unowned' });
    expect(linkTo('overview-spof')).toEqual({ path: '/estate/ownership', hash: '#gap-single-owner' });
    expect(linkTo('overview-personal-space')).toEqual({ path: '/estate/ownership', hash: '#gap-personal-space' });
    // Operations tiles deep-link to Health / filtered Estate / Graph.
    expect(linkTo('overview-incidents')).toBe('/estate/health');
    expect(linkTo('overview-broken')).toEqual({ path: '/estate', query: { broken: 'true' } });
    expect(linkTo('overview-stale')).toEqual({ path: '/estate', query: { stale: 'true' } });
    expect(linkTo('overview-idle-active')).toEqual({ path: '/estate', query: { health: 'idle', active: 'true' } });
    expect(linkTo('overview-exposure')).toEqual({ path: '/estate', query: { mcp: 'true' } });

    // No inline drill anywhere anymore.
    expect(w.find('[data-testid="overview-unowned-drill"]').exists()).toBe(false);
    w.unmount();
  });

  it('preserves uncertainty in the tooltips: advisory owner, health-unavailable, confirmed-reach-only', async () => {
    stubFetch();
    const w = mountView();
    await flushPromises();
    // Health unavailable banner (staging) — never laundered into "healthy".
    expect(w.find('[data-testid="overview-health-unavailable"]').text()).toContain('staging');
    // Confirmed-reach-only caveat lives in the exposure tile's tooltip.
    expect(w.find('[data-testid="overview-exposure"]').text()).toContain('Confirmed reach only');
    // Advisory inferred-owner caveat lives in the unowned tile's tooltip (1 covered).
    expect(w.find('[data-testid="overview-unowned"]').text()).toContain('advisory');
    w.unmount();
  });

  it('shows a plain-English error when the overview fails to load (never invents numbers)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })));
    const w = mountView();
    await flushPromises();
    expect(w.find('[role="alert"]').exists()).toBe(true);
    expect(w.find('[data-testid="overview-score"]').exists()).toBe(false);
    w.unmount();
  });
});
