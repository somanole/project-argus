import { z } from 'zod';
import { criticalitySchema } from './enrichment.js';

/**
 * The ownership & accountability contract — server ↔ web (standing rule 9, spec
 * .agents/specs/ownership.md). S4: every workflow resolves to an answerable owner,
 * the governance gaps are visible, and every ownership mutation is on the sacred,
 * append-only audit trail.
 *
 * Two provenances that must never blur:
 *  - ASSIGNED — an explicit human decision (durable, audited, authoritative).
 *  - INFERRED — advisory, derived from n8n project membership/roles only. Labeled
 *    "inferred", overridden by any assignment, and NEVER fabricated: when membership
 *    can't be read it degrades to "couldn't infer" with a reason (rule 5).
 */

/** A person reference — a name and/or an email (free-text people may lack an email). */
export const ownerRefSchema = z.object({
  email: z.string().nullable(),
  name: z.string().nullable(),
});
export type OwnerRef = z.infer<typeof ownerRefSchema>;

/** How a workflow's owner is known. */
export const ownershipStatusSchema = z.enum(['assigned', 'inferred', 'unowned']);
export type OwnershipStatus = z.infer<typeof ownershipStatusSchema>;

/**
 * Where the resolved owner came from:
 *  - assigned          — an explicit human assignment (authoritative).
 *  - personal-project  — inferred: the workflow lives in this person's personal space.
 *  - project-member    — inferred: the most-privileged member of the owning team project.
 *  - unavailable       — inference couldn't run (unlicensed / no `user:list` / fetch failed).
 */
export const ownershipSourceSchema = z.enum([
  'assigned',
  'personal-project',
  'project-member',
  'unavailable',
]);
export type OwnershipSource = z.infer<typeof ownershipSourceSchema>;

/**
 * The resolved owner that rides on every workflow list item (assigned overrides
 * inferred). `reason` carries the assignment justification OR the honest
 * "couldn't infer" explanation on `unavailable`.
 */
export const workflowOwnerSchema = z.object({
  status: ownershipStatusSchema,
  owner: ownerRefSchema.nullable(),
  backupOwner: ownerRefSchema.nullable(),
  reason: z.string().nullable(),
  source: ownershipSourceSchema.nullable(),
  /** The winning project role when source = project-member (e.g. "project:admin"). */
  memberRole: z.string().nullable(),
  // Provenance for an ASSIGNED owner (null on inferred/unowned):
  assignedBy: ownerRefSchema.nullable(),
  assignedAt: z.string().nullable(),
});
export type WorkflowOwner = z.infer<typeof workflowOwnerSchema>;

/**
 * Assign or reassign a primary owner (with optional backup + reason) in one call.
 * The owner can be a known n8n user (picker) or free-text (no email required) — but a
 * name or an email must be present.
 */
export const ownerAssignmentInputSchema = z
  .object({
    ownerEmail: z.string().trim().email().nullish(),
    ownerName: z.string().trim().max(200).nullish(),
    backupOwnerEmail: z.string().trim().email().nullish(),
    backupOwnerName: z.string().trim().max(200).nullish(),
    reason: z.string().trim().max(500).nullish(),
  })
  .refine((v) => Boolean(v.ownerEmail || v.ownerName), {
    message: 'an owner needs a name or email',
  });
export type OwnerAssignmentInput = z.infer<typeof ownerAssignmentInputSchema>;

/** Set or clear ONLY the backup owner (both fields empty = clear it). */
export const backupOwnerInputSchema = z.object({
  backupOwnerEmail: z.string().trim().email().nullish(),
  backupOwnerName: z.string().trim().max(200).nullish(),
  reason: z.string().trim().max(500).nullish(),
});
export type BackupOwnerInput = z.infer<typeof backupOwnerInputSchema>;

