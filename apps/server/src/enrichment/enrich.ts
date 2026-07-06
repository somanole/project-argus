import { enrichmentOutputSchema, type EnrichmentOutput } from '@argus/shared';
import { LlmError, type LlmClient, type LlmErrorKind, type TokenUsage } from '../llm/index.js';
import type { EnrichmentInput } from './allowlist.js';
import { buildPrompt } from './prompt.js';

/**
 * Enrich ONE workflow via the wrapper's structured-output seam. The client already
 * retries once on transient errors; ANY error that reaches here becomes a labelled STUB
 * (standing rule 5 — "couldn't analyze", never a fabricated answer). The caller (worker)
 * persists analyzed output or a stub; it never drops a workflow.
 */

const SCHEMA_NAME = 'workflow_enrichment';
const MAX_TOKENS = 1500;

/** Output-schema version — part of the enrichment gating tuple; bump forces re-enrich. */
export const ENRICHMENT_SCHEMA_VERSION = 1;

export type EnrichResult =
  | { status: 'analyzed'; output: EnrichmentOutput; usage: TokenUsage }
  | { status: 'stub'; output: null; usage: null; errorKind: LlmErrorKind; errorMessage: string };

export async function enrichWorkflow(client: LlmClient, input: EnrichmentInput, signal?: AbortSignal): Promise<EnrichResult> {
  const { system, user } = buildPrompt(input);
  try {
    const { value, usage } = await client.structuredOutput({
      system,
      user,
      schema: enrichmentOutputSchema,
      schemaName: SCHEMA_NAME,
      maxTokens: MAX_TOKENS,
      signal,
    });
    return { status: 'analyzed', output: value, usage };
  } catch (err) {
    const kind: LlmErrorKind = err instanceof LlmError ? err.kind : 'unknown';
    return { status: 'stub', output: null, usage: null, errorKind: kind, errorMessage: (err as Error).message };
  }
}
