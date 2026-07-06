/** The enrichment (sense-making) module — allowlist → prompt → LLM → labelled result. */
export { buildEnrichmentInput, type EnrichmentInput, type FailureStats, type BuildContext } from './allowlist.js';
export { hashEnrichmentInput } from './input-hash.js';
export { buildPrompt, PROMPT_VERSION } from './prompt.js';
export { enrichWorkflow, ENRICHMENT_SCHEMA_VERSION, type EnrichResult } from './enrich.js';
export { createEnrichmentWorker, type EnrichmentWorker, type EnrichmentRunResult } from './worker.js';
