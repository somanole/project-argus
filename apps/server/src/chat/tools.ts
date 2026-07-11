import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { ChatWorkflowRef, WorkflowListItem, WorkflowFacts } from '@argus/shared';
import type { LlmTool } from '../llm/index.js';
import { listWorkflows, getWorkflowDetail } from '../workflows/repo.js';
import { governanceGaps, workflowsOwnedBy, listAssignedOwners } from '../ownership/repo.js';
import { readAllEdges, readGraphWorkflows } from '../graph/repo.js';
import { computeImpact } from '../graph/impact.js';
import { computeMcpReach } from '../graph/mcp.js';
import { governanceOverview } from '../governance/summary.js';
import { listAudit } from '../audit/read.js';
import { redactToolOutput } from './redact.js';

/**
 * The S7 chat tools — a THIN wrapper over the deterministic S1b–S6 reads (spec
 * .agents/specs/chat.md). Each tool calls the SAME repo/service function a dashboard
 * calls and re-shapes the result into compact JSON for the model; it computes nothing.
 * The model only ever sees tool output, so every name/number it can cite came from here.
 *
 * Input schemas are flat and all-required (the strict-JSON-schema converter both
 * providers use rejects optional/nullable) — "no filter" is expressed with an empty
 * string / empty array / an `any` enum, documented in each tool's description.
 *
 * `recordRefs` collects every workflow a tool SURFACES; the service streams those to the
 * UI as the only things it linkifies (a fabricated workflow has no ref — faithfulness by
 * construction).
 */
export type RecordRefs = (refs: ChatWorkflowRef[]) => void;

const EMAIL_SYSTEM_RE = /mail|smtp|sendgrid|mailgun|postmark|gmail|outlook|\bses\b|sendinblue|mandrill/i;

const refOf = (w: { instanceId: string; id: string; name: string; instanceLabel?: string }): ChatWorkflowRef => ({
  instanceId: w.instanceId,
  id: w.id,
  name: w.name,
  ...(w.instanceLabel ? { instance: w.instanceLabel } : {}),
});

/** Factual ownership = an ASSIGNED owner (rule 12). Inferred is labelled advisory. */
function ownerCompact(w: WorkflowListItem): unknown {
  const o = w.owner;
  if (!o || o.status === 'unowned') return { status: 'unowned' };
  if (o.status === 'assigned') {
    return {
      status: 'assigned',
      name: o.owner?.name ?? null,
      email: o.owner?.email ?? null,
      backup: o.backupOwner ? { name: o.backupOwner.name ?? null, email: o.backupOwner.email ?? null } : null,
    };
  }
  // inferred — advisory only, never a confirmed owner.
  return {
    status: 'inferred_advisory',
    name: o.owner?.name ?? null,
    email: o.owner?.email ?? null,
    note: 'inferred from n8n project membership — a lead to confirm, NOT a confirmed owner (does not count as owned)',
  };
}

function compactWorkflow(w: WorkflowListItem): Record<string, unknown> {
  const e = w.enrichment;
  return {
    instanceId: w.instanceId,
    id: w.id,
    name: w.name,
    instance: w.instanceLabel,
    active: w.active,
    archived: w.isArchived,
    systems: w.systems,
    mcpExposed: w.mcpExposed,
    brokenRefs: w.brokenRefCount,
    category: e?.category ?? null,
    criticality: e?.criticality ?? null,
    summary: e?.summary ?? null,
    riskFlags: e?.riskFlags ?? [],
    health: w.health?.status ?? null,
    failureRate: w.health?.failureRate ?? null,
    owner: ownerCompact(w),
  };
}

/**
 * Shape a workflow's facts to an explicit EGRESS ALLOWLIST before it reaches the model
 * (S7 security review, Findings 2 + 4; DECISIONS #26 + #28). Like every other chat tool,
 * `get_workflow_detail` sends only hand-picked fields — never the raw analyzer object.
 * Dropped entirely: raw request URLs, internal **hostnames**, **webhook paths**, and raw
 * n8n **expression strings** (`directDeps/dataTableRefs.rawValue`) and credential
 * names/ids. External-system identity still comes from the safe `systems` field; shape
 * comes from counts. Everything that does leave still passes the redaction backstop.
 */
