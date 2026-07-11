import type Database from 'better-sqlite3';
import type {
  SessionActor,
  OwnerAssignmentInput,
  BackupOwnerInput,
  OwnerRef,
  WorkflowOwner,
  OwnershipSource,
  GapWorkflow,
  UnownedWorkflow,
  SingleOwnerCriticalGap,
  PersonalSpaceCriticalGap,
  NoBackupOwnerGap,
  GovernanceGapsResponse,
  OwnershipRegisterRow,
  OwnershipRegisterSummary,
  OwnershipRisk,
} from '@argus/shared';
import { withAudit } from '../db/audit.js';
import { listWorkflows } from '../workflows/repo.js';

/**
 * Data access for S4 ownership. Two provenances (spec .agents/specs/ownership.md):
 *  - workflow_ownership — DURABLE, AUDITED explicit assignments. Every mutation here
 *    goes through withAudit (mutation + append-only audit entry in one transaction) —
 *    there is NO other write path, which is guarantee (ii). No FK to `workflows`, so a
 *    resync can't touch it, which is guarantee (i).
 *  - workflow_inferred_owner — DISPOSABLE advisory cache, rebuilt each sync by the
 *    inference service (replaceInferredOwners); NEVER audited.
 * The read path COALESCEs assigned over inferred (buildResolvedOwner).
 */

// ── Row shapes ───────────────────────────────────────────────────────────────

interface OwnershipRow {
  owner_email: string | null;
  owner_name: string | null;
  backup_owner_email: string | null;
  backup_owner_name: string | null;
  reason: string | null;
  assigned_by_name: string;
  assigned_by_email: string;
  assigned_at: string;
  updated_at: string;
}

/** The assigned-owner columns the read path needs (aliased, from either repo's join). */
export interface AssignedOwnerFields {
  owner_email: string | null;
  owner_name: string | null;
  backup_owner_email: string | null;
  backup_owner_name: string | null;
  reason: string | null;
  assigned_by_name: string | null;
  assigned_by_email: string | null;
  assigned_at: string | null;
}

/** The inferred-owner columns the read path needs (aliased). */
export interface InferredOwnerFields {
  owner_email: string | null;
  owner_name: string | null;
  source: string | null;
  member_role: string | null;
  reason: string | null;
}

const ref = (email: string | null, name: string | null) =>
  email != null || name != null ? { email, name } : null;

/**
 * The single source of truth for resolving a workflow's owner: an explicit assignment
 * (authoritative) overrides an inferred advisory owner, which overrides unowned. Used
 * by both this repo and the workflows list repo so precedence can never drift.
 */
