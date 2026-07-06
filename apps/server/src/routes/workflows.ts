import { Router } from 'express';
import type Database from 'better-sqlite3';
import {
  workflowsResponseSchema,
  workflowDetailSchema,
  coverageResponseSchema,
  enrichmentProgressSchema,
  enrichmentCorrectionSchema,
} from '@argus/shared';
import {
  listWorkflows,
  getWorkflowDetail,
  facets,
  listCoverageEntries,
  type WorkflowFilters,
} from '../workflows/repo.js';
import { coverageOf, manifest } from '../analyzer/index.js';
import { actorOf } from '../auth/middleware.js';
import { correctLabel } from '../enrichment/repo.js';
import type { EnrichmentWorker } from '../enrichment/index.js';

function deepLinkFor(baseUrl: string, id: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base ? `${base}/workflow/${id}` : '';
}

/**
 * The S1b catalog API. `GET /` serves the estate-wide inventory with catalog facts,
 * filtered server-side (instance / active / archived / mcp / system / trigger / q);
 * `GET /:instanceId/:id` is the detail drawer (facts + deep-link); `GET /coverage`
 * is the trust number. `instanceId` is a filter, the list is always one estate.
 */
export function workflowsRouter(db: Database.Database, worker: EnrichmentWorker): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const filters = parseFilters(req.query);
    const workflows = listWorkflows(db, filters);

    // Facets are computed over the WHOLE estate (unfiltered) so chips stay stable.
    const raw = facets(db);
    const facetPayload = {
      systems: raw.systems,
      triggers: raw.triggers.map((t) => ({ value: t.value, label: manifest.nodeDisplay(t.value) ?? t.value, count: t.count })),
      instances: raw.instances,
    };

    res.json(
      workflowsResponseSchema.parse({ workflows, facets: facetPayload, generatedAt: new Date().toISOString() }),
    );
  });

  // Coverage must be declared before the two-segment detail route (single segment,
  // so no collision, but keep it explicit).
  router.get('/coverage', (_req, res) => {
    const report = coverageOf(listCoverageEntries(db));
    res.json(coverageResponseSchema.parse(report));
  });

  // Estate-wide enrichment progress for the "enriched X/Y" indicator.
  router.get('/enrichment-progress', (_req, res) => {
    res.json(enrichmentProgressSchema.parse(worker.progress()));
  });

  // One-click label correction — an audited mutation (DECISION #6).
  router.put('/:instanceId/:id/enrichment/correction', (req, res) => {
    const parsed = enrichmentCorrectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const ok = correctLabel(db, actorOf(res), req.params.instanceId ?? '', req.params.id ?? '', parsed.data);
    if (!ok) {
      res.status(404).json({ error: 'workflow not enriched' });
      return;
    }
    const detail = getWorkflowDetail(db, req.params.instanceId ?? '', req.params.id ?? '');
    if (!detail) {
      res.status(404).json({ error: 'workflow not found' });
      return;
    }
    res.json(workflowDetailSchema.parse({ workflow: detail.item, facts: detail.facts, deepLink: deepLinkFor(detail.baseUrl, detail.item.id) }));
  });

  router.get('/:instanceId/:id', (req, res) => {
    const detail = getWorkflowDetail(db, req.params.instanceId, req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'workflow not found' });
      return;
    }
    res.json(workflowDetailSchema.parse({ workflow: detail.item, facts: detail.facts, deepLink: deepLinkFor(detail.baseUrl, detail.item.id) }));
  });

  return router;
}

/** '?flag=true|false' → boolean | undefined (absent/other → no filter). */
function parseBool(v: unknown): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** Repeatable param → string[] ( ?system=A&system=B  or  ?system=A ). */
function parseList(v: unknown): string[] | undefined {
  const arr = Array.isArray(v) ? v : v != null ? [v] : [];
  const out = arr.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length ? out : undefined;
}

function parseFilters(query: Record<string, unknown>): WorkflowFilters {
  const instanceId = typeof query.instanceId === 'string' && query.instanceId.length > 0 ? query.instanceId : undefined;
  const q = typeof query.q === 'string' && query.q.length > 0 ? query.q : undefined;
  return {
    instanceId,
    active: parseBool(query.active),
    archived: parseBool(query.archived),
    mcp: parseBool(query.mcp) === true ? true : undefined,
    broken: parseBool(query.broken) === true ? true : undefined,
    systems: parseList(query.system),
    triggers: parseList(query.trigger),
    criticality: parseList(query.criticality),
    q,
  };
}