/** One selectable person for the assign-owner picker (an instance's known n8n users). */
export const assignableUserSchema = z.object({
  email: z.string(),
  name: z.string(),
  /** Global role slug (e.g. "global:admin"), shown as a hint; null if unknown. */
  role: z.string().nullable(),
});
export type AssignableUser = z.infer<typeof assignableUserSchema>;

/**
 * The picker payload. `available:false` (with a reason) when the user list couldn't be
 * read — the dialog still works via free-text; it never shows a fabricated roster.
 */
export const assignableUsersResponseSchema = z.object({
  users: z.array(assignableUserSchema),
  available: z.boolean(),
  reason: z.string().nullable(),
});
export type AssignableUsersResponse = z.infer<typeof assignableUsersResponseSchema>;

/** A workflow reference carried by every governance-gap item (criticality never bare). */
export const gapWorkflowSchema = z.object({
  instanceId: z.string(),
  instanceLabel: z.string(),
  workflowId: z.string(),
  name: z.string(),
  criticality: criticalitySchema.nullable(),
  criticalityReason: z.string().nullable(),
});
export type GapWorkflow = z.infer<typeof gapWorkflowSchema>;

/** "What has no owner" — an unowned workflow with its criticality + advisory inferred owner. */
export const unownedWorkflowSchema = gapWorkflowSchema.extend({
  inferred: workflowOwnerSchema.nullable(),
});
export type UnownedWorkflow = z.infer<typeof unownedWorkflowSchema>;

/**
 * single-owner-critical: one email is the SOLE owner of ≥2 critical workflows.
 * `crossInstance` is true when those workflows span more than one instance (the
 * fleet-wide single point of failure). Exact-email match only (fuzzy identity = S8).
 */
export const singleOwnerCriticalGapSchema = z.object({
  owner: ownerRefSchema,
  workflows: z.array(gapWorkflowSchema),
  crossInstance: z.boolean(),
});
export type SingleOwnerCriticalGap = z.infer<typeof singleOwnerCriticalGapSchema>;

/** personal-space-critical: a critical workflow living in someone's personal project. */
export const personalSpaceCriticalGapSchema = gapWorkflowSchema.extend({
  person: ownerRefSchema.nullable(),
});
export type PersonalSpaceCriticalGap = z.infer<typeof personalSpaceCriticalGapSchema>;

/** no-backup-owner: an assigned, critical workflow with no backup owner. */
export const noBackupOwnerGapSchema = gapWorkflowSchema.extend({
  owner: ownerRefSchema,
});
export type NoBackupOwnerGap = z.infer<typeof noBackupOwnerGapSchema>;

/** The Governance view's gaps payload. */
export const governanceGapsResponseSchema = z.object({
  unowned: z.array(unownedWorkflowSchema),
  singleOwnerCritical: z.array(singleOwnerCriticalGapSchema),
  personalSpaceCritical: z.array(personalSpaceCriticalGapSchema),
  noBackupOwner: z.array(noBackupOwnerGapSchema),
  generatedAt: z.string().datetime(),
});
export type GovernanceGapsResponse = z.infer<typeof governanceGapsResponseSchema>;

/** One entry in the Argus self-audit timeline (append-only; read-only here). */
export const auditTimelineEntrySchema = z.object({
  id: z.number().int(),
  ts: z.string(),
  actorName: z.string(),
  actorEmail: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  /** Non-secret context (before→after, reason, …) — the audit DAO forbids secrets here. */
  detail: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditTimelineEntry = z.infer<typeof auditTimelineEntrySchema>;

/** The filterable, paginated audit-timeline payload (Argus self-audit only in S4). */
export const auditTimelineResponseSchema = z.object({
  entries: z.array(auditTimelineEntrySchema),
  /** Distinct actions present, for the filter dropdown. */
  actions: z.array(z.string()),
  /** Total rows matching the current filters (across all pages) — the pagination denominator. */
  total: z.number().int().nonnegative(),
  /** Page size and the row offset this page started at (echoed back so the client can page). */
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
});
export type AuditTimelineResponse = z.infer<typeof auditTimelineResponseSchema>;
