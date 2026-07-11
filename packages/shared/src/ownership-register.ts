import { z } from 'zod';
import { workflowListItemSchema } from './workflows.js';

/**
 * The ownership register (S4, the Ownership Estate view). The estate's accountability
 * working surface: one paginated, filterable table of workflows focused on OWNERSHIP —
 * each row is a full workflow list item plus the accountability RISKS that apply to it.
 * In its own module (not ownership.ts) to avoid a circular import — workflows.ts already
 * imports the owner schema from ownership.ts.
 *
 * Factual ownership = an explicitly ASSIGNED owner (rule 12). An inferred owner is
 * advisory only; a workflow with only an inferred owner still reads "no confirmed owner".
 */

/** A per-workflow accountability risk (drives the row's risk chips + the quick filters). */
export const ownershipRiskSchema = z.enum(['no-confirmed-owner', 'spof', 'personal-space', 'no-backup']);
export type OwnershipRisk = z.infer<typeof ownershipRiskSchema>;

/** One register row: the workflow (with its resolved owner) + the risks that apply. */
export const ownershipRegisterRowSchema = workflowListItemSchema.extend({
  risks: z.array(ownershipRiskSchema),
});
export type OwnershipRegisterRow = z.infer<typeof ownershipRegisterRowSchema>;

/** The estate-wide accountability posture (computed over ALL workflows, not the filtered page). */
export const ownershipRegisterSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  /** Workflows with a confirmed (assigned) owner — the only factual ownership. */
  confirmed: z.number().int().nonnegative(),
  /** Workflows whose only owner is an advisory inferred one (not factually owned). */
  inferred: z.number().int().nonnegative(),
  /** Workflows with no owner at all — not even an inferred lead. */
  unowned: z.number().int().nonnegative(),
  /** Critical workflows lacking resilient accountability (unowned / SPOF / no backup). */
  criticalAtRisk: z.number().int().nonnegative(),
  /** Assigned workflows with no backup owner. */
  noBackup: z.number().int().nonnegative(),
});
export type OwnershipRegisterSummary = z.infer<typeof ownershipRegisterSummarySchema>;

/** The paginated register payload. `total` is the FILTERED count (the pager denominator). */
export const ownershipRegisterResponseSchema = z.object({
  rows: z.array(ownershipRegisterRowSchema),
  summary: ownershipRegisterSummarySchema,
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
});
export type OwnershipRegisterResponse = z.infer<typeof ownershipRegisterResponseSchema>;
