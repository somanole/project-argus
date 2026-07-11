import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { SessionActor, WorkflowFacts } from '@argus/shared';
import { governanceOverviewResponseSchema } from '@argus/shared';
import { migrate } from '../db/migrate.js';
import { replaceInstanceWorkflows, listWorkflows, type CacheWorkflow } from '../workflows/repo.js';
import { assignOwner, governanceGaps } from '../ownership/repo.js';
import { healthEstate } from '../health/repo.js';
import { replaceAllEdges } from '../graph/repo.js';
import type { BuiltEdge } from '../graph/build.js';
import { governanceOverview } from './summary.js';
import { governanceRouter } from '../routes/governance.js';

/**
 * S6's load-bearing guarantee: the dashboard COMPOSES, it never DIVERGES. These
 * tests seed a tiny estate with the planted-problem shapes and prove each figure
 * equals its source read, each count equals its drilled set, and the S5 trust
 * spine (possible edges never count) survives at the dashboard layer.
 */

const ISO = '2026-07-07T00:00:00.000Z';
const ACTOR: SessionActor = { name: 'Ops', email: 'ops@argus.io' };

function facts(over: Partial<WorkflowFacts>): WorkflowFacts {
  return {
    schemaVersion: 2,
    analyzedAt: ISO,
    nodeCount: 1,
    nodeTypes: [],
    triggers: [],
    triggerCountDetected: 0,
    triggerCountReported: null,
    systems: [],
    credentialTypes: [],
    dataTableRefs: [],
    mcpExposed: false,
    directDeps: [],
    webhookEndpoints: [],
    httpCallsites: [],
    credentialRefs: [],
    callerPolicy: { policy: null, callerIds: [] },
    coverage: { understood: true, unknownNodeTypes: [], unresolvedRefs: 0, reasons: [] },
    ...over,
  };
}

function wf(id: string, name: string, f: Partial<WorkflowFacts> | null = null): CacheWorkflow {
  return {
    id, name, active: true, isArchived: false, projectId: null, projectName: null, updatedAt: ISO,
    versionId: 'v', facts: f ? facts(f) : null, enrichmentInput: null, enrichmentInputHash: null,
  };
}

