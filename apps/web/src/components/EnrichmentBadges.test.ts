import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import type { WorkflowEnrichment } from '@argus/shared';
import EnrichmentBadges from './EnrichmentBadges.vue';

/** Rule-11 UI-presence: catalog enrichment badges render with honest state. */
function enr(partial: Partial<WorkflowEnrichment>): WorkflowEnrichment {
  return {
    status: 'analyzed', provider: 'openai', model: 'gpt-5-mini', enrichedAt: '2026-07-06T00:00:00.000Z', corrected: false,
    summary: 's', description: 'd', category: 'revenue-ops', criticality: 'high', criticalityReason: 'Revenue impact.',
    riskFlags: [], suggestedOwnerRationale: 'o', businessContext: 'b', ...partial,
  };
}

describe('EnrichmentBadges (rule 11)', () => {
  const tid = (w: ReturnType<typeof mount>, id: string) => w.find(`[data-testid="${id}"]`);

  it('renders criticality (with reason on hover) + category when analyzed', () => {
    const w = mount(EnrichmentBadges, { props: { enrichment: enr({}) } });
    expect(tid(w, 'enrichment-criticality').exists()).toBe(true);
    expect(tid(w, 'enrichment-criticality').text()).toContain('high');
    expect(tid(w, 'enrichment-criticality').attributes('title')).toContain('Revenue impact.');
    expect(tid(w, 'enrichment-category').text()).toContain('Revenue Ops');
  });

  it('renders an honest "couldn\'t analyze" badge for a stub', () => {
    const w = mount(EnrichmentBadges, { props: { enrichment: enr({ status: 'stub', summary: null, category: null, criticality: null, criticalityReason: null }) } });
    expect(tid(w, 'enrichment-stub-badge').exists()).toBe(true);
    expect(tid(w, 'enrichment-criticality').exists()).toBe(false);
  });

  it('flags a stale row', () => {
    const w = mount(EnrichmentBadges, { props: { enrichment: enr({ status: 'stale' }) } });
    expect(tid(w, 'enrichment-stale-badge').exists()).toBe(true);
  });

  it('renders nothing when not enriched', () => {
    const w = mount(EnrichmentBadges, { props: { enrichment: null } });
    expect(tid(w, 'enrichment-badges').exists()).toBe(false);
  });
});
