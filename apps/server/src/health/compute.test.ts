import { describe, it, expect } from 'vitest';
import type { N8nExecution } from '@argus/shared';
import { computeHealth, emptyAggregate } from './compute.js';
import { aggregateExecutions } from './fetch.js';

const W = { windowHours: 336 };

describe('computeHealth — owned thresholds (rule: owned + unit-tested)', () => {
  it('all failures → failing (the seeded always-failing critical: 4 error / 0 success)', () => {
    const h = computeHealth({ runs: 4, failures: 4, lastRunAt: null, lastStatus: 'error', avgDurationMs: 5 }, W);
    expect(h.status).toBe('failing');
    expect(h.failureRate).toBe(1);
  });

  it('50% failures → degraded (the seeded flaky/alternating: 3✓/3✘)', () => {
    const h = computeHealth({ runs: 6, failures: 3, lastRunAt: null, lastStatus: 'success', avgDurationMs: 5 }, W);
    expect(h.status).toBe('degraded');
    expect(h.failureRate).toBe(0.5);
  });

  it('all success → healthy', () => {
    const h = computeHealth({ runs: 5, failures: 0, lastRunAt: null, lastStatus: 'success', avgDurationMs: 5 }, W);
    expect(h.status).toBe('healthy');
    expect(h.failureRate).toBe(0);
  });

  it('no runs → idle with a null failure rate (never "never runs")', () => {
    const h = computeHealth(emptyAggregate(), W);
    expect(h.status).toBe('idle');
    expect(h.failureRate).toBeNull();
    expect(h.runsInWindow).toBe(0);
  });

  it('boundaries: >50% failing, exactly 50% degraded, exactly 10% degraded, <10% healthy', () => {
    // 3/5 = 60% → failing
    expect(computeHealth({ runs: 5, failures: 3, lastRunAt: null, lastStatus: null, avgDurationMs: null }, W).status).toBe('failing');
    // 5/10 = 50% → degraded (not failing: strictly > 0.5)
    expect(computeHealth({ runs: 10, failures: 5, lastRunAt: null, lastStatus: null, avgDurationMs: null }, W).status).toBe('degraded');
    // 1/10 = 10% → degraded (inclusive lower bound)
    expect(computeHealth({ runs: 10, failures: 1, lastRunAt: null, lastStatus: null, avgDurationMs: null }, W).status).toBe('degraded');
    // 1/20 = 5% → healthy
    expect(computeHealth({ runs: 20, failures: 1, lastRunAt: null, lastStatus: null, avgDurationMs: null }, W).status).toBe('healthy');
  });

  it('carries the window through so recency can be phrased against it', () => {
    expect(computeHealth(emptyAggregate(), { windowHours: 336 }).windowHours).toBe(336);
  });
});

describe('aggregateExecutions', () => {
  const ex = (o: Partial<N8nExecution> & { workflowId: string; status: string }): N8nExecution => ({ id: 'x', ...o });

  it('counts terminal runs + failures, excludes in-flight (waiting is not a failure)', () => {
    const aggs = aggregateExecutions([
      ex({ workflowId: 'a', status: 'success', startedAt: '2026-07-01T00:00:00.000Z', stoppedAt: '2026-07-01T00:00:02.000Z' }),
      ex({ workflowId: 'a', status: 'error', startedAt: '2026-07-02T00:00:00.000Z', stoppedAt: '2026-07-02T00:00:04.000Z' }),
      ex({ workflowId: 'a', status: 'waiting', startedAt: '2026-07-03T00:00:00.000Z' }),
      ex({ workflowId: 'a', status: 'running' }),
    ]);
    const a = aggs.get('a')!;
    expect(a.runs).toBe(2); // waiting + running excluded
    expect(a.failures).toBe(1);
    // avg of 2000ms and 4000ms = 3000ms
    expect(a.avgDurationMs).toBe(3000);
  });

  it('missing timestamps → avgDurationMs null (never fabricated), status still computable', () => {
    const aggs = aggregateExecutions([
      ex({ workflowId: 'b', status: 'success' }),
      ex({ workflowId: 'b', status: 'error' }),
    ]);
    const b = aggs.get('b')!;
    expect(b.avgDurationMs).toBeNull();
    expect(computeHealth(b, W).status).toBe('degraded');
  });

  it('tracks the most-recent run for recency (lastRunAt / lastStatus)', () => {
    const aggs = aggregateExecutions([
      ex({ workflowId: 'c', status: 'success', startedAt: '2026-07-01T00:00:00.000Z', stoppedAt: '2026-07-01T00:00:01.000Z' }),
      ex({ workflowId: 'c', status: 'error', startedAt: '2026-07-05T00:00:00.000Z', stoppedAt: '2026-07-05T00:00:01.000Z' }),
    ]);
    const c = aggs.get('c')!;
    expect(c.lastRunAt).toBe('2026-07-05T00:00:00.000Z');
    expect(c.lastStatus).toBe('error');
  });

  it('canceled counts as a completed run but not a failure', () => {
    const aggs = aggregateExecutions([ex({ workflowId: 'd', status: 'canceled' })]);
    const d = aggs.get('d')!;
    expect(d.runs).toBe(1);
    expect(d.failures).toBe(0);
    expect(computeHealth(d, W).status).toBe('healthy'); // 0% failure
  });
});