export function buildResolvedOwner(
  a: AssignedOwnerFields | null,
  i: InferredOwnerFields | null,
): WorkflowOwner {
  if (a && a.assigned_at != null) {
    return {
      status: 'assigned',
      owner: ref(a.owner_email, a.owner_name),
      backupOwner: ref(a.backup_owner_email, a.backup_owner_name),
      reason: a.reason,
      source: 'assigned',
      memberRole: null,
      assignedBy: ref(a.assigned_by_name != null ? a.assigned_by_email : null, a.assigned_by_name),
      assignedAt: a.assigned_at,
    };
  }
  if (i && i.source != null) {
    const owner = ref(i.owner_email, i.owner_name);
    return {
      // An inferred row with no resolvable person (source 'unavailable') is unowned,
      // but still carries the honest "couldn't infer" reason.
      status: owner ? 'inferred' : 'unowned',
      owner,
      backupOwner: null,
      reason: i.reason,
      source: i.source as OwnershipSource,
      memberRole: i.member_role,
      assignedBy: null,
      assignedAt: null,
    };
  }
  return {
    status: 'unowned',
    owner: null,
    backupOwner: null,
    reason: null,
    source: null,
    memberRole: null,
    assignedBy: null,
    assignedAt: null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

function getOwnershipRow(db: Database.Database, instanceId: string, workflowId: string): OwnershipRow | undefined {
  return db
    .prepare('SELECT * FROM workflow_ownership WHERE instance_id = ? AND workflow_id = ?')
    .get(instanceId, workflowId) as OwnershipRow | undefined;
}

/** The resolved owner for one workflow (assigned over inferred over unowned). */
export function resolveOwner(db: Database.Database, instanceId: string, workflowId: string): WorkflowOwner {
  const a = getOwnershipRow(db, instanceId, workflowId) ?? null;
  const i = db
    .prepare('SELECT owner_email, owner_name, source, member_role, reason FROM workflow_inferred_owner WHERE instance_id = ? AND workflow_id = ?')
    .get(instanceId, workflowId) as InferredOwnerFields | undefined;
  return buildResolvedOwner(a, i ?? null);
}

// ── Audited mutations (mirror enrichment/repo.ts correctLabel) ────────────────

function snapshot(row?: OwnershipRow) {
  return {
    ownerEmail: row?.owner_email ?? null,
    ownerName: row?.owner_name ?? null,
    backupOwnerEmail: row?.backup_owner_email ?? null,
    backupOwnerName: row?.backup_owner_name ?? null,
  };
}

/**
 * Assign or reassign the primary owner (+ optional backup + reason). Audited: the
 * action is `ownership.reassign` when a prior primary owner existed, else
 * `ownership.assign`; the detail records before→after and the reason.
 */
export function assignOwner(
  db: Database.Database,
  actor: SessionActor,
  instanceId: string,
  workflowId: string,
  input: OwnerAssignmentInput,
): WorkflowOwner {
  const prior = getOwnershipRow(db, instanceId, workflowId);
  const now = new Date().toISOString();
  const next = {
    owner_email: input.ownerEmail ?? null,
    owner_name: input.ownerName ?? null,
    backup_owner_email: input.backupOwnerEmail ?? prior?.backup_owner_email ?? null,
    backup_owner_name: input.backupOwnerName ?? prior?.backup_owner_name ?? null,
    reason: input.reason ?? null,
  };
  const action = prior?.owner_email ? 'ownership.reassign' : 'ownership.assign';
  withAudit(
    db,
    actor,
    {
      action,
      entityType: 'workflow_ownership',
      entityId: `${instanceId}/${workflowId}`,
      detail: {
        instanceId,
        workflowId,
        before: snapshot(prior),
        after: { ownerEmail: next.owner_email, ownerName: next.owner_name, backupOwnerEmail: next.backup_owner_email, backupOwnerName: next.backup_owner_name },
        reason: input.reason ?? null,
      },
    },
    () => {
      db.prepare(
        `INSERT INTO workflow_ownership
           (instance_id, workflow_id, owner_email, owner_name, backup_owner_email, backup_owner_name,
            reason, assigned_by_name, assigned_by_email, assigned_at, updated_at)
         VALUES (@instance_id, @workflow_id, @owner_email, @owner_name, @backup_owner_email, @backup_owner_name,
            @reason, @assigned_by_name, @assigned_by_email, @assigned_at, @updated_at)
         ON CONFLICT(instance_id, workflow_id) DO UPDATE SET
            owner_email=@owner_email, owner_name=@owner_name,
            backup_owner_email=@backup_owner_email, backup_owner_name=@backup_owner_name,
            reason=@reason, assigned_by_name=@assigned_by_name, assigned_by_email=@assigned_by_email,
            updated_at=@updated_at`,
      ).run({
        instance_id: instanceId,
        workflow_id: workflowId,
        ...next,
        assigned_by_name: actor.name,
        assigned_by_email: actor.email,
        assigned_at: prior?.assigned_at ?? now,
        updated_at: now,
      });
    },
  );
  return resolveOwner(db, instanceId, workflowId);
}

/**
 * Set or clear ONLY the backup owner (both fields empty = clear). Audited as
 * `ownership.backup.set`. Creates a backup-only row if no assignment exists yet.
 */
export function setBackupOwner(
  db: Database.Database,
  actor: SessionActor,
  instanceId: string,
  workflowId: string,
  input: BackupOwnerInput,
): WorkflowOwner {
  const prior = getOwnershipRow(db, instanceId, workflowId);
  const now = new Date().toISOString();
  const backupEmail = input.backupOwnerEmail ?? null;
  const backupName = input.backupOwnerName ?? null;
  withAudit(
    db,
    actor,
    {
      action: 'ownership.backup.set',
      entityType: 'workflow_ownership',
      entityId: `${instanceId}/${workflowId}`,
      detail: {
        instanceId,
        workflowId,
        before: { backupOwnerEmail: prior?.backup_owner_email ?? null, backupOwnerName: prior?.backup_owner_name ?? null },
        after: { backupOwnerEmail: backupEmail, backupOwnerName: backupName },
        reason: input.reason ?? null,
      },
    },
    () => {
      if (prior) {
        db.prepare(
          'UPDATE workflow_ownership SET backup_owner_email=?, backup_owner_name=?, updated_at=? WHERE instance_id=? AND workflow_id=?',
        ).run(backupEmail, backupName, now, instanceId, workflowId);
      } else {
        db.prepare(
          `INSERT INTO workflow_ownership
             (instance_id, workflow_id, owner_email, owner_name, backup_owner_email, backup_owner_name,
              reason, assigned_by_name, assigned_by_email, assigned_at, updated_at)
           VALUES (?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?)`,
        ).run(instanceId, workflowId, backupEmail, backupName, actor.name, actor.email, now, now);
      }
    },
  );
  return resolveOwner(db, instanceId, workflowId);
}

/** Remove an explicit assignment (falls back to inferred/unowned). Audited as `ownership.remove`. False if nothing was assigned. */
export function removeOwner(
  db: Database.Database,
  actor: SessionActor,
  instanceId: string,
  workflowId: string,
  reason?: string | null,
): boolean {
  const prior = getOwnershipRow(db, instanceId, workflowId);
  if (!prior) return false;
  return withAudit(
    db,
    actor,
    {
      action: 'ownership.remove',
      entityType: 'workflow_ownership',
      entityId: `${instanceId}/${workflowId}`,
      detail: { instanceId, workflowId, before: snapshot(prior), after: null, reason: reason ?? null },
    },
    () => {
      db.prepare('DELETE FROM workflow_ownership WHERE instance_id = ? AND workflow_id = ?').run(instanceId, workflowId);
      return true;
    },
  );
}

// ── Inferred-owner cache (written by the inference service, never audited) ─────

export interface InferredOwnerRow {
  workflowId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  source: 'personal-project' | 'project-member' | 'unavailable';
  memberRole: string | null;
  reason: string | null;
}

/** Full-replace one instance's inferred-owner cache (mirrors replaceInstanceHealth). */
export function replaceInferredOwners(
  db: Database.Database,
  instanceId: string,
  rows: InferredOwnerRow[],
  computedAt: string,
): void {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM workflow_inferred_owner WHERE instance_id = ?').run(instanceId);
    const insert = db.prepare(
      `INSERT INTO workflow_inferred_owner
         (instance_id, workflow_id, owner_email, owner_name, source, member_role, reason, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(instanceId, r.workflowId, r.ownerEmail, r.ownerName, r.source, r.memberRole, r.reason, computedAt);
    }
  });
  run();
}

// ── Governance gaps ───────────────────────────────────────────────────────────

// Effective criticality = an owner correction overrides the model's label (same
// expression the workflows list uses). Repeated in the CASE for portable ORDER BY.
const CRIT = `COALESCE(json_extract(e.corrected_json,'$.criticality'), json_extract(e.enrichment_json,'$.criticality'))`;
const CRIT_REASON = `json_extract(e.enrichment_json,'$.criticalityReason')`;
const CRIT_RANK = `CASE ${CRIT} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
const ENRICH_JOIN = 'LEFT JOIN workflow_enrichments e ON e.instance_id = w.instance_id AND e.workflow_id = w.id';

interface GapRow {
  instance_id: string;
  instance_label: string;
  workflow_id: string;
  name: string;
  criticality: string | null;
  criticality_reason: string | null;
}
const toGapWorkflow = (r: GapRow): GapWorkflow => ({
  instanceId: r.instance_id,
  instanceLabel: r.instance_label,
  workflowId: r.workflow_id,
  name: r.name,
  criticality: (r.criticality as GapWorkflow['criticality']) ?? null,
  criticalityReason: r.criticality_reason,
});

/** "What has no owner" — workflows with no assigned primary owner, criticality + advisory inference, critical-first. */
export function listUnowned(db: Database.Database): UnownedWorkflow[] {
  const rows = db
    .prepare(
      `SELECT w.instance_id, c.label AS instance_label, w.id AS workflow_id, w.name,
              ${CRIT} AS criticality, ${CRIT_REASON} AS criticality_reason,
              io.owner_email AS inf_owner_email, io.owner_name AS inf_owner_name,
              io.source AS inf_source, io.member_role AS inf_member_role, io.reason AS inf_reason
         FROM workflows w
         JOIN connections c ON c.id = w.instance_id
         ${ENRICH_JOIN}
         LEFT JOIN workflow_ownership o ON o.instance_id = w.instance_id AND o.workflow_id = w.id
         LEFT JOIN workflow_inferred_owner io ON io.instance_id = w.instance_id AND io.workflow_id = w.id
        WHERE o.workflow_id IS NULL OR o.owner_email IS NULL
        ORDER BY ${CRIT_RANK}, c.label, w.name`,
    )
    .all() as (GapRow & {
      inf_owner_email: string | null;
      inf_owner_name: string | null;
      inf_source: string | null;
      inf_member_role: string | null;
      inf_reason: string | null;
    })[];
  return rows.map((r) => ({
    ...toGapWorkflow(r),
    inferred:
      r.inf_source != null
        ? buildResolvedOwner(null, {
            owner_email: r.inf_owner_email,
            owner_name: r.inf_owner_name,
            source: r.inf_source,
            member_role: r.inf_member_role,
            reason: r.inf_reason,
          })
        : null,
  }));
}

/**
 * single-owner-critical: one email that is the sole owner of ≥2 CRITICAL workflows,
 * grouped by email across BOTH instances (exact-email; cross-instance = spans >1
 * instance). Each workflow has exactly one assigned owner, so grouping by owner_email
 * over the critical set is the "sole owner of multiple" signal.
 */
export function singleOwnerCritical(db: Database.Database): SingleOwnerCriticalGap[] {
  const rows = db
    .prepare(
      `SELECT o.owner_email, o.owner_name, w.instance_id, c.label AS instance_label, w.id AS workflow_id, w.name,
              ${CRIT} AS criticality, ${CRIT_REASON} AS criticality_reason
         FROM workflow_ownership o
         JOIN workflows w ON w.instance_id = o.instance_id AND w.id = o.workflow_id
         JOIN connections c ON c.id = w.instance_id
         ${ENRICH_JOIN}
        WHERE o.owner_email IS NOT NULL AND ${CRIT} = 'critical'
        ORDER BY o.owner_email, c.label, w.name`,
    )
    .all() as (GapRow & { owner_email: string; owner_name: string | null })[];

  const byOwner = new Map<string, { name: string | null; workflows: GapWorkflow[]; instances: Set<string> }>();
  for (const r of rows) {
    let g = byOwner.get(r.owner_email);
    if (!g) {
      g = { name: r.owner_name, workflows: [], instances: new Set() };
      byOwner.set(r.owner_email, g);
    }
    if (g.name == null && r.owner_name != null) g.name = r.owner_name;
    g.workflows.push(toGapWorkflow(r));
    g.instances.add(r.instance_id);
  }
  return [...byOwner.entries()]
    .filter(([, g]) => g.workflows.length >= 2)
    .map(([email, g]) => ({
      owner: { email, name: g.name },
      workflows: g.workflows,
      crossInstance: g.instances.size > 1,
    }));
}

/** personal-space-critical: a CRITICAL workflow inferred to live in a personal project. */
export function personalSpaceCritical(db: Database.Database): PersonalSpaceCriticalGap[] {
  const rows = db
    .prepare(
      `SELECT w.instance_id, c.label AS instance_label, w.id AS workflow_id, w.name,
              ${CRIT} AS criticality, ${CRIT_REASON} AS criticality_reason,
              io.owner_email AS person_email, io.owner_name AS person_name
         FROM workflows w
         JOIN connections c ON c.id = w.instance_id
         JOIN workflow_inferred_owner io
           ON io.instance_id = w.instance_id AND io.workflow_id = w.id AND io.source = 'personal-project'
         ${ENRICH_JOIN}
        WHERE ${CRIT} = 'critical'
        ORDER BY c.label, w.name`,
    )
    .all() as (GapRow & { person_email: string | null; person_name: string | null })[];
  return rows.map((r) => ({
    ...toGapWorkflow(r),
    person: ref(r.person_email, r.person_name),
  }));
}

/** no-backup-owner: an assigned, CRITICAL workflow with no backup owner. */
export function noBackupOwner(db: Database.Database): NoBackupOwnerGap[] {
  const rows = db
    .prepare(
      `SELECT o.owner_email, o.owner_name, w.instance_id, c.label AS instance_label, w.id AS workflow_id, w.name,
              ${CRIT} AS criticality, ${CRIT_REASON} AS criticality_reason
         FROM workflow_ownership o
         JOIN workflows w ON w.instance_id = o.instance_id AND w.id = o.workflow_id
         JOIN connections c ON c.id = w.instance_id
         ${ENRICH_JOIN}
        WHERE o.owner_email IS NOT NULL AND o.backup_owner_email IS NULL AND ${CRIT} = 'critical'
        ORDER BY c.label, w.name`,
    )
    .all() as (GapRow & { owner_email: string; owner_name: string | null })[];
  return rows.map((r) => ({ ...toGapWorkflow(r), owner: { email: r.owner_email, name: r.owner_name } }));
}

/** The whole Governance-view gaps payload. */
export function governanceGaps(db: Database.Database): Omit<GovernanceGapsResponse, 'generatedAt'> {
  return {
    unowned: listUnowned(db),
    singleOwnerCritical: singleOwnerCritical(db),
    personalSpaceCritical: personalSpaceCritical(db),
    noBackupOwner: noBackupOwner(db),
  };
}

// ── Ownership register (the Ownership Estate view) ────────────────────────────

/** Filters for the ownership register (all optional; sane defaults in the route). */
export interface OwnershipRegisterFilters {
  /** Ownership state: needs-owner (not assigned) · confirmed · inferred · unowned · all. */
  state?: 'needs-owner' | 'confirmed' | 'inferred' | 'unowned' | 'all' | undefined;
  /** Only rows carrying this specific accountability risk (backs the SPOF / personal-space filters). */
  risk?: OwnershipRisk | undefined;
  /** Only critical workflows lacking resilient accountability. */
  criticalAtRisk?: boolean | undefined;
  instanceId?: string | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

const wfKeyOf = (instanceId: string, workflowId: string): string => `${instanceId}/${workflowId}`;
/** unowned/inferred sort before assigned; criticals before the rest. */
const STATUS_RANK: Record<string, number> = { unowned: 0, inferred: 1, assigned: 2 };

/**
 * The estate's accountability register: every workflow with its resolved owner + the
 * accountability RISKS that apply (no-confirmed-owner / SPOF / personal-space / no-backup),
 * filtered, worst-first, and paginated. The risk flags reuse the exact gap logic
 * (`singleOwnerCritical` / `personalSpaceCritical` / `noBackupOwner`) so the register can
 * never diverge from the governance gaps. `summary` is the posture over ALL workflows;
 * `total` is the FILTERED count (the pager denominator). Factual ownership = assigned (rule 12).
 */
export function ownershipRegister(
  db: Database.Database,
  filters: OwnershipRegisterFilters = {},
): { rows: OwnershipRegisterRow[]; summary: OwnershipRegisterSummary; total: number } {
  const all = listWorkflows(db); // full estate (no page) — the register composes + paginates in JS
  // SPOF + personal-space reuse the exact gap logic (consistency by construction). "No backup"
  // is broader than the critical-only governance gap: ANY confirmed owner with no backup is
  // "one person away from unowned" — so we read it straight off each row's resolved owner.
  const spofKeys = new Set(singleOwnerCritical(db).flatMap((g) => g.workflows.map((w) => wfKeyOf(w.instanceId, w.workflowId))));
  const personalKeys = new Set(personalSpaceCritical(db).map((w) => wfKeyOf(w.instanceId, w.workflowId)));

  const decorated = all.map((w) => {
    const key = wfKeyOf(w.instanceId, w.id);
    const status = w.owner?.status ?? 'unowned';
    const noBackup = status === 'assigned' && !w.owner?.backupOwner; // confirmed owner, no backup
    const risks: OwnershipRisk[] = [];
    if (status !== 'assigned') risks.push('no-confirmed-owner');
    if (spofKeys.has(key)) risks.push('spof');
    if (personalKeys.has(key)) risks.push('personal-space');
    if (noBackup) risks.push('no-backup');
    const criticalAtRisk = w.enrichment?.criticality === 'critical' && (status !== 'assigned' || spofKeys.has(key) || noBackup);
    return { row: { ...w, risks }, status, criticalAtRisk, noBackup };
  });

  const summary: OwnershipRegisterSummary = {
    total: decorated.length,
    confirmed: decorated.filter((d) => d.status === 'assigned').length,
    inferred: decorated.filter((d) => d.status === 'inferred').length,
    unowned: decorated.filter((d) => d.status === 'unowned').length,
    criticalAtRisk: decorated.filter((d) => d.criticalAtRisk).length,
    noBackup: decorated.filter((d) => d.noBackup).length,
  };

  const q = filters.q?.trim().toLowerCase();
  const filtered = decorated.filter((d) => {
    if (filters.instanceId && d.row.instanceId !== filters.instanceId) return false;
    if (q && !d.row.name.toLowerCase().includes(q)) return false;
    if (filters.criticalAtRisk && !d.criticalAtRisk) return false;
    if (filters.risk && !d.row.risks.includes(filters.risk)) return false;
    switch (filters.state) {
      case 'needs-owner': return d.status !== 'assigned';
      case 'confirmed': return d.status === 'assigned';
      case 'inferred': return d.status === 'inferred';
      case 'unowned': return d.status === 'unowned';
      default: return true; // 'all' or undefined
    }
  });

  const CRIT_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  filtered.sort((a, b) => {
    const ca = CRIT_ORDER[a.row.enrichment?.criticality ?? ''] ?? 4;
    const cb = CRIT_ORDER[b.row.enrichment?.criticality ?? ''] ?? 4;
    if (ca !== cb) return ca - cb; // criticals first
    const sa = STATUS_RANK[a.status] ?? 3;
    const sb = STATUS_RANK[b.status] ?? 3;
    if (sa !== sb) return sa - sb; // unowned/inferred before assigned
    return a.row.name.localeCompare(b.row.name);
  });

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 5000);
  const offset = Math.max(filters.offset ?? 0, 0);
  const rows = filtered.slice(offset, offset + limit).map((d) => d.row);
  return { rows, summary, total: filtered.length };
}

// ── S7 chat: "what does X own / what if X leaves" ─────────────────────────────

export interface OwnedWorkflow {
  instanceId: string;
  instanceLabel: string;
  workflowId: string;
  name: string;
  criticality: string | null;
  active: boolean;
  hasBackup: boolean;
  /** critical + no backup owner ⇒ this person is a single point of failure for it. */
  singlePointOfFailure: boolean;
}

/**
 * Every workflow with an ASSIGNED owner whose email matches (case-insensitive),
 * estate-wide — the read behind chat's "what does X own / what if X leaves". Keys on
 * ASSIGNED ownership ONLY (standing rule 12: inferred ownership is advisory, never
 * counted as owned) — an inferred-only workflow is never returned here. Computes no new
 * fact; it re-shapes existing ownership + criticality data.
 */
export function workflowsOwnedBy(db: Database.Database, email: string): OwnedWorkflow[] {
  const rows = db
    .prepare(
      `SELECT w.instance_id, c.label AS instance_label, w.id AS workflow_id, w.name, w.active AS active,
              ${CRIT} AS criticality, ${CRIT_REASON} AS criticality_reason, o.backup_owner_email AS backup_email
         FROM workflow_ownership o
         JOIN workflows w ON w.instance_id = o.instance_id AND w.id = o.workflow_id
         JOIN connections c ON c.id = w.instance_id
         ${ENRICH_JOIN}
        WHERE o.owner_email IS NOT NULL AND LOWER(o.owner_email) = LOWER(?)
        ORDER BY ${CRIT_RANK}, c.label, w.name`,
    )
    .all(email) as (GapRow & { active: number; backup_email: string | null })[];
  return rows.map((r) => {
    const hasBackup = r.backup_email != null;
    return {
      instanceId: r.instance_id,
      instanceLabel: r.instance_label,
      workflowId: r.workflow_id,
      name: r.name,
      criticality: r.criticality,
      active: r.active === 1,
      hasBackup,
      singlePointOfFailure: r.criticality === 'critical' && !hasBackup,
    };
  });
}

/**
 * Distinct people who hold an ASSIGNED owner role, estate-wide — lets chat resolve a
 * name ("Sarah") to the exact owner email(s) before calling `workflowsOwnedBy`. Never
 * fabricates a person: if a name matches nobody, the caller says so (rule 5).
 */
export function listAssignedOwners(db: Database.Database): OwnerRef[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT owner_email AS email, owner_name AS name
         FROM workflow_ownership WHERE owner_email IS NOT NULL ORDER BY owner_email`,
    )
    .all() as { email: string; name: string | null }[];
  return rows.map((r) => ({ email: r.email, name: r.name }));
}
