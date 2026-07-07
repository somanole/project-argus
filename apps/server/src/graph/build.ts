import type { EdgeType, EdgeConfidence, GraphNodeKind, RefKind, WorkflowFacts } from '@argus/shared';

/**
 * The estate-wide edge builder (S5) — a PURE function over every workflow's stored
 * facts + the connections' public webhook hosts. Builds on S1b's already-resolved
 * direct deps; it does NOT re-parse workflows. Deterministic, unit-tested, never
 * throws.
 *
 * THE TRUST SPINE (rule 5, Principle 1): each edge carries a confidence. `confirmed`
 * = n8n literally wired it (a resolved sub-workflow/tool/agent/error call, a
 * credential binding, or a cross-instance webhook whose host disambiguates).
 * `possible` = an inference (an intra-instance webhook-URL guess, a shared-resource
 * association). Only confirmed edges may ever be counted in a factual impact number;
 * that filtering lives in the impact query, and this builder just labels honestly.
 */

export interface GraphWorkflow {
  instanceId: string;
  id: string;
  name: string;
  active: boolean;
  archived: boolean;
  facts: WorkflowFacts | null;
}

export interface GraphInstance {
  instanceId: string;
  label: string;
  /** The connection's public webhook host (may be a full URL or host:port); null if unknown. */
  webhookHost: string | null;
}

export interface NodeIdent {
  kind: GraphNodeKind;
  instanceId: string;
  id: string;
  label: string;
}

export interface BuiltEdge {
  src: NodeIdent;
  dst: NodeIdent;
  type: EdgeType;
  confidence: EdgeConfidence;
  crossInstance: boolean;
  reason: string;
}

/** Composite, self-contained node id for the client graph (wf:/cred:/dt:). */
export function nodeIdOf(n: Pick<NodeIdent, 'kind' | 'instanceId' | 'id'>): string {
  const prefix = n.kind === 'workflow' ? 'wf' : n.kind === 'credential' ? 'cred' : 'dt';
  return `${prefix}:${n.instanceId}:${n.id}`;
}

/** A workflow is an AI agent when it uses an agent / agentTool node (S5 badge). */
export function isAgentWorkflow(facts: WorkflowFacts | null): boolean {
  if (!facts) return false;
  return facts.nodeTypes.some(
    (n) => n.type === '@n8n/n8n-nodes-langchain.agent' || n.type === '@n8n/n8n-nodes-langchain.agentTool',
  );
}

/** How S1b ref kinds map onto graph edge types (all confirmed call-like edges). */
const REF_KIND_TO_EDGE: Record<RefKind, EdgeType> = {
  subWorkflow: 'call',
  toolWorkflow: 'tool',
  agentTool: 'agent_tool',
  errorWorkflow: 'error_workflow',
};

const REF_KIND_REASON: Record<RefKind, string> = {
  subWorkflow: 'executeWorkflow call',
  toolWorkflow: 'toolWorkflow call',
  agentTool: 'agentTool call',
  errorWorkflow: 'error workflow',
};

/** Normalize a webhook host (full URL or bare host[:port]) to a comparable `host[:port]`. */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Only trust a parse with a real "scheme://" — otherwise `new URL('localhost:5678')`
  // treats `localhost:` as the scheme and yields an empty host. Bare host[:port] is
  // reparsed with an http:// prefix.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const h = new URL(candidate).host.toLowerCase();
    return h === '' ? null : h;
  } catch {
    return null;
  }
}

const wfNode = (w: { instanceId: string; id: string; name: string }): NodeIdent => ({
  kind: 'workflow',
  instanceId: w.instanceId,
  id: w.id,
  label: w.name,
});

/**
 * Build every cross-workflow edge across the whole estate.
 * @param workflows every workflow in the cache, with its stored facts.
 * @param instances connection metadata incl. public webhook host (for cross-instance).
 */
