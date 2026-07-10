import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { EnrichmentOutput } from '@argus/shared';
import { openDb } from '../db/index.js';
import { createConnection } from '../connections/repo.js';
import { replaceInstanceWorkflows, listWorkflows, type CacheWorkflow } from '../workflows/repo.js';
import type { EnrichmentInput } from './allowlist.js';
import { upsertEnrichment, listEnrichmentCandidates, pruneOrphans, correctLabel, enrichmentCounts, type GatingTuple } from './repo.js';

const ACTOR = { name: 'Sam', email: 'sam@acme.example' };
const ENC = 'test-key';
const TUPLE: GatingTuple = { provider: 'openai', model: 'gpt-5-mini', baseUrl: null, promptVersion: 'v1', schemaVersion: 1 };

const input: EnrichmentInput = {
  name: 'Stripe Dunning', project: 'Revenue Ops', tags: ['billing'], triggerTypes: [],
  nodes: [], topology: '3 nodes', credentialTypes: ['stripeApi'], systems: ['Stripe'],
  failureStats: null, facts: { nodeCount: 3, mcpExposed: false, brokenRefCount: 0, understood: true },
};
const output: EnrichmentOutput = {
  summary: 'Recovers failed payments.', description: 'd', category: 'revenue-ops', criticality: 'high',
  criticalityReason: 'Revenue impact.', riskFlags: ['handles-financial-data'], suggestedOwnerRationale: 'o', businessContext: 'b',
};

function cacheWf(hash: string, id = 'w1'): CacheWorkflow {
  return {
    id, name: 'Stripe Dunning', active: true, isArchived: false, projectId: null, projectName: 'Revenue Ops',
    updatedAt: '2026-07-05T00:00:00.000Z', versionId: 'v1', facts: null, enrichmentInput: input, enrichmentInputHash: hash,
  };
}

