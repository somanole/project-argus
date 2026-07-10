import type Database from 'better-sqlite3';
import type { EnrichmentProgress } from '@argus/shared';
import { createLlmClient, SpendMeter, type LlmClient, type LlmClientConfig } from '../llm/index.js';
import { getLlmConfigRow, getDecryptedApiKey, getEnrichmentEnabled, type LlmConfigRow } from '../settings/repo.js';
import { enrichWorkflow, ENRICHMENT_SCHEMA_VERSION } from './enrich.js';
import { PROMPT_VERSION } from './prompt.js';
import type { EnrichmentInput } from './allowlist.js';
import { listEnrichmentCandidates, upsertEnrichment, pruneOrphans, enrichmentCounts, lastEnrichedAt, type GatingTuple } from './repo.js';

/**
 * The enrichment worker — a background pass triggered AFTER each successful sync (never
 * inside syncRow, so the freshness loop is never blocked by LLM latency; the catalog is
 * usable immediately while summaries fill in). It reads the persisted, redacted
 * allowlist for each workflow, enriches only the MISSES (gating tuple), respects a
 * per-run token budget, and prioritizes active + recently-updated workflows first.
 * Kill-switch aware: if disabled or no provider is configured, it does nothing and
 * Argus stays fully deterministic.
 */
export interface EnrichmentWorkerDeps {
  db: Database.Database;
  encryptionKey: string;
  /** The ENRICHMENT_ENABLED ops override. The in-app master switch is read from the DB. */
  envAllowed: boolean;
  concurrency: number;
  spendCapTokens: number;
  /** Injectable for tests; defaults to the real provider-abstracting client. */
  clientFactory?: (cfg: LlmClientConfig) => LlmClient;
}

export interface EnrichmentRunResult {
  skipped?: 'disabled' | 'unconfigured' | 'in-flight';
  analyzed: number;
  stub: number;
  pending: number;
  tokens: number;
}

export interface EnrichmentWorker {
  /** Fire-and-forget trigger (from the sync onSynced hook). */
  enqueue(instanceId: string): void;
  /** Awaitable single-instance run (used by tests and manual triggers). */
  runInstance(instanceId: string): Promise<EnrichmentRunResult>;
  /** Estate-wide progress for the "enriched X/Y" indicator. */
  progress(): EnrichmentProgress;
  isEnabled(): boolean;
}

export function createEnrichmentWorker(deps: EnrichmentWorkerDeps): EnrichmentWorker {
  const { db, encryptionKey, envAllowed, concurrency, spendCapTokens } = deps;
  const clientFactory = deps.clientFactory ?? ((cfg) => createLlmClient({ ...cfg, reasoningEffort: 'minimal', retryDelayMs: 1000 }));
  const inFlight = new Set<string>();

  // Effective on-state: the ops env override AND the persisted in-app master switch.
  const effectiveEnabled = (): boolean => envAllowed && getEnrichmentEnabled(db);

  /**
   * The freshness-gating tuple. `baseUrl` is part of it because two endpoints can serve
   * the same model id — repointing at a different one must re-enrich, not silently keep
   * summaries a different model wrote (DECISION #30).
   */
  function tupleOf(cfg: LlmConfigRow): GatingTuple {
    return {
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.base_url,
      promptVersion: PROMPT_VERSION,
      schemaVersion: ENRICHMENT_SCHEMA_VERSION,
    };
  }

  function activeTuple(): GatingTuple | null {
    const cfg = getLlmConfigRow(db);
    return cfg ? tupleOf(cfg) : null;
  }

  async function runInstance(instanceId: string): Promise<EnrichmentRunResult> {
    const base: EnrichmentRunResult = { analyzed: 0, stub: 0, pending: 0, tokens: 0 };
    if (!effectiveEnabled()) return { ...base, skipped: 'disabled' };
    const cfg = getLlmConfigRow(db);
    // `''` is a legal key for a keyless self-hosted endpoint — only `null` is unconfigured.
    const apiKey = cfg ? getDecryptedApiKey(db, encryptionKey) : null;
    if (!cfg || apiKey === null) return { ...base, skipped: 'unconfigured' };
    if (inFlight.has(instanceId)) return { ...base, skipped: 'in-flight' };

    inFlight.add(instanceId);
    try {
      pruneOrphans(db, instanceId);
      const tuple: GatingTuple = tupleOf(cfg);
      const candidates = listEnrichmentCandidates(db, instanceId, tuple);
      if (candidates.length === 0) return base;

      const client = clientFactory({ provider: cfg.provider, apiKey, model: cfg.model, baseUrl: cfg.base_url ?? undefined });
      const meter = new SpendMeter(cfg.model);
      const result = { ...base };

      let next = 0;
      const runner = async (): Promise<void> => {
        for (;;) {
          if (meter.capReached(spendCapTokens)) break; // leave the rest PENDING (honest, not stub)
          const i = next++;
          const c = candidates[i];
          if (!c) break;
          const input = JSON.parse(c.inputJson) as EnrichmentInput;
          const outcome = await enrichWorkflow(client, input);
          if (outcome.status === 'analyzed') {
            meter.add(outcome.usage);
            result.analyzed++;
            upsertEnrichment(db, { ...tuple, instanceId, workflowId: c.workflowId, inputHash: c.inputHash, status: 'analyzed', enrichmentJson: JSON.stringify(outcome.output) });
          } else {
            result.stub++;
            upsertEnrichment(db, { ...tuple, instanceId, workflowId: c.workflowId, inputHash: c.inputHash, status: 'stub', enrichmentJson: '{}' });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => runner()));

      result.pending = candidates.length - result.analyzed - result.stub;
      result.tokens = meter.totalTokens();
      if (result.pending > 0) {
        console.warn(`[argus] enrichment spend cap hit for instance ${instanceId}: ${result.pending} workflows left pending`);
      }
      return result;
    } finally {
      inFlight.delete(instanceId);
    }
  }

  function progress(): EnrichmentProgress {
    const last = lastEnrichedAt(db);
    const tuple = activeTuple();
    if (!effectiveEnabled() || !tuple) {
      // Count enrichable workflows so the UI can say "0/Y" honestly when off.
      const total = (db.prepare('SELECT COUNT(*) AS n FROM workflows WHERE enrichment_input_json IS NOT NULL').get() as { n: number }).n;
      return { enabled: false, lastEnrichedAt: last, total, analyzed: 0, stub: 0, stale: 0, pending: total };
    }
    return { enabled: true, lastEnrichedAt: last, ...enrichmentCounts(db, tuple) };
  }

  return {
    enqueue(instanceId: string): void {
      void runInstance(instanceId).catch((err) => {
        console.warn(`[argus] enrichment run failed for ${instanceId}: ${(err as Error).message}`);
      });
    },
    runInstance,
    progress,
    isEnabled: effectiveEnabled,
  };
}
