import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import type { WorkflowHealth, WorkflowHealthStatus } from '@argus/shared';
import WorkflowHealthBadge from './WorkflowHealthBadge.vue';

function health(over: Partial<WorkflowHealth> & { status: WorkflowHealthStatus }): WorkflowHealth {
  return {
    failureRate: null, runsInWindow: 0, failuresInWindow: 0, lastRunAt: null, lastStatus: null,
    avgDurationMs: null, windowHours: 336, computedAt: '2026-07-06T00:00:00.000Z', unavailableReason: null, silentFailures: null,
    ...over,
  };
}
const badge = (h: WorkflowHealth | null) => mount(WorkflowHealthBadge, { props: { health: h } }).find('[data-testid="health-badge"]');
const mountBadge = (h: WorkflowHealth | null) => mount(WorkflowHealthBadge, { props: { health: h } });

describe('WorkflowHealthBadge (rule 11 — every state renders honestly)', () => {
  it('failing → danger tone + failing label', () => {
    const b = badge(health({ status: 'failing', failureRate: 1, runsInWindow: 4, failuresInWindow: 4 }));
    expect(b.text()).toContain('failing');
    expect(b.classes()).toContain('badge--danger');
    expect(b.attributes('data-status')).toBe('failing');
  });

  it('degraded → warn tone', () => {
    const b = badge(health({ status: 'degraded', failureRate: 0.5, runsInWindow: 6, failuresInWindow: 3 }));
    expect(b.text()).toContain('degraded');
    expect(b.classes()).toContain('badge--warn');
  });

  it('healthy → ok tone', () => {
    const b = badge(health({ status: 'healthy', failureRate: 0, runsInWindow: 5, failuresInWindow: 0 }));
    expect(b.text()).toContain('healthy');
    expect(b.classes()).toContain('badge--ok');
  });

  it('idle → muted + phrased against the retention window (never "never runs")', () => {
    const b = badge(health({ status: 'idle' }));
    expect(b.text()).toContain('idle');
    expect(b.classes()).toContain('badge--muted');
    expect(b.attributes('title')).toContain('no runs in the last ~14 days');
  });

  it('unknown → "health unavailable" with the reason (never green, rule 5)', () => {
    const b = badge(health({ status: 'unknown', unavailableReason: 'missing execution:list' }));
    expect(b.text()).toContain('unavailable');
    expect(b.classes()).not.toContain('badge--ok');
    expect(b.attributes('title')).toContain('execution:list');
  });

  it('null (not yet computed) → a neutral "checking…", not a fabricated status', () => {
    const b = badge(null);
    expect(b.text()).toContain('checking');
    expect(b.attributes('data-status')).toBe('pending');
  });

  it('S6.3 — an ADDITIVE silent-failure overlay when a green run swallowed a node error', () => {
    const w = mountBadge(health({
      status: 'healthy', failureRate: 0, runsInWindow: 4, failuresInWindow: 0,
      silentFailures: { runsAffected: 4, runsInspected: 4, lastNode: 'Push to Warehouse', lastErrorType: 'Error', lastErrorCode: 'ECONNREFUSED', lastSeenAt: '2026-07-06T00:00:00.000Z' },
    }));
    // The status pill is unchanged (still healthy) AND the overlay is present (additive).
    expect(w.find('[data-testid="health-badge"]').text()).toContain('healthy');
    const overlay = w.find('[data-testid="health-silent-badge"]');
    expect(overlay.exists()).toBe(true);
    expect(overlay.text()).toContain('silently failing');
    expect(overlay.attributes('title')).toContain('Push to Warehouse');
    expect(overlay.attributes('title')).toContain('4 of 4');
  });

  it('S6.3 — no overlay when there is no observed silent failure (absence ≠ "clean")', () => {
    const w = mountBadge(health({ status: 'healthy', silentFailures: { runsAffected: 0, runsInspected: 6, lastNode: null, lastErrorType: null, lastErrorCode: null, lastSeenAt: null } }));
    expect(w.find('[data-testid="health-silent-badge"]').exists()).toBe(false);
  });
});