function shapeFacts(facts: WorkflowFacts | null): unknown {
  if (!facts) return null;
  return {
    nodeCount: facts.nodeCount,
    mcpExposed: facts.mcpExposed,
    nodeTypes: facts.nodeTypes.map((n) => n.type), // n8n type identifiers (public)
    triggers: facts.triggers.map((t) => ({ type: t.type, display: t.display })),
    systems: facts.systems.map((s) => ({ system: s.system, via: s.via, resolved: s.resolved })),
    credentialTypes: facts.credentialTypes, // types only — never names, ids, or values
    dependencies: facts.directDeps.map((d) => ({ kind: d.kind, resolution: d.resolution, resolvedName: d.resolvedName, cachedName: d.cachedName })),
    counts: {
      webhooks: facts.webhookEndpoints.length,
      httpCalls: facts.httpCallsites.length,
      dataTables: facts.dataTableRefs.length,
      credentials: facts.credentialRefs.length,
    },
    coverage: facts.coverage,
  };
}

type Resolution =
  | { kind: 'one'; workflow: WorkflowListItem }
  | { kind: 'many'; candidates: WorkflowListItem[] }
  | { kind: 'none' };

/**
 * Does this workflow belong to the instance the user/model named? Accepts the instance's
 * real id (a UUID) OR its human label ("prod", "staging", "Production") — the model
 * naturally passes the label it saw, not the UUID.
 */
function matchesInstance(w: WorkflowListItem, instance: string): boolean {
  const q = instance.trim().toLowerCase();
  if (!q) return true;
  const label = w.instanceLabel.toLowerCase();
  return w.instanceId.toLowerCase() === q || label === q || label.includes(q) || q.includes(label);
}

/** Strip a trailing "(prod)" / "(staging)"-style instance suffix the model may append to a name. */
function baseName(name: string): { name: string; suffixInstance: string | null } {
  const m = name.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m ? { name: m[1]!.trim(), suffixInstance: m[2]!.trim() } : { name: name.trim(), suffixInstance: null };
}

/**
 * Resolve a workflow to exactly one, disambiguating across instances. Order:
 *   1. explicit instanceId (UUID) + id — the precise handle;
 *   2. by name, NARROWED to the given instance (UUID or label) when one is supplied —
 *      this is what makes "Route Asset #32 in prod" resolve instead of looping;
 *   3. a trailing "(prod)" suffix on the name is treated as an instance hint too.
 */
function resolveWorkflow(db: Database.Database, arg: { instanceId: string; id: string; name: string }): Resolution {
  const id = arg.id.trim();
  // The model may pass the instance as the id field, the instanceId field, or a name suffix.
  const parsed = baseName(arg.name.trim());
  const name = parsed.name;
  const instance = (arg.instanceId.trim() || parsed.suffixInstance || '').trim();

  // 1. Precise handle: real instance id (UUID) + workflow id.
  if (arg.instanceId.trim() && id) {
    const detail = getWorkflowDetail(db, arg.instanceId.trim(), id);
    if (detail) return { kind: 'one', workflow: detail.item };
    // else fall through — the instance may have been a label, or the id stale.
  }

  if (!name) return { kind: 'none' };
  let items = listWorkflows(db, { q: name });

  // 2. Narrow to the named instance when one was given AND it matches a candidate. (If it
  //    matches none, keep all and let the ambiguity surface rather than wrongly return none.)
  if (instance) {
    const narrowed = items.filter((w) => matchesInstance(w, instance));
    if (narrowed.length) items = narrowed;
  }

  const exact = items.filter((w) => w.name.toLowerCase() === name.toLowerCase());
  if (exact.length === 1) return { kind: 'one', workflow: exact[0]! };
  if (exact.length > 1) return { kind: 'many', candidates: exact };
  if (items.length === 1) return { kind: 'one', workflow: items[0]! };
  if (items.length > 1) return { kind: 'many', candidates: items.slice(0, 10) };
  return { kind: 'none' };
}

const critEnum = z.enum(['critical', 'high', 'medium', 'low']);
const healthEnum = z.enum(['failing', 'degraded', 'healthy', 'idle', 'unknown']);

export interface ChatToolOpts {
  /** Opt-in (default off): egress owner/actor emails in tool results (DECISION #29). */
  egressEmails: boolean;
}