export function buildEdges(workflows: GraphWorkflow[], instances: GraphInstance[]): BuiltEdge[] {
  const edges: BuiltEdge[] = [];

  // Index workflows by (instance,id) and names for label lookups.
  const byKey = new Map<string, GraphWorkflow>();
  for (const w of workflows) byKey.set(`${w.instanceId}::${w.id}`, w);
  const nameOf = (instanceId: string, id: string) => byKey.get(`${instanceId}::${id}`)?.name ?? id;

  // Map normalized webhook host → instanceId (for webhook↔HTTP matching).
  const hostToInstance = new Map<string, string>();
  for (const inst of instances) {
    const h = normalizeHost(inst.webhookHost);
    if (h) hostToInstance.set(h, inst.instanceId);
  }
  // Per-instance webhook path → set of workflow ids that expose it.
  const webhookIndex = new Map<string, Map<string, string[]>>(); // instanceId → (path → wfIds)
  for (const w of workflows) {
    for (const ep of w.facts?.webhookEndpoints ?? []) {
      if (!ep.path || ep.isExpression) continue;
      let m = webhookIndex.get(w.instanceId);
      if (!m) webhookIndex.set(w.instanceId, (m = new Map()));
      const arr = m.get(ep.path) ?? [];
      arr.push(w.id);
      m.set(ep.path, arr);
    }
  }

  // credential id → workflows binding it (per instance) — for shared-resource visuals.
  const dtSharers = new Map<string, Array<{ instanceId: string; id: string; name: string }>>(); // `${inst}::${dtId}`

  for (const w of workflows) {
    const facts = w.facts;
    if (!facts) continue;

    // (1) CONFIRMED call-like edges from S1b's RESOLVED direct deps. These target a
    // workflow in the SAME instance (resolve.ts guarantees intra-instance). Broken /
    // dynamic / unresolved refs are NOT edges — they stay node badges / gaps.
    for (const d of facts.directDeps) {
      if (d.resolution !== 'resolved' || !d.resolvedId) continue;
      edges.push({
        src: wfNode(w),
        dst: wfNode({ instanceId: w.instanceId, id: d.resolvedId, name: d.resolvedName ?? nameOf(w.instanceId, d.resolvedId) }),
        type: REF_KIND_TO_EDGE[d.kind],
        confidence: 'confirmed',
        crossInstance: false,
        reason: REF_KIND_REASON[d.kind],
      });
    }

    // (2) CONFIRMED caller-policy edges: settings.callerIds under workflowsFromAList is
    // an allow-list of workflows PERMITTED to call this one (caller → me). It is a
    // permission, not proof of a call, so it renders confirmed but is NOT in the
    // failure-impact edge set (real callers come from the resolved call edges above).
    if (facts.callerPolicy.policy === 'workflowsFromAList') {
      for (const callerId of facts.callerPolicy.callerIds) {
        if (!byKey.has(`${w.instanceId}::${callerId}`)) continue; // only draw to a known workflow
        edges.push({
          src: wfNode({ instanceId: w.instanceId, id: callerId, name: nameOf(w.instanceId, callerId) }),
          dst: wfNode(w),
          type: 'caller_policy',
          confidence: 'confirmed',
          crossInstance: false,
          reason: 'allow-listed caller',
        });
      }
    }

    // (3) CONFIRMED credential bindings: workflow → credential node. Fan-in on the
    // credential node IS the shared-credential SPOF (one credential, N workflows); the
    // rotate-credential impact traverses exactly these edges.
    const seenCred = new Set<string>();
    for (const c of facts.credentialRefs) {
      if (!c.credentialId || seenCred.has(c.credentialId)) continue;
      seenCred.add(c.credentialId);
      edges.push({
        src: wfNode(w),
        dst: { kind: 'credential', instanceId: w.instanceId, id: c.credentialId, label: c.credentialName ?? c.credentialType },
        type: 'binds_credential',
        confidence: 'confirmed',
        crossInstance: false,
        reason: `binds credential ${c.credentialName ?? c.credentialType}`,
      });
    }

    // (4) CONFIRMED data-table bindings: workflow → datatable node (id/list mode only).
    const seenDt = new Set<string>();
    for (const dt of facts.dataTableRefs) {
      if ((dt.mode !== 'id' && dt.mode !== 'list') || !dt.rawValue || seenDt.has(dt.rawValue)) continue;
      seenDt.add(dt.rawValue);
      const label = dt.cachedName ?? dt.rawValue;
      edges.push({
        src: wfNode(w),
        dst: { kind: 'datatable', instanceId: w.instanceId, id: dt.rawValue, label },
        type: 'binds_datatable',
        confidence: 'confirmed',
        crossInstance: false,
        reason: `uses data table ${label}`,
      });
      const key = `${w.instanceId}::${dt.rawValue}`;
      const arr = dtSharers.get(key) ?? [];
      arr.push({ instanceId: w.instanceId, id: w.id, name: w.name });
      dtSharers.set(key, arr);
    }

    // (5) webhook↔HTTP matches from this workflow's HTTP call sites.
    for (const cs of facts.httpCallsites) {
      if (cs.isExpression || !cs.host || !cs.webhookPath) continue; // unmatchable → no edge (rule 5)
      const targetInstance = hostToInstance.get(cs.host.toLowerCase());
      if (!targetInstance) continue; // host isn't a known webhook host — can't identify a target
      const targets = webhookIndex.get(targetInstance)?.get(cs.webhookPath) ?? [];
      for (const targetId of targets) {
        if (targetInstance === w.instanceId && targetId === w.id) continue; // self
        const crossInstance = targetInstance !== w.instanceId;
        edges.push({
          src: wfNode(w),
          dst: wfNode({ instanceId: targetInstance, id: targetId, name: nameOf(targetInstance, targetId) }),
          // Cross-instance: the host disambiguates → CONFIRMED. Intra-instance URL
          // match is a guess (path could collide) → POSSIBLE, never counted.
          type: crossInstance ? 'cross_instance_webhook' : 'webhook_http',
          confidence: crossInstance ? 'confirmed' : 'possible',
          crossInstance,
          reason: crossInstance
            ? `HTTP → ${cs.host}/webhook/${cs.webhookPath}`
            : `HTTP → webhook ${cs.webhookPath} (URL guess)`,
        });
      }
    }
  }

  // (6) POSSIBLE shared-data-table associations (workflow↔workflow) — an association,
  // not a dependency; NEVER counted in impact. Bounded to small clusters (the
  // credential-cluster case is represented by the credential node instead, to avoid a
  // hairball). One undirected pair rendered as a single edge.
  for (const sharers of dtSharers.values()) {
    if (sharers.length < 2 || sharers.length > 8) continue;
    for (let i = 0; i < sharers.length; i++) {
      for (let j = i + 1; j < sharers.length; j++) {
        const a = sharers[i]!;
        const b = sharers[j]!;
        edges.push({
          src: wfNode(a),
          dst: wfNode(b),
          type: 'shared_datatable',
          confidence: 'possible',
          crossInstance: a.instanceId !== b.instanceId,
          reason: 'shares a data table',
        });
      }
    }
  }

  return edges;
}
