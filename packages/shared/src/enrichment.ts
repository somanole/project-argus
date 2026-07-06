import { z } from 'zod';

/**
 * The enrichment (sense-making) contract — server ↔ web (standing rule 9, spec
 * .agents/specs/enrichment.md). The LLM NARRATES; it never computes (rule 5). Two
 * schemas here:
 *  - enrichmentOutputSchema — exactly what the model must return (all fields required;
 *    validated at the wrapper's structured-output seam). Mirrors the strict JSON schema
 *    proven against the real API in contracts/llm-openai-structured.json.
 *  - workflowEnrichmentSchema — what the API serves per workflow: the output plus an
 *    honest status + provenance. On a `stub` ("couldn't analyze") the semantic fields
 *    are null — never fabricated. On `stale` the last-known values show, flagged.
 * NO URL/hostname/domain is ever part of enrichment input (DECISION #26) — that lives
 * in the server allowlist, not this contract, but it's why nothing URL-shaped appears.
 */

/** Business category — a CLOSED set. `other` is the honest bucket, never a forced guess. */
export const enrichmentCategorySchema = z.enum([
  'revenue-ops',
  'sales-marketing',
  'customer-support',
  'data-pipeline',
  'integration',
  'internal-ops',
  'monitoring-alerting',
  'ai-agent',
  'other',
]);
export type EnrichmentCategory = z.infer<typeof enrichmentCategorySchema>;

/** How much the workflow matters. Always shown WITH its reason, never bare. */
export const criticalitySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type Criticality = z.infer<typeof criticalitySchema>;

/**
 * Advisory business-risk JUDGMENTS the model infers from purpose — distinct from
 * S1b's deterministic governance flags (orphan, broken_ref, …). They complement,
 * never restate, the structural flags.
 */
export const riskFlagSchema = z.enum([
  'handles-pii',
  'handles-financial-data',
  'external-egress',
  'customer-facing',
  'production-write',
  'compliance-sensitive',
]);
export type RiskFlag = z.infer<typeof riskFlagSchema>;

/** analyzed = a real LLM answer; stub = couldn't analyze (rule 5); stale = input changed, not yet re-enriched. */
export const enrichmentStatusSchema = z.enum(['analyzed', 'stub', 'stale']);
export type EnrichmentStatus = z.infer<typeof enrichmentStatusSchema>;

/** EXACTLY what the LLM must return — the structured-output seam validates against this. */
export const enrichmentOutputSchema = z.object({
  summary: z.string(),
  description: z.string(),
  category: enrichmentCategorySchema,
  criticality: criticalitySchema,
  /** Always displayed next to the criticality label — never a bare level. */
  criticalityReason: z.string(),
  riskFlags: z.array(riskFlagSchema),
  suggestedOwnerRationale: z.string(),
  businessContext: z.string(),
});
export type EnrichmentOutput = z.infer<typeof enrichmentOutputSchema>;

/**
 * What the API serves per workflow. Semantic fields are nullable so a `stub` renders
 * honestly (never a fabricated category/criticality). `corrected` is true when the
 * owner has overlaid a label (audit-logged separately).
 */
export const workflowEnrichmentSchema = z.object({
  status: enrichmentStatusSchema,
  /** Provenance for the UI ("Analyzed by OpenAI gpt-5-mini"). */
  provider: z.string(),
  model: z.string(),
  enrichedAt: z.string(),
  /** True when a human label correction is overlaid on the model output. */
  corrected: z.boolean(),
  // Semantic fields — present on `analyzed`/`stale`, null on `stub`:
  summary: z.string().nullable(),
  description: z.string().nullable(),
  category: enrichmentCategorySchema.nullable(),
  criticality: criticalitySchema.nullable(),
  criticalityReason: z.string().nullable(),
  riskFlags: z.array(riskFlagSchema),
  suggestedOwnerRationale: z.string().nullable(),
  businessContext: z.string().nullable(),
});
export type WorkflowEnrichment = z.infer<typeof workflowEnrichmentSchema>;

/**
 * A one-click label correction (a mutation → audited, DECISION #6). At least one field
 * must be present; only category and criticality are correctable (the model's free-text
 * is not hand-edited).
 */
export const enrichmentCorrectionSchema = z
  .object({
    category: enrichmentCategorySchema.optional(),
    criticality: criticalitySchema.optional(),
    /** Optional note from the owner explaining the correction (goes to the audit detail). */
    note: z.string().max(500).optional(),
  })
  .refine((v) => v.category !== undefined || v.criticality !== undefined, {
    message: 'a correction must change category or criticality',
  });
export type EnrichmentCorrection = z.infer<typeof enrichmentCorrectionSchema>;

/** Per-estate enrichment progress, for the "enriched X/Y" indicator next to coverage. */
export const enrichmentProgressSchema = z.object({
  /** Whether enrichment is enabled + configured at all (kill switch / no provider → false). */
  enabled: z.boolean(),
  /** When any workflow was most recently enriched (ISO), or null if never. */
  lastEnrichedAt: z.string().nullable(),
  total: z.number().int(),
  analyzed: z.number().int(),
  stub: z.number().int(),
  stale: z.number().int(),
  pending: z.number().int(),
});
export type EnrichmentProgress = z.infer<typeof enrichmentProgressSchema>;
