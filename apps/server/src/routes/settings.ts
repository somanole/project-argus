import { Router } from 'express';
import type Database from 'better-sqlite3';
import { llmConfigInputSchema, llmConfigResponseSchema, enrichmentToggleSchema, enrichmentProgressSchema } from '@argus/shared';
import { actorOf } from '../auth/middleware.js';
import { getLlmConfigRow, setLlmConfig, toSafeLlmConfig, getEnrichmentEnabled, setEnrichmentEnabled } from '../settings/repo.js';
import { listConnectionRows } from '../connections/repo.js';
import { probeCapabilities, EndpointUnreachableError, type CapabilityProbeResult } from '../llm/index.js';
import type { EnrichmentWorker } from '../enrichment/index.js';

/**
 * Settings API — the enrichment master switch + LLM provider config.
 *  - GET  /llm         → the SAFE view (never the key): provider, model, base URL,
 *                        probed capabilities, configured, enabled, envLocked.
 *  - PUT  /llm         → set the active provider + key (encrypted, audited); re-enriches.
 *                        For `openai_compatible`, capability-probes the endpoint first.
 *  - PUT  /enrichment  → flip the master switch (audited). On → configured re-enriches.
 */
export function settingsRouter(
  db: Database.Database,
  encryptionKey: string,
  envAllowed: boolean,
  worker: EnrichmentWorker,
): Router {
  const router = Router();
  const safe = () => toSafeLlmConfig(getLlmConfigRow(db), envAllowed, getEnrichmentEnabled(db));
  const kick = () => {
    for (const c of listConnectionRows(db)) worker.enqueue(c.id);
  };

  router.get('/llm', (_req, res) => {
    res.json(llmConfigResponseSchema.parse({ config: safe() }));
  });

  router.put('/llm', async (req, res) => {
    const parsed = llmConfigInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const input = parsed.data;

    // An OpenAI-compatible endpoint is user-supplied, so neither seam may be ASSUMED
    // (DECISION #30, Principle 7). Probe before we save, and separate the two outcomes:
    //   - unreachable / wrong model / rejected key → a config error the user must fix (400);
    //   - reachable but seam-limited → saved, with the limitation recorded and shown.
    let capabilities: CapabilityProbeResult | null = null;
    if (input.provider === 'openai_compatible') {
      try {
        capabilities = await probeCapabilities({
          provider: 'openai_compatible',
          baseUrl: input.baseUrl,
          model: input.model,
          apiKey: input.apiKey ?? '',
        });
      } catch (err) {
        // Express 4 does not catch async rejections — every path answers explicitly.
        const message =
          err instanceof EndpointUnreachableError ? err.message : `Could not probe the endpoint: ${(err as Error).message}`;
        res.status(400).json({ error: message });
        return;
      }
    }

    setLlmConfig(
      db,
      actorOf(res),
      {
        provider: input.provider,
        apiKey: input.provider === 'openai_compatible' ? (input.apiKey ?? '') : input.apiKey,
        baseUrl: input.provider === 'openai_compatible' ? input.baseUrl : undefined,
        model: input.provider === 'openai_compatible' ? input.model : undefined,
        capabilities,
      },
      encryptionKey,
    );
    kick(); // a provider (or endpoint) switch invalidates everything → full re-enrich
    res.json(llmConfigResponseSchema.parse({ config: safe() }));
  });

  router.put('/enrichment', (req, res) => {
    const parsed = enrichmentToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    if (parsed.data.enabled && !envAllowed) {
      res.status(409).json({ error: 'enrichment is disabled by ops config (ENRICHMENT_ENABLED=false)' });
      return;
    }
    setEnrichmentEnabled(db, actorOf(res), parsed.data.enabled);
    if (parsed.data.enabled) kick(); // turning on → fill in the catalog now
    res.json(llmConfigResponseSchema.parse({ config: safe() }));
  });

  // Manual "Enrich now" — run the pass across all connections immediately (respects the
  // hash gate, so it's cheap: it only (re-)enriches pending / changed / stale workflows).
  router.post('/enrichment/run', (_req, res) => {
    kick();
    res.status(202).json(enrichmentProgressSchema.parse(worker.progress()));
  });

  return router;
}
