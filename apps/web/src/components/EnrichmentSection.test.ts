import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { WorkflowEnrichment } from '@argus/shared';
import EnrichmentSection from './EnrichmentSection.vue';

/** Rule-11 UI-presence: the drawer's sense-making section, incl. reason-always-shown. */
function enr(partial: Partial<WorkflowEnrichment>): WorkflowEnrichment {
  return {
    status: 'analyzed', provider: 'openai', model: 'gpt-5-mini', enrichedAt: '2026-07-06T00:00:00.000Z', corrected: false,
    summary: 'Recovers failed payments.', description: 'd', category: 'revenue-ops', criticality: 'high',
    criticalityReason: 'Directly tied to revenue.', riskFlags: ['handles-financial-data'],
    suggestedOwnerRationale: 'Billing team.', businessContext: 'Dunning flow.', ...partial,
  };
}
const props = (enrichment: WorkflowEnrichment | null) => ({ enrichment, instanceId: 'a', workflowId: 'w1' });
const tid = (w: ReturnType<typeof mount>, id: string) => w.find(`[data-testid="${id}"]`);

afterEach(() => vi.unstubAllGlobals());

describe('EnrichmentSection (rule 11)', () => {
  it('always shows the criticality reason next to the label (rule 5, spec)', () => {
    const w = mount(EnrichmentSection, { props: props(enr({})) });
    expect(tid(w, 'enrichment-summary').text()).toContain('Recovers failed payments.');
    expect(tid(w, 'enrichment-criticality-label').text()).toContain('high');
    // The reason element is present AND non-empty — never a bare level.
    expect(tid(w, 'enrichment-criticality-reason').exists()).toBe(true);
    expect(tid(w, 'enrichment-criticality-reason').text()).toContain('Directly tied to revenue.');
    expect(tid(w, 'enrichment-risk-flags').exists()).toBe(true);
    expect(tid(w, 'enrichment-correct-button').exists()).toBe(true);
    expect(tid(w, 'enrichment-provenance').text()).toContain('gpt-5-mini');
  });

  it('shows an honest stub, with no correct button', () => {
    const w = mount(EnrichmentSection, { props: props(enr({ status: 'stub', summary: null, category: null, criticality: null, criticalityReason: null })) });
    expect(tid(w, 'enrichment-stub').exists()).toBe(true);
    expect(tid(w, 'enrichment-stub').text().toLowerCase()).toContain("couldn’t analyze".toLowerCase());
    expect(tid(w, 'enrichment-correct-button').exists()).toBe(false);
  });

  it('flags a stale row while still showing last-known analysis', () => {
    const w = mount(EnrichmentSection, { props: props(enr({ status: 'stale' })) });
    expect(tid(w, 'enrichment-stale').exists()).toBe(true);
    expect(tid(w, 'enrichment-summary').text()).toContain('Recovers failed payments.');
  });

  it('PUTs an audited correction and emits the updated detail', async () => {
    const workflow = {
      instanceId: 'a', instanceLabel: 'prod', id: 'w1', name: 'Alpha', active: true, isArchived: false,
      project: 'Revenue Ops', updatedAt: '2026-07-05T00:00:00.000Z', systems: [], triggers: [],
      mcpExposed: false, nodeCount: 3, understood: true, brokenRefCount: 0,
      enrichment: enr({ criticality: 'critical', corrected: true }), health: null,
    };
    const updated = { workflow, facts: null, deepLink: '' };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => updated }));
    vi.stubGlobal('fetch', fetchMock);

    const w = mount(EnrichmentSection, { props: props(enr({})) });
    await tid(w, 'enrichment-correct-button').trigger('click');
    // Dialog open → pick criticality → save.
    await tid(w, 'label-correction-criticality').setValue('critical');
    await tid(w, 'label-correction-save').trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/enrichment/correction');
    expect(init.method).toBe('PUT');
    expect(w.emitted('updated')).toBeTruthy();
  });

  it('renders an honest empty state when not enriched', () => {
    const w = mount(EnrichmentSection, { props: props(null) });
    expect(tid(w, 'enrichment-empty').exists()).toBe(true);
  });
});
