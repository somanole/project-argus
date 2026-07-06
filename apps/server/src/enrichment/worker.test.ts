import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { EnrichmentOutput } from '@argus/shared';
import { openDb } from '../db/index.js';
import { createConnection } from '../connections/repo.js';
import { replaceInstanceWorkflows, listWorkflows, type CacheWorkflow } from '../workflows/repo.js';
import { setLlmConfig, setEnrichmentEnabled } from '../settings/repo.js';
import type { LlmClient, LlmClientConfig, StructuredOutputArgs, StructuredResult } from '../llm/index.js';
import type { EnrichmentInput } from './allowlist.js';
import { createEnrichmentWorker } from './worker.js';

const ACTOR = { name: 'Sam', email: 'sam@acme.example' };
const ENC = 'test-key';

const input: EnrichmentInput = {
  name: 'WF', project: null, tags: [], triggerTypes: [], nodes: [], topology: '1 node',
  credentialTypes: [], systems: [], failureStats: null,
  facts: { nodeCount: 1, mcpExposed: false, brokenRefCount: 0, understood: true },
};
const output: EnrichmentOutput = {
  summary: 's', description: 'd', category: 'integration', criticality: 'low',
  criticalityReason: 'r', riskFlags: [], suggestedOwnerRationale: 'o', businessContext: 'b',
};

function wf(id: string): CacheWorkflow {
  return { id, name: `WF-${id}`, active: true, isArchived: false, projectId: null, projectName: null, updatedAt: '2026-07-05T00:00:00.000Z', versionId: 'v1', facts: null, enrichmentInput: input, enrichmentInputHash: `hash-${id}` };
}

/** A fake client counting calls; each call returns a fixed valid output + fixed usage. */
function fakeClient(tokensPerCall = 100): { factory: (c: LlmClientConfig) => LlmClient; calls: () => number } {
  let calls = 0;
  const factory = (c: LlmClientConfig): LlmClient => ({
    provider: c.provider,
    model: c.model,
    async structuredOutput<T>(_args: StructuredOutputArgs<T>): Promise<StructuredResult<T>> {
      calls++;
      return { value: output as unknown as T, usage: { inputTokens: tokensPerCall / 2, outputTokens: tokensPerCall / 2, totalTokens: tokensPerCall } };
    },
    // eslint-disable-next-line require-yield
    async *streamToolLoop() {
      throw new Error('unused');
    },
  });
  return { factory, calls: () => calls };
}

describe('enrichment worker', () => {
  let db: Database.Database;
  let instanceId: string;
  beforeEach(() => {
    db = openDb(':memory:');
    instanceId = createConnection(db, ACTOR, { label: 'prod', baseUrl: 'http://x', apiKey: 'k' }, ENC).id;
    replaceInstanceWorkflows(db, instanceId, [wf('1'), wf('2'), wf('3')], new Date().toISOString());
  });

  it('does nothing when the kill switch is off (0 calls)', async () => {
    const fake = fakeClient();
    setLlmConfig(db, ACTOR, 'openai', 'sk-test', ENC);
    const worker = createEnrichmentWorker({ db, encryptionKey: ENC, envAllowed: false, concurrency: 3, spendCapTokens: 0, clientFactory: fake.factory });
    expect(await worker.runInstance(instanceId)).toMatchObject({ skipped: 'disabled' });
    expect(fake.calls()).toBe(0);
    expect(worker.progress().enabled).toBe(false);
  });

  it('does nothing when the in-app master switch is turned off (even if configured)', async () => {
    const fake = fakeClient();
    setLlmConfig(db, ACTOR, 'openai', 'sk-test', ENC);
    setEnrichmentEnabled(db, ACTOR, false); // owner flipped the master switch off
    const worker = createEnrichmentWorker({ db, encryptionKey: ENC, envAllowed: true, concurrency: 3, spendCapTokens: 0, clientFactory: fake.factory });
    expect(await worker.runInstance(instanceId)).toMatchObject({ skipped: 'disabled' });
    expect(fake.calls()).toBe(0);
    expect(worker.progress().enabled).toBe(false);
  });

  it('does nothing when no provider is configured', async () => {
    const fake = fakeClient();
    const worker = createEnrichmentWorker({ db, encryptionKey: ENC, envAllowed: true, concurrency: 3, spendCapTokens: 0, clientFactory: fake.factory });
    expect(await worker.runInstance(instanceId)).toMatchObject({ skipped: 'unconfigured' });
    expect(fake.calls()).toBe(0);
  });

  it('enriches all misses, then makes 0 calls on a re-run (hash-gated)', async () => {
    const fake = fakeClient();
    setLlmConfig(db, ACTOR, 'openai', 'sk-test', ENC);
    const worker = createEnrichmentWorker({ db, encryptionKey: ENC, envAllowed: true, concurrency: 2, spendCapTokens: 0, clientFactory: fake.factory });

    const first = await worker.runInstance(instanceId);
    expect(first).toMatchObject({ analyzed: 3, stub: 0, pending: 0 });
    expect(fake.calls()).toBe(3);
    expect(listWorkflows(db, { instanceId }).every((w) => w.enrichment?.status === 'analyzed')).toBe(true);

    const second = await worker.runInstance(instanceId);
    expect(second).toMatchObject({ analyzed: 0, stub: 0, pending: 0 });
    expect(fake.calls()).toBe(3); // no new calls
    expect(worker.progress()).toMatchObject({ enabled: true, total: 3, analyzed: 3, pending: 0 });
  });

  it('stops at the spend cap, leaving the rest PENDING (not stub)', async () => {
    const fake = fakeClient(100); // 100 tokens/call
    setLlmConfig(db, ACTOR, 'openai', 'sk-test', ENC);
    // Cap allows ~1 call (>=100 tokens after the first stops the loop before the 2nd).
    const worker = createEnrichmentWorker({ db, encryptionKey: ENC, envAllowed: true, concurrency: 1, spendCapTokens: 100, clientFactory: fake.factory });
    const r = await worker.runInstance(instanceId);
    expect(r.analyzed).toBe(1);
    expect(r.pending).toBe(2);
    expect(fake.calls()).toBe(1);
    // The pending two are still candidates (not stubbed) — a later run will pick them up.
    const remaining = listWorkflows(db, { instanceId }).filter((w) => w.enrichment == null);
    expect(remaining).toHaveLength(2);
  });
});
