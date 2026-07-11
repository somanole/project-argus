import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import type { WorkflowOwner } from '@argus/shared';
import OwnershipSection from './OwnershipSection.vue';

/**
 * Rule-11 UI-presence: the drawer's ownership section, including the advisory
 * suggested-owner hint that now lives here (moved from sense-making) so it sits
 * next to the assign controls. Advisory only — never counted as ownership (rule 12).
 */
const assigned: WorkflowOwner = {
  status: 'assigned',
  owner: { email: 'nathan@acme.com', name: 'Nathan Owner' },
  backupOwner: null, reason: null, source: 'assigned', memberRole: null,
  assignedBy: { email: 'sorin@acme.com', name: 'sorin' }, assignedAt: '2026-07-08T00:00:00.000Z',
};
const props = (owner: WorkflowOwner | null, suggestedOwnerRationale?: string | null) => ({
  instanceId: 'a', workflowId: 'w1', owner,
  ...(suggestedOwnerRationale !== undefined ? { suggestedOwnerRationale } : {}),
});
const tid = (w: ReturnType<typeof mount>, id: string) => w.find(`[data-testid="${id}"]`);

describe('OwnershipSection (rule 11)', () => {
  it('renders the section, owner badge, and assign/reassign control', () => {
    const w = mount(OwnershipSection, { props: props(assigned) });
    expect(tid(w, 'ownership-section').exists()).toBe(true);
    expect(tid(w, 'owner-badge').exists()).toBe(true);
    expect(tid(w, 'ownership-assign-button').text()).toContain('Reassign');
  });

  it('shows the advisory suggested-owner hint when a rationale is provided', () => {
    const w = mount(OwnershipSection, { props: props(null, 'Assign to Customer Support owners.') });
    const hint = tid(w, 'ownership-suggested-owner');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain('Assign to Customer Support owners.');
  });

  it('omits the suggested-owner hint when there is no rationale', () => {
    const w = mount(OwnershipSection, { props: props(assigned, null) });
    expect(tid(w, 'ownership-suggested-owner').exists()).toBe(false);
  });
});