function enrich(db: Database.Database, instanceId: string, workflowId: string, criticality: string): void {
  db.prepare(
    `INSERT INTO workflow_enrichments
       (instance_id, workflow_id, input_hash, provider, model, prompt_version, schema_version, status, enrichment_json, corrected_json, enriched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    instanceId,
    workflowId,
    'h',
    'openai',
    'gpt',
    'p1',
    1,
    'analyzed',
    JSON.stringify({
      summary: 's',
      description: 'd',
      category: 'internal-ops',
      criticality,
      criticalityReason: 'r',
      riskFlags: [],
      suggestedOwnerRationale: null,
      businessContext: null,
    }),
    null,
    ISO,
  );
}

function health(db: Database.Database, instanceId: string, workflowId: string, status: string, failureRate: number | null): void {
  db.prepare(
    `INSERT INTO workflow_health
       (instance_id, workflow_id, status, runs_in_window, failures_in_window, failure_rate, last_run_at, last_status, avg_duration_ms, window_hours, unavailable_reason, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(instanceId, workflowId, status, 10, status === 'failing' ? 9 : 0, failureRate, ISO, null, null, 336, status === 'unknown' ? 'unreadable' : null, ISO);
}

const sys = (name: string) => ({ system: name, via: 'node' as const, credentialType: null, nodeType: `n8n-nodes-base.${name}`, resolved: true, raw: name });
const wfNode = (instanceId: string, id: string) => ({ kind: 'workflow' as const, instanceId, id, label: id });

function seedEstate(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare('INSERT INTO connections (id,label,base_url,api_key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('prod', 'prod', 'http://localhost/prod', 'x', ISO, ISO);

  replaceInstanceWorkflows(
    db,
    'prod',
    [
      wf('cu', 'Critical Unowned'),
      wf('co', 'Critical Owned Failing'),
      wf('ok', 'Healthy Owned'),
      wf('mcp', 'MCP Root', { mcpExposed: true, systems: [sys('slack')] }),
      wf('sens', 'Sensitive Downstream', { systems: [sys('stripe')] }),
    ],
    ISO,
  );

  enrich(db, 'prod', 'cu', 'critical');
  enrich(db, 'prod', 'co', 'critical');
  enrich(db, 'prod', 'ok', 'low');

  // co and mcp are owned; cu is left unowned (the planted gap).
  assignOwner(db, ACTOR, 'prod', 'co', { ownerEmail: 'sam@corp.io', ownerName: 'Sam' });
  assignOwner(db, ACTOR, 'prod', 'mcp', { ownerEmail: 'sam@corp.io', ownerName: 'Sam' });

  health(db, 'prod', 'cu', 'failing', 0.9);
  health(db, 'prod', 'co', 'failing', 0.9);
  health(db, 'prod', 'ok', 'healthy', 0.0);
  health(db, 'prod', 'mcp', 'healthy', 0.0);
  health(db, 'prod', 'sens', 'idle', null);
  return db;
}

function edge(confidence: 'confirmed' | 'possible'): BuiltEdge {
  return { src: wfNode('prod', 'mcp'), dst: wfNode('prod', 'sens'), type: 'call', confidence, crossInstance: false, reason: 'test' };
}

describe('S6 governance overview — composition never diverges', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = seedEstate();
  });

  it('unowned equals governanceGaps().unowned (same source read)', () => {
    const o = governanceOverview(db, ISO);
    const gaps = governanceGaps(db);
    expect(o.unowned.total).toBe(gaps.unowned.length);
    expect(o.unowned.workflows.map((w) => w.workflowId).sort()).toEqual(gaps.unowned.map((w) => w.workflowId).sort());
    // The planted unowned critical is present, split by criticality.
    expect(o.unowned.byCriticality.critical).toBe(1);
    expect(o.unowned.total).toBe(o.unowned.byCriticality.critical + o.unowned.byCriticality.high + o.unowned.byCriticality.medium + o.unowned.byCriticality.low + o.unowned.byCriticality.none);
  });

  it('failing-with-owner equals the OWNED subset of healthEstate failing+degraded', () => {
    const o = governanceOverview(db, ISO);
    const estate = healthEstate(db);
    const ownedFailing = [...estate.failing, ...estate.degraded].filter((w) => w.owner != null && w.owner.status === 'assigned');
    expect(o.failingWithOwner.count).toBe(ownedFailing.length);
    expect(o.failingWithOwner.workflows.map((w) => w.id).sort()).toEqual(ownedFailing.map((w) => w.id).sort());
    // Exactly the owned failing one — the unowned failing critical is excluded here.
    expect(o.failingWithOwner.workflows.map((w) => w.id)).toEqual(['co']);
  });

  it('every figure count equals its drilled workflow-set length (the drill contract)', () => {
    const o = governanceOverview(db, ISO);
    expect(o.failingWithOwner.count).toBe(o.failingWithOwner.workflows.length);
    expect(o.hygiene.brokenRefs.count).toBe(o.hygiene.brokenRefs.workflows.length);
    expect(o.hygiene.staleEnrichment.count).toBe(o.hygiene.staleEnrichment.workflows.length);
    expect(o.hygiene.activeNoExecutions.count).toBe(o.hygiene.activeNoExecutions.workflows.length);
    expect(o.exposure.mcpExposed).toBe(o.exposure.surfaces.length);
    // activeNoExecutions drills to exactly the idle-but-active workflow.
    expect(o.hygiene.activeNoExecutions.workflows.map((w) => w.id)).toEqual(['sens']);
  });

  it('the Overview tiles deep-link to catalog filters that return the SAME exact set', () => {
    const o = governanceOverview(db, ISO);
    // "Idle but active" tile → ?health=idle&active=true — same set the overview counts.
    const idleActive = listWorkflows(db, { health: ['idle'], active: true });
    expect(idleActive.map((w) => w.id).sort()).toEqual(o.hygiene.activeNoExecutions.workflows.map((w) => w.id).sort());
    expect(idleActive.map((w) => w.id)).toEqual(['sens']);
    // "Stale analysis" tile → ?stale=true — the enriched-but-hash-drifted workflows.
    const stale = listWorkflows(db, { stale: true });
    expect(stale.map((w) => w.id).sort()).toEqual(o.hygiene.staleEnrichment.workflows.map((w) => w.id).sort());
    expect(stale.every((w) => w.enrichment?.status === 'stale')).toBe(true);
  });

  it('a POSSIBLE edge to a sensitive system is EXCLUDED from the exposure surface; a CONFIRMED one is counted (S5 trust spine)', () => {
    replaceAllEdges(db, [edge('possible')], ISO);
    const possible = governanceOverview(db, ISO);
    expect(possible.exposure.mcpExposed).toBe(1);
    expect(possible.exposure.reachingSensitive).toBe(0); // possible never counts

    replaceAllEdges(db, [edge('confirmed')], ISO);
    const confirmed = governanceOverview(db, ISO);
    expect(confirmed.exposure.reachingSensitive).toBe(1);
    expect(confirmed.exposure.surfaces.find((s) => s.workflowId === 'mcp')!.sensitiveSystems).toContain('stripe');
  });

  it('the score is present, in range, with all five pillars scored on this estate', () => {
    const o = governanceOverview(db, ISO);
    expect(o.score.score).not.toBeNull();
    expect(o.score.score!).toBeGreaterThanOrEqual(0);
    expect(o.score.score!).toBeLessThanOrEqual(100);
    expect(o.score.pillars).toHaveLength(5);
  });
});

describe('S6 governance overview — routes', () => {
  it('GET /overview returns a schema-valid payload; GET /export returns a markdown report', async () => {
    const db = seedEstate();
    const app = express();
    app.use('/api/governance', governanceRouter(db));

    const overview = await request(app).get('/api/governance/overview');
    expect(overview.status).toBe(200);
    expect(() => governanceOverviewResponseSchema.parse(overview.body)).not.toThrow();

    const report = await request(app).get('/api/governance/export');
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toContain('text/markdown');
    expect(report.text).toContain('# Argus — Governance report');
    expect(report.text).toContain('Governance score');
  });
});
