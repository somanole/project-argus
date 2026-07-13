import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { SessionActor, WorkflowFacts } from '@argus/shared';
import { migrate } from '../db/migrate.js';
import { replaceInstanceWorkflows, type CacheWorkflow } from '../workflows/repo.js';
import { assignOwner } from '../ownership/repo.js';
import { buildChatTools } from './tools.js';
import { ID_KEYS, EMAIL_KEYS, redactToolOutput } from './redact.js';

/**
 * S7 chat EGRESS gate (docs/DATA-FLOW-CHAT.md; security-review Findings 2/3/4/6). Asserts,
 * before any tool result reaches the model:
 *  - the redaction backstop is applied to EVERY registered tool (a future tool that skips
 *    the wrapper, or a raw field slipping through, fails here — rule 11 for egress);
 *  - `get_workflow_detail` sends a SHAPED facts subset — no raw host / webhook paths / URL /
 *    expression strings (`rawValue`) / credential names;
 *  - owner/actor emails do NOT leave by default, but names do; the opt-in re-enables emails;
 *  - identifier fields survive; the key-exemption lists are tight.
 */

const ISO = '2026-07-07T00:00:00.000Z';
const ACTOR: SessionActor = { name: 'Ops', email: 'ops@argus.io' };
const UUID = '9675a3b9-b0eb-45d4-9dea-c83d8f1621e5';
const GH = 'ghp_ABCDEF1234567890ABCDEF1234567890abcd'; // github-token shape
const URL_SECRET = 'https://apiuser:P4ssw0rdLeak@api.vendor.example/v1?api_key=sk-proj-tok9xKq2mVn7Pw4Lr8Ts';

function facts(over: Partial<WorkflowFacts>): WorkflowFacts {
  return {
    schemaVersion: 3, analyzedAt: ISO, nodeCount: 2, nodeTypes: [], triggers: [], triggerCountDetected: 0,
    triggerCountReported: null, systems: [], credentialTypes: [], dataTableRefs: [], mcpExposed: false,
    canMaskFailures: { flagged: false, reasons: [], noErrorWorkflow: true },
    directDeps: [], webhookEndpoints: [], httpCallsites: [], credentialRefs: [],
    callerPolicy: { policy: null, callerIds: [] }, coverage: { understood: true, unknownNodeTypes: [], unresolvedRefs: 0, reasons: [] },
    ...over,
  };
}
function wf(id: string, name: string, f: WorkflowFacts | null = null, mcp = false): CacheWorkflow {
  return { id, name, active: true, isArchived: false, projectId: null, projectName: null, updatedAt: ISO, versionId: 'v', facts: f ? { ...f, mcpExposed: mcp } : f, enrichmentInput: null, enrichmentInputHash: null };
}
const sys = (name: string) => ({ system: name, via: 'node' as const, credentialType: null, nodeType: `n8n-nodes-base.${name}`, resolved: true, raw: name });

// A workflow whose facts pack a secret into EVERY raw free-text field the shaping drops.
const LEAKY_FACTS = facts({
  systems: [sys('Stripe')],
  nodeTypes: [{ type: 'n8n-nodes-base.httpRequest', count: 1, category: 'action', known: true }],
  httpCallsites: [{ nodeName: 'HTTP', rawUrl: URL_SECRET, host: 'db.internal:5432', webhookPath: '/webhook/secret-path', isExpression: false }],
  webhookEndpoints: [{ nodeName: 'Hook', path: `/webhook/${GH}`, isExpression: false }],
  directDeps: [{ kind: 'subWorkflow', nodeId: 'n', nodeName: 'Exec', mode: 'expression', rawValue: `={{ '${GH}' }}`, cachedName: 'Callee', resolution: 'resolved', resolvedId: 'callee', resolvedName: 'Callee' }],
  dataTableRefs: [{ mode: 'expression', rawValue: `token ${GH}`, cachedName: 'Ledger' }],
  credentialRefs: [{ nodeName: 'Cred', credentialType: 'stripeApi', credentialId: 'cid', credentialName: `Prod ${GH}` }],
});

