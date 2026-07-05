import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StateBadge from './StateBadge.vue';

describe('StateBadge', () => {
  it('shows Active for an active, non-archived workflow', () => {
    const w = mount(StateBadge, { props: { active: true, isArchived: false } });
    expect(w.text()).toBe('Active');
    expect(w.find('.badge--ok').exists()).toBe(true);
  });

  it('shows Inactive for an inactive workflow', () => {
    const w = mount(StateBadge, { props: { active: false, isArchived: false } });
    expect(w.text()).toBe('Inactive');
  });

  it('shows Archived regardless of active flag', () => {
    const w = mount(StateBadge, { props: { active: true, isArchived: true } });
    expect(w.text()).toBe('Archived');
  });
});