export function buildChatTools(db: Database.Database, recordRefs: RecordRefs, opts: ChatToolOpts = { egressEmails: false }): LlmTool[] {
  const surface = (ws: Array<{ instanceId: string; id: string; name: string; instanceLabel?: string }>): void =>
    recordRefs(ws.map(refOf));

  const tools: LlmTool[] = [
    {
      name: 'search_catalog',
      description:
        'Search the estate-wide workflow catalog. Filter by name substring (query), external systems, criticality, and/or health. Leave query "" and arrays [] to not filter on that dimension. Returns workflows with their category, criticality, health, owner, and systems.',
      schema: z.object({
        query: z.string(),
        systems: z.array(z.string()),
        criticality: z.array(critEnum),
        health: z.array(healthEnum),
      }),
      summarize: (r) => `${(r as { total: number }).total} workflow(s)`,
      execute: async (raw) => {
        const a = raw as { query: string; systems: string[]; criticality: string[]; health: string[] };
        const items = listWorkflows(db, {
          q: a.query || undefined,
          systems: a.systems.length ? a.systems : undefined,
          criticality: a.criticality.length ? a.criticality : undefined,
          health: a.health.length ? a.health : undefined,
        });
        const capped = items.slice(0, 40);
        surface(capped);
        return { total: items.length, truncated: items.length > capped.length, workflows: capped.map(compactWorkflow) };
      },
    },

    {
      name: 'get_workflow_detail',
      description:
        'Get one workflow in full (facts, enrichment, health, owner). Provide its exact name. If the name is unknown or matches several, this returns found:false / candidates — never a guess. To pick among candidates (the SAME name on different instances), call again with the same name PLUS instanceId — which may be the instance id from a candidate OR just its instance name (e.g. "prod" / "staging"). Do NOT append the instance to the name.',
      schema: z.object({ name: z.string(), instanceId: z.string(), id: z.string() }),
      summarize: (r) => {
        const x = r as { found?: boolean; workflow?: { name: string } };
        return x.found && x.workflow ? x.workflow.name : 'not found';
      },
      execute: async (raw) => {
        const a = raw as { name: string; instanceId: string; id: string };
        const res = resolveWorkflow(db, a);
        if (res.kind === 'none') return { found: false, reason: `no workflow matches "${a.name || a.id}"` };
        if (res.kind === 'many') {
          surface(res.candidates);
          return { found: false, ambiguous: true, candidates: res.candidates.map((w) => ({ name: w.name, instance: w.instanceLabel })) };
        }
        const w = res.workflow;
        surface([w]);
        const detail = getWorkflowDetail(db, w.instanceId, w.id);
        return { found: true, workflow: compactWorkflow(w), facts: shapeFacts(detail?.facts ?? null) };
      },
    },

    {
      name: 'impact_analysis',
      description:
        'Blast radius: what breaks if a workflow fails (mode "failure") or is deprecated (mode "deprecate"). Provide the workflow name; if it matches several, add instanceId (an instance id OR a name like "prod"/"staging") to disambiguate. Traverses CONFIRMED dependency edges only and returns an explicit total plus every affected workflow; possibleExcluded counts uncertain edges left out.',
      schema: z.object({ name: z.string(), instanceId: z.string(), id: z.string(), mode: z.enum(['failure', 'deprecate']) }),
      summarize: (r) => {
        const x = r as { found?: boolean; affectedTotal?: number };
        return x.found ? `${x.affectedTotal} affected` : 'not found';
      },
      execute: async (raw) => {
        const a = raw as { name: string; instanceId: string; id: string; mode: 'failure' | 'deprecate' };
        const res = resolveWorkflow(db, a);
        if (res.kind === 'none') return { found: false, reason: `no workflow matches "${a.name || a.id}"` };
        if (res.kind === 'many') {
          surface(res.candidates);
          return { found: false, ambiguous: true, candidates: res.candidates.map((w) => ({ name: w.name, instance: w.instanceLabel })) };
        }
        const w = res.workflow;
        const edges = readAllEdges(db);
        const workflows = readGraphWorkflows(db);
        const result = computeImpact(edges, workflows, { mode: a.mode, kind: 'workflow', instanceId: w.instanceId, id: w.id }, new Date().toISOString());
        const affected = result.affected.map((x) => ({ instanceId: x.instanceId, id: x.workflowId, name: x.name, hops: x.hops, instanceLabel: x.instanceLabel }));
        surface([w, ...affected]);
        const instances = new Set(affected.map((x) => x.instanceId));
        return {
          found: true,
          focus: result.focusLabel,
          mode: a.mode,
          affectedTotal: affected.length,
          instancesSpanned: instances.size,
          possibleExcluded: result.possibleExcluded,
          affected,
        };
      },
    },

    {
      name: 'system_map',
      description:
        'Workflows that touch a given external system (e.g. "Salesforce"), across instances. Set capability to "email_external" to also flag/keep only those that can send external email; "any" keeps all. Grounded in analyzed facts.',
      schema: z.object({ system: z.string(), capability: z.enum(['any', 'email_external']) }),
      summarize: (r) => `${(r as { total: number }).total} workflow(s)`,
      execute: async (raw) => {
        const a = raw as { system: string; capability: 'any' | 'email_external' };
        const items = a.system.trim() ? listWorkflows(db, { systems: [a.system.trim()] }) : [];
        const withCap = items.map((w) => ({ ...compactWorkflow(w), emailCapable: w.systems.some((s) => EMAIL_SYSTEM_RE.test(s)) }));
        const selected = a.capability === 'email_external' ? withCap.filter((w) => w.emailCapable) : withCap;
        surface(items.filter((w) => (a.capability === 'email_external' ? w.systems.some((s) => EMAIL_SYSTEM_RE.test(s)) : true)));
        return { system: a.system, capability: a.capability, total: selected.length, touchingSystem: items.length, workflows: selected };
      },
    },

    {
      name: 'ownership_query',
      description:
        'Answer ownership questions. scope "owned_by": what an ASSIGNED owner owns across instances (give person as their name or email) — used for "what happens if X leaves" (flags single points of failure). scope "unowned": workflows with no assigned owner. Inferred owners never count as owned.',
      schema: z.object({ person: z.string(), scope: z.enum(['owned_by', 'unowned']) }),
      summarize: (r) => {
        const x = r as { scope?: string; ownedTotal?: number; unownedTotal?: number };
        return x.scope === 'unowned' ? `${x.unownedTotal ?? 0} unowned` : `${x.ownedTotal ?? 0} owned`;
      },
      execute: async (raw) => {
        const a = raw as { person: string; scope: 'owned_by' | 'unowned' };
        if (a.scope === 'unowned') {
          const unowned = governanceGaps(db).unowned;
          const capped = unowned.slice(0, 50); // critical-first; count stays exact
          surface(capped.map((u) => ({ instanceId: u.instanceId, id: u.workflowId, name: u.name, instanceLabel: u.instanceLabel })));
          return {
            scope: 'unowned',
            unownedTotal: unowned.length,
            truncated: unowned.length > capped.length,
            workflows: capped.map((u) => ({ instanceId: u.instanceId, id: u.workflowId, name: u.name, criticality: u.criticality, hasInferredLead: u.inferred != null })),
          };
        }
        // owned_by — resolve the person to exact assigned-owner email(s).
        const term = a.person.trim().toLowerCase();
        if (!term) return { scope: 'owned_by', found: false, reason: 'no person given' };
        const owners = listAssignedOwners(db);
        const matches = owners.filter((o) => o.email?.toLowerCase() === term || (o.name ?? '').toLowerCase().includes(term) || (o.email ?? '').toLowerCase().includes(term));
        if (matches.length === 0) return { scope: 'owned_by', found: false, reason: `no assigned owner matches "${a.person}"` };
        if (matches.length > 1 && !matches.some((o) => o.email?.toLowerCase() === term)) {
          return { scope: 'owned_by', found: false, ambiguous: true, candidates: matches.map((o) => ({ name: o.name, email: o.email })) };
        }
        const target = matches.find((o) => o.email?.toLowerCase() === term) ?? matches[0]!;
        const owned = workflowsOwnedBy(db, target.email!);
        surface(owned.map((o) => ({ instanceId: o.instanceId, id: o.workflowId, name: o.name, instanceLabel: o.instanceLabel })));
        const spof = owned.filter((o) => o.singlePointOfFailure);
        return {
          scope: 'owned_by',
          found: true,
          person: { name: target.name, email: target.email },
          ownedTotal: owned.length,
          criticalOwned: owned.filter((o) => o.criticality === 'critical').length,
          singlePointOfFailureCount: spof.length,
          workflows: owned.map((o) => ({ instanceId: o.instanceId, id: o.workflowId, name: o.name, criticality: o.criticality, active: o.active, hasBackup: o.hasBackup, singlePointOfFailure: o.singlePointOfFailure })),
        };
      },
    },

    {
      name: 'governance_gaps',
      description:
        'Accountability holes. kind "all" returns every category; or target one: "unowned", "single_owner" (one person owning multiple criticals), "personal_space" (criticals in personal projects), "no_backup" (assigned critical with no backup owner).',
      schema: z.object({ kind: z.enum(['all', 'unowned', 'single_owner', 'personal_space', 'no_backup']) }),
      summarize: (r) => {
        const x = r as { counts?: Record<string, number> };
        return x.counts ? Object.entries(x.counts).map(([k, v]) => `${v} ${k}`).join(', ') : 'gaps';
      },
      execute: async (raw) => {
        const a = raw as { kind: 'all' | 'unowned' | 'single_owner' | 'personal_space' | 'no_backup' };
        const g = governanceGaps(db);
        // Unowned is critical-first; cap the returned/surfaced set so a large estate
        // doesn't flood the model or the reference chips (the count stays exact).
        const unownedCapped = g.unowned.slice(0, 50);
        surface(unownedCapped.map((u) => ({ instanceId: u.instanceId, id: u.workflowId, name: u.name, instanceLabel: u.instanceLabel })));
        const unowned = unownedCapped.map((u) => ({ instanceId: u.instanceId, id: u.workflowId, name: u.name, criticality: u.criticality }));
        const singleOwner = g.singleOwnerCritical.map((s) => ({ owner: s.owner, crossInstance: s.crossInstance, workflows: s.workflows.map((w) => ({ instanceId: w.instanceId, id: w.workflowId, name: w.name })) }));
        const personalSpace = g.personalSpaceCritical.map((p) => ({ instanceId: p.instanceId, id: p.workflowId, name: p.name, person: p.person }));
        const noBackup = g.noBackupOwner.map((n) => ({ instanceId: n.instanceId, id: n.workflowId, name: n.name, owner: n.owner }));
        const counts = { unowned: g.unowned.length, single_owner: singleOwner.length, personal_space: personalSpace.length, no_backup: noBackup.length };
        if (a.kind === 'unowned') return { counts, unowned };
        if (a.kind === 'single_owner') return { counts, singleOwner };
        if (a.kind === 'personal_space') return { counts, personalSpace };
        if (a.kind === 'no_backup') return { counts, noBackup };
        return { counts, unowned, singleOwner, personalSpace, noBackup };
      },
    },

    {
      name: 'mcp_exposure',
      description:
        'The external-agent attack surface: workflows published to n8n MCP and what each can reach through confirmed edges. Give a name for one workflow (add instanceId — an instance id OR a name like "prod"/"staging" — if the name matches several), or leave them "" to list all MCP-exposed workflows and whether each reaches a sensitive system (payments/production/etc).',
      schema: z.object({ name: z.string(), instanceId: z.string(), id: z.string() }),
      summarize: (r) => {
        const x = r as { exposedTotal?: number; reachesSensitive?: boolean };
        return x.exposedTotal != null ? `${x.exposedTotal} exposed` : x.reachesSensitive ? 'reaches sensitive' : 'reach mapped';
      },
      execute: async (raw) => {
        const a = raw as { name: string; instanceId: string; id: string };
        const edges = readAllEdges(db);
        const workflows = readGraphWorkflows(db);
        if (a.name.trim() || (a.instanceId && a.id)) {
          const res = resolveWorkflow(db, a);
          if (res.kind !== 'one') return { found: false, reason: `no single workflow matches "${a.name || a.id}"` };
          const w = res.workflow;
          const reach = computeMcpReach(edges, workflows, { instanceId: w.instanceId, workflowId: w.id }, new Date().toISOString());
          surface([w, ...reach.reachableWorkflows.map((x) => ({ instanceId: x.instanceId, id: x.workflowId, name: x.name }))]);
          return { found: true, workflow: refOf(w), reachesSensitive: reach.reachesSensitive, reachableSystems: reach.reachableSystems, reachableWorkflows: reach.reachableWorkflows.map((x) => ({ instanceId: x.instanceId, id: x.workflowId, name: x.name })) };
        }
        const exposed = listWorkflows(db, { mcp: true });
        surface(exposed);
        const mapped = exposed.map((w) => {
          const reach = computeMcpReach(edges, workflows, { instanceId: w.instanceId, workflowId: w.id }, new Date().toISOString());
          return { instanceId: w.instanceId, id: w.id, name: w.name, owner: ownerCompact(w), reachesSensitive: reach.reachesSensitive, reachableSystems: reach.reachableSystems };
        });
        return { exposedTotal: exposed.length, reachingSensitive: mapped.filter((m) => m.reachesSensitive).length, exposed: mapped };
      },
    },

    {
      name: 'fleet_stats',
      description:
        'Estate-wide governance posture (Argus-computed). section "score" returns the governance score + its five-pillar breakdown; "gaps" returns headline gap/health/exposure counts; "all" returns both.',
      schema: z.object({ section: z.enum(['score', 'gaps', 'all']) }),
      summarize: (r) => {
        const x = r as { score?: number | null };
        return x.score != null ? `score ${x.score}` : 'stats';
      },
      execute: async (raw) => {
        const a = raw as { section: 'score' | 'gaps' | 'all' };
        const o = governanceOverview(db, new Date().toISOString());
        const score = {
          score: o.score.score,
          pillars: o.score.pillars.map((p) => ({ key: p.key, label: p.label, score: p.score, scored: p.scored, reason: p.reason })),
        };
        const gaps = {
          unownedTotal: o.unowned.total,
          unownedByCriticality: o.unowned.byCriticality,
          failing: o.health.summary.failing,
          degraded: o.health.summary.degraded,
          mcpExposed: o.exposure.mcpExposed,
          reachingSensitive: o.exposure.reachingSensitive,
        };
        if (a.section === 'score') return { ...score };
        if (a.section === 'gaps') return { score: o.score.score, ...gaps };
        return { ...score, ...gaps };
      },
    },

    {
      name: 'audit_log',
      description:
        'The append-only governance timeline (who did what, when). Filter by entity (a workflow id), actor (a partial name or email — "sor" matches Sorin), and/or action family ("ownership" matches ownership.assign etc); leave "" to not filter. Newest first.',
      schema: z.object({ entity: z.string(), actor: z.string(), action: z.string(), limit: z.number().int().min(1).max(100) }),
      summarize: (r) => `${(r as { total: number }).total} entr${(r as { total: number }).total === 1 ? 'y' : 'ies'}`,
      execute: async (raw) => {
        const a = raw as { entity: string; actor: string; action: string; limit: number };
        const entries = listAudit(db, {
          entityType: undefined,
          actor: a.actor || undefined,
          action: a.action || undefined,
          limit: a.limit,
        }).filter((e) => (a.entity ? e.entityId === a.entity : true));
        return { total: entries.length, entries: entries.map((e) => ({ ts: e.ts, actor: e.actorName, actorEmail: e.actorEmail, action: e.action, entity: `${e.entityType}:${e.entityId ?? ''}`, detail: e.detail })) };
      },
    },

    {
      name: 'changelog',
      description: 'The most recent estate changes (ownership assignments, corrections, config), newest first. Use for "what changed recently".',
      schema: z.object({ limit: z.number().int().min(1).max(50) }),
      summarize: (r) => `${(r as { total: number }).total} change(s)`,
      execute: async (raw) => {
        const a = raw as { limit: number };
        const entries = listAudit(db, { limit: a.limit });
        return { total: entries.length, entries: entries.map((e) => ({ ts: e.ts, actor: e.actorName, action: e.action, entity: `${e.entityType}:${e.entityId ?? ''}` })) };
      },
    },
  ];

  // Egress backstop applied uniformly to EVERY tool: secret-scrub all free text, and (by
  // default) remove owner/actor emails (docs/DATA-FLOW-CHAT.md; DECISIONS #29). `recordRefs`
  // already fired inside execute with the REAL ids, so clickable references are unaffected;
  // only the model-facing JSON is transformed.
  return tools.map((t) => ({
    ...t,
    execute: async (input: unknown, signal?: AbortSignal) => redactToolOutput(await t.execute(input, signal), opts),
  }));
}