function seed(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare('INSERT INTO connections (id,label,base_url,api_key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(UUID, 'prod', 'http://localhost/prod', 'x', ISO, ISO);
  replaceInstanceWorkflows(db, UUID, [wf('leaky', `Sync ${GH} nightly`, LEAKY_FACTS, true), wf('other', 'Order Intake')], ISO);
  assignOwner(db, ACTOR, UUID, 'leaky', { ownerEmail: 'sam@corp.io', ownerName: 'Sam Rivers', reason: `rotate ${GH}` });
  return db;
}
const tools = (db: Database.Database, egressEmails = false) => buildChatTools(db, () => {}, { egressEmails });
const byName = (db: Database.Database, name: string, egressEmails = false) => tools(db, egressEmails).find((t) => t.name === name)!;

describe('chat egress backstop — coverage across all tools', () => {
  // Representative inputs that surface the leaky workflow (or its audit entry) per tool.
  const INPUTS: Record<string, unknown> = {
    search_catalog: { query: '', systems: [], criticality: [], health: [] },
    get_workflow_detail: { name: '', instanceId: UUID, id: 'leaky' },
    impact_analysis: { name: '', instanceId: UUID, id: 'leaky', mode: 'failure' },
    system_map: { system: 'Stripe', capability: 'any' },
    ownership_query: { person: 'sam@corp.io', scope: 'owned_by' },
    governance_gaps: { kind: 'all' },
    mcp_exposure: { name: '', instanceId: '', id: '' },
    fleet_stats: { section: 'all' },
    audit_log: { entity: '', actor: '', action: 'ownership', limit: 20 },
    changelog: { limit: 20 },
  };

  it('runs EVERY registered tool through the redaction wrapper (no raw secret in any output)', async () => {
    const db = seed();
    const all = tools(db);
    expect(all.length).toBe(10); // a new tool is a conscious addition — and is auto-wrapped by buildChatTools
    for (const t of all) {
      const input = INPUTS[t.name];
      expect(input, `no test input for tool ${t.name}`).toBeDefined();
      const json = JSON.stringify(await t.execute(input, undefined));
      expect(json, `tool ${t.name} leaked a secret`).not.toContain(GH);
      expect(json, `tool ${t.name} leaked a URL secret`).not.toContain('P4ssw0rdLeak');
    }
  });

  it('scrubs a secret in a workflow name but keeps ids intact', async () => {
    const json = JSON.stringify(await byName(seed(), 'search_catalog').execute({ query: '', systems: [], criticality: [], health: [] }));
    expect(json).not.toContain(GH);
    expect(json).toContain('[REDACTED:github-token]');
    expect(json).toContain(UUID); // UUID instanceId survives
    expect(json).toContain('"id":"leaky"');
  });

  it('scrubs a secret in an ownership reason (audit egress)', async () => {
    const json = JSON.stringify(await byName(seed(), 'audit_log').execute({ entity: '', actor: '', action: 'ownership', limit: 20 }));
    expect(json).not.toContain(GH);
    expect(json).toContain('[REDACTED:github-token]');
  });
});

describe('get_workflow_detail — shaped facts allowlist (Findings 2 + 4)', () => {
  it('drops raw host, webhook paths, rawUrl, expression rawValues, and credential names', async () => {
    const out = (await byName(seed(), 'get_workflow_detail').execute({ name: '', instanceId: UUID, id: 'leaky' })) as { facts: Record<string, unknown> };
    const json = JSON.stringify(out.facts);
    // None of the dropped raw fields (or their secrets) leave.
    for (const dropped of ['rawUrl', 'host', 'webhookPath', 'path', 'rawValue', 'credentialName', 'credentialId', 'httpCallsites', 'webhookEndpoints']) {
      expect(json, `facts still contains ${dropped}`).not.toContain(dropped);
    }
    expect(json).not.toContain('db.internal');
    expect(json).not.toContain('secret-path');
    expect(json).not.toContain(GH);
    // The allowlist that DOES leave: systems (identity), dependency resolved names, counts, coverage.
    expect(out.facts.systems).toBeDefined();
    expect(JSON.stringify(out.facts.systems)).toContain('Stripe');
    expect(JSON.stringify(out.facts)).toContain('Callee'); // resolved dependency name
    expect(out.facts.counts).toMatchObject({ webhooks: 1, httpCalls: 1, dataTables: 1, credentials: 1 });
    expect(out.facts.coverage).toBeDefined();
  });
});

describe('names-only email egress by default (Finding 6 / DECISION #29)', () => {
  it('omits owner/actor emails by default, keeps names', async () => {
    const db = seed();
    const cat = JSON.stringify(await byName(db, 'search_catalog').execute({ query: '', systems: [], criticality: [], health: [] }));
    expect(cat).not.toContain('sam@corp.io');
    expect(cat).toContain('Sam Rivers'); // the name still leaves — the feature still works

    const own = JSON.stringify(await byName(db, 'ownership_query').execute({ person: 'sam@corp.io', scope: 'owned_by' }));
    expect(own).not.toContain('sam@corp.io'); // resolution used the email internally; output has none
    expect(own).toContain('Sam Rivers');

    const audit = JSON.stringify(await byName(db, 'audit_log').execute({ entity: '', actor: '', action: 'ownership', limit: 20 }));
    expect(audit).not.toContain('@'); // no actor/owner emails in the timeline
  });

  it('re-enables emails only under the explicit opt-in', async () => {
    const db = seed();
    const own = JSON.stringify(await byName(db, 'ownership_query', true).execute({ person: 'sam@corp.io', scope: 'owned_by' }));
    expect(own).toContain('sam@corp.io');
  });
});

describe('redaction key-exemption lists are tight (Finding 3)', () => {
  it('exempts only identifier keys; a UUID in a non-id field is still redacted', () => {
    expect([...ID_KEYS].sort()).toEqual(['credentialId', 'entityId', 'id', 'instanceId', 'nodeId', 'resolvedId', 'workflowId']);
    expect([...EMAIL_KEYS].sort()).toEqual(['actorEmail', 'backupOwnerEmail', 'email', 'ownerEmail']);
    // id key: passes through. non-id field with a high-entropy blob: redacted.
    const out = redactToolOutput({ id: UUID, note: 'x'.repeat(4) + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v' }, { egressEmails: true });
    expect(out.id).toBe(UUID);
    expect(out.note).toContain('[REDACTED');
  });
});
