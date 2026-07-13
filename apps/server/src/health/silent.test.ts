import { describe, it, expect } from 'vitest';
import { extractSwallowedErrors, aggregateSilentFailures, type InspectedRun } from './silent.js';

// Fixtures mirror the REAL un-redacted shapes captured in contracts/n8n-23.
const structuredHttpItem = { json: { error: { message: 'connect ECONNREFUSED 127.0.0.1:1', name: 'Error', stack: 'Error: …/secret/path', code: 'ECONNREFUSED' } }, pairedItem: { item: 0 } };
const stringCodeItem = { json: { error: 'Downstream API rejected the batch' }, pairedItem: { item: 0 } };
const cleanItem = { json: { ok: true }, pairedItem: { item: 0 } };

const resultData = (main: unknown[][], nodeName = 'Swallowing Step', extra: Record<string, unknown> = {}) => ({
  runData: { [nodeName]: [{ executionStatus: 'success', data: { main }, ...extra }] },
});

describe('extractSwallowedErrors — Layer 2 allowlist (coded against contracts/n8n-23)', () => {
  it('detects an HTTP swallow and extracts ONLY name + code — never the message or stack', () => {
    const out = extractSwallowedErrors(resultData([[structuredHttpItem]]));
    expect(out).toEqual([{ node: 'Swallowing Step', errorType: 'Error', errorCode: 'ECONNREFUSED' }]);
    // Hard guarantee: no message/stack leaks into the allowlisted result.
    expect(JSON.stringify(out)).not.toContain('ECONNREFUSED 127.0.0.1');
    expect(JSON.stringify(out)).not.toContain('secret/path');
  });

  it('detects a Code swallow (json.error is a message STRING) as presence-only — type/code null, string NEVER surfaced', () => {
    const out = extractSwallowedErrors(resultData([[stringCodeItem]]));
    expect(out).toEqual([{ node: 'Swallowing Step', errorType: null, errorCode: null }]);
    expect(JSON.stringify(out)).not.toContain('Downstream API rejected');
  });

  it('detects a structured taskData.error (engine-level throw that onError continued)', () => {
    const rd = { runData: { 'Risky Node': [{ executionStatus: 'error', error: { name: 'NodeApiError', httpCode: '503' }, data: { main: [[cleanItem]] } }] } };
    expect(extractSwallowedErrors(rd)).toEqual([{ node: 'Risky Node', errorType: 'NodeApiError', errorCode: '503' }]);
  });

  it('detects an error routed to the error output (main index 1)', () => {
    const out = extractSwallowedErrors(resultData([[], [structuredHttpItem]]));
    expect(out).toEqual([{ node: 'Swallowing Step', errorType: 'Error', errorCode: 'ECONNREFUSED' }]);
  });

  it('returns nothing for a genuinely clean success run', () => {
    expect(extractSwallowedErrors(resultData([[cleanItem]]))).toEqual([]);
  });

  it('is robust to missing/garbage resultData (never throws — rule 5)', () => {
    expect(extractSwallowedErrors(undefined)).toEqual([]);
    expect(extractSwallowedErrors({})).toEqual([]);
    expect(extractSwallowedErrors({ runData: null })).toEqual([]);
  });
});

describe('aggregateSilentFailures — bounded, honest denominator', () => {
  const swallow = { node: 'Push to Warehouse', errorType: 'Error', errorCode: 'ECONNREFUSED' };
  it('counts affected runs and takes last* from the MOST RECENT affected run', () => {
    const inspected: InspectedRun[] = [
      { startedAt: '2026-07-01T00:00:00.000Z', swallowed: [swallow] },
      { startedAt: '2026-07-03T00:00:00.000Z', swallowed: [{ ...swallow, errorCode: 'ETIMEDOUT' }] },
      { startedAt: '2026-07-02T00:00:00.000Z', swallowed: [] },
    ];
    const agg = aggregateSilentFailures(inspected);
    expect(agg.runsAffected).toBe(2);
    expect(agg.runsInspected).toBe(3);
    expect(agg.lastNode).toBe('Push to Warehouse');
    expect(agg.lastErrorCode).toBe('ETIMEDOUT'); // the 07-03 run is most recent
    expect(agg.lastSeenAt).toBe('2026-07-03T00:00:00.000Z');
  });

  it('all-clean inspected runs → runsAffected 0 with an honest denominator (not "verified clean")', () => {
    const agg = aggregateSilentFailures([{ startedAt: '2026-07-01T00:00:00.000Z', swallowed: [] }]);
    expect(agg.runsAffected).toBe(0);
    expect(agg.runsInspected).toBe(1);
    expect(agg.lastNode).toBeNull();
  });
});