describe('workflow_enrichments — durable across the cache rebuild', () => {
  let db: Database.Database;
  let instanceId: string;
  beforeEach(() => {
    db = openDb(':memory:');
    instanceId = createConnection(db, ACTOR, { label: 'prod', baseUrl: 'http://x', apiKey: 'k' }, ENC).id;
    replaceInstanceWorkflows(db, instanceId, [cacheWf('hash-A')], new Date().toISOString());
  });

  it('surfaces an analyzed enrichment on the workflow list', () => {
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    const [wf] = listWorkflows(db, { instanceId });
    expect(wf!.enrichment).toMatchObject({ status: 'analyzed', category: 'revenue-ops', criticality: 'high', criticalityReason: 'Revenue impact.' });
  });

  it('SURVIVES a full cache rebuild (re-sync) and goes stale when the input changes', () => {
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    // A re-sync deletes+reinserts the workflow row with a NEW input hash (e.g. a rename).
    replaceInstanceWorkflows(db, instanceId, [cacheWf('hash-B')], new Date().toISOString());
    const [wf] = listWorkflows(db, { instanceId });
    // Enrichment is still here (not thrown away), but flagged stale (hash changed).
    expect(wf!.enrichment?.status).toBe('stale');
    expect(wf!.enrichment?.summary).toBe('Recovers failed payments.'); // last-known shown
  });

  it('re-run makes 0 candidates when fresh; a rename makes it a candidate again', () => {
    expect(listEnrichmentCandidates(db, instanceId, TUPLE)).toHaveLength(1); // never enriched yet
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    expect(listEnrichmentCandidates(db, instanceId, TUPLE)).toHaveLength(0); // fresh → 0 API calls
    replaceInstanceWorkflows(db, instanceId, [cacheWf('hash-B')], new Date().toISOString());
    expect(listEnrichmentCandidates(db, instanceId, TUPLE)).toHaveLength(1); // rename → re-enrich
  });

  it('a provider switch invalidates freshness (candidate again)', () => {
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    const switched: GatingTuple = { ...TUPLE, provider: 'anthropic', model: 'claude-haiku-4-5' };
    expect(listEnrichmentCandidates(db, instanceId, switched)).toHaveLength(1);
  });

  /**
   * DECISION #30: two endpoints can serve the same model id, so the base URL is part of
   * the gating tuple. Repointing must re-enrich rather than silently keep summaries a
   * different model wrote. (`base_url` is NULL for hosted providers, so this also guards
   * the NULL-safe comparison — a bare `<>` would never fire.)
   */
  it('repointing a custom endpoint invalidates freshness, even with the same model id', () => {
    const local: GatingTuple = { ...TUPLE, provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434/v1' };
    upsertEnrichment(db, { ...local, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    expect(listEnrichmentCandidates(db, instanceId, local)).toHaveLength(0); // fresh on the same endpoint

    const repointed: GatingTuple = { ...local, baseUrl: 'http://10.0.0.7:8000/v1' };
    expect(listEnrichmentCandidates(db, instanceId, repointed)).toHaveLength(1);
  });

  /**
   * The NULL path, isolated. A hosted provider stores base_url = NULL and gates with
   * baseUrl = null, and in SQL `NULL = NULL` is NULL — not true. Without the IFNULL guard
   * the freshness predicate goes NULL for every hosted row, so progress reports 0
   * analyzed forever while the catalog visibly shows summaries. Holding provider+model
   * constant is what makes this test see the bug.
   */
  it('a hosted provider (base_url NULL on both sides) counts as ANALYZED, not invisible', () => {
    expect(TUPLE.baseUrl).toBeNull();
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    expect(enrichmentCounts(db, TUPLE)).toMatchObject({ analyzed: 1, stale: 0, pending: 0 });
  });

  it('switching from a hosted provider to a custom endpoint invalidates freshness', () => {
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    const custom: GatingTuple = { ...TUPLE, provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1' };
    expect(listEnrichmentCandidates(db, instanceId, custom)).toHaveLength(1);
  });

  it('a stub is honest: no fabricated category, and it is not a candidate while fresh', () => {
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'stub', enrichmentJson: '{}' });
    const [wf] = listWorkflows(db, { instanceId });
    expect(wf!.enrichment).toMatchObject({ status: 'stub', category: null, criticality: null, summary: null });
    expect(listEnrichmentCandidates(db, instanceId, TUPLE)).toHaveLength(0);
  });

  it('one-click correction overlays the label and writes an audit entry', () => {
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    expect(correctLabel(db, ACTOR, instanceId, 'w1', { criticality: 'critical', note: 'tier-0' })).toBe(true);
    const [wf] = listWorkflows(db, { instanceId });
    expect(wf!.enrichment).toMatchObject({ criticality: 'critical', category: 'revenue-ops', corrected: true });
    const audit = db.prepare("SELECT * FROM audit_log WHERE action='enrichment.correct'").all() as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).toContain('tier-0');
  });

  it('a correction survives an automatic re-enrichment', () => {
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    correctLabel(db, ACTOR, instanceId, 'w1', { criticality: 'critical' });
    // Re-enrich (same tuple, same hash) — corrected_json must be preserved.
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    const [wf] = listWorkflows(db, { instanceId });
    expect(wf!.enrichment).toMatchObject({ criticality: 'critical', corrected: true });
  });

  it('prunes enrichment for a workflow deleted in n8n', () => {
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    replaceInstanceWorkflows(db, instanceId, [], new Date().toISOString()); // workflow gone from n8n
    expect(pruneOrphans(db, instanceId)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM workflow_enrichments').get()).toEqual({ n: 0 });
  });

  it('filters the catalog by effective criticality and by broken refs', () => {
    // w1 = high criticality, no broken refs (from the beforeEach fixture).
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    // w2 = low criticality + a broken ref.
    const brokenFacts = {
      schemaVersion: 1 as const, analyzedAt: '', nodeCount: 1, nodeTypes: [], triggers: [], triggerCountDetected: 0, triggerCountReported: 0,
      systems: [], credentialTypes: [], dataTableRefs: [], mcpExposed: false,
      directDeps: [{ kind: 'subWorkflow' as const, nodeId: 'n', nodeName: 'x', mode: 'id' as const, rawValue: 'gone', cachedName: null, resolution: 'broken' as const, resolvedId: null, resolvedName: null }],
      callerPolicy: { policy: null, callerIds: [] }, coverage: { understood: true, unknownNodeTypes: [], unresolvedRefs: 0, reasons: [] },
    };
    replaceInstanceWorkflows(db, instanceId, [
      cacheWf('hash-A', 'w1'),
      { id: 'w2', name: 'Broken One', active: true, isArchived: false, projectId: null, projectName: null, updatedAt: '2026-07-05T00:00:00.000Z', versionId: 'v', facts: brokenFacts, enrichmentInput: input, enrichmentInputHash: 'hash-w2' },
    ], new Date().toISOString());
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w2', inputHash: 'hash-w2', status: 'analyzed', enrichmentJson: JSON.stringify({ ...output, criticality: 'low' }) });

    expect(listWorkflows(db, { instanceId, criticality: ['high'] }).map((w) => w.id)).toEqual(['w1']);
    expect(listWorkflows(db, { instanceId, criticality: ['low'] }).map((w) => w.id)).toEqual(['w2']);
    expect(listWorkflows(db, { instanceId, criticality: ['high', 'low'] }).map((w) => w.id).sort()).toEqual(['w1', 'w2']);
    expect(listWorkflows(db, { instanceId, broken: true }).map((w) => w.id)).toEqual(['w2']);
  });

  it('a correction changes which criticality filter a workflow matches', () => {
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    expect(listWorkflows(db, { instanceId, criticality: ['high'] }).map((w) => w.id)).toEqual(['w1']);
    correctLabel(db, ACTOR, instanceId, 'w1', { criticality: 'low' });
    // Now it matches 'low', not 'high' (the effective label drives the filter).
    expect(listWorkflows(db, { instanceId, criticality: ['high'] })).toHaveLength(0);
    expect(listWorkflows(db, { instanceId, criticality: ['low'] }).map((w) => w.id)).toEqual(['w1']);
  });

  it('counts progress honestly', () => {
    upsertEnrichment(db, { ...TUPLE, instanceId, workflowId: 'w1', inputHash: 'hash-A', status: 'analyzed', enrichmentJson: JSON.stringify(output) });
    expect(enrichmentCounts(db, TUPLE)).toEqual({ total: 1, analyzed: 1, stub: 0, stale: 0, pending: 0 });
  });
});
