import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import HealthBadge from './HealthBadge.vue';
import type { ConnectionHealth } from '@argus/shared';

const health = (status: ConnectionHealth['status']): ConnectionHealth => ({
  status, lastSyncedAt: null, lastError: null, workflowCount: 0,
});

describe('HealthBadge', () => {
  it.each([
    ['ok', 'Connected', 'badge--ok'],
    ['unauthorized', 'Key rejected', 'badge--danger'],
    ['unreachable', 'Unreachable', 'badge--danger'],
    ['pending', 'Syncing…', 'badge--muted'],
  ] as const)('renders %s as "%s"', (status, label, cls) => {
    const w = mount(HealthBadge, { props: { health: health(status) } });
    expect(w.text()).toBe(label);
    expect(w.find(`.${cls}`).exists()).toBe(true);
  });
});
