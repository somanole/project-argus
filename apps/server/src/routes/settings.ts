import { Router } from 'express';
import type Database from 'better-sqlite3';
import { llmConfigInputSchema, llmConfigResponseSchema, enrichmentToggleSchema, enrichmentProgressSchema } from '@argus/shared';
import { actorOf } from '../auth/middleware.js';
import { getLlmConfigRow, setLlmConfig, toSafeLlmConfig, getEnrichmentEnabled, setEnrichmentEnabled } from '../settings/repo.js';
import { listConnectionRows } from '../connections/repo.js';
import type { EnrichmentWorker } from '../enrichment/index.js';

/**
 * Settings API — the enrichment master switch + LLM provider config.
 *  - GET  /llm         → the SAFE view (never the key): provider, model, configured,
 *                        enabled (master switch), envLocked (ops override).
 *  - PUT  /llm         → set the active provider + key (encrypted, audited); re-enriches.
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

  router.put('/llm', (req, res) => {
    const parsed = llmConfigInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    setLlmConfig(db, actorOf(res), parsed.data.provider, parsed.data.apiKey, encryptionKey);
    kick(); // a provider switch invalidates everything → full re-enrich
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
