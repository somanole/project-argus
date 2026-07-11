import { Router } from 'express';
import type Database from 'better-sqlite3';
import {
  workflowsResponseSchema,
  workflowDetailSchema,
  coverageResponseSchema,
  enrichmentProgressSchema,
  enrichmentCorrectionSchema,
  healthEstateResponseSchema,
  workflowExecutionsResponseSchema,
} from '@argus/shared';
import {
  listWorkflows,
  countWorkflows,
  getWorkflowDetail,
  facets,
  listCoverageEntries,
  type WorkflowFilters,
} from '../workflows/repo.js';
import { healthEstate, fetchWorkflowExecutions } from '../health/index.js';
import { getConnectionRow, decryptApiKey } from '../connections/repo.js';
import { createN8nClient, HttpError, reason as n8nReason } from '../n8n/client.js';
import { coverageOf, manifest } from '../analyzer/index.js';
import { actorOf } from '../auth/middleware.js';
import { correctLabel } from '../enrichment/repo.js';
import type { EnrichmentWorker } from '../enrichment/index.js';

/** Honest reason for the drawer when executions can't be read (missing scope / error). */
function executionsReason(err: unknown): string {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
    return `executions unavailable — the API key may lack \`execution:list\` (HTTP ${err.status})`;
  }
  return `executions unavailable — ${n8nReason(err)}`;
}

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
export function workflowsRouter(db: Database.Database, worker: EnrichmentWorker, encryptionKey: string): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const filters = parseFilters(req.query);
    // Server-side pagination: an estate can have thousands, so serve one page (default 50).
    const limit = filters.limit ?? WORKFLOWS_PAGE_SIZE;
    const offset = filters.offset ?? 0;
    const workflows = listWorkflows(db, { ...filters, limit, offset });
    const total = countWorkflows(db, filters);

    // Facets are computed over the WHOLE estate (unfiltered) so chips stay stable.
    const raw = facets(db);
    const facetPayload = {
      systems: raw.systems,
      triggers: raw.triggers.map((t) => ({ value: t.value, label: manifest.nodeDisplay(t.value) ?? t.value, count: t.count })),
      instances: raw.instances,
    };

    res.json(
      workflowsResponseSchema.parse({ workflows, facets: facetPayload, total, limit, offset, generatedAt: new Date().toISOString() }),
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

  // S3: the "what's failing right now" feed — failing then degraded workflows (each
  // carrying its S2 criticality), a summary count, and the per-instance retention
  // window. Declared before the two-segment detail route (single segment, no collision).
  router.get('/failing', (_req, res) => {
    const estate = healthEstate(db);
    res.json(healthEstateResponseSchema.parse({ ...estate, generatedAt: new Date().toISOString() }));
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

  // S3 on-demand execution debug for one workflow — recent runs (metadata + per-run
  // n8n deep link) + a REDACTED failure summary (failing node + error type/code only).
  // Fetched live from n8n only when a user opens the drawer; never persisted. Degrades
  // honestly to `unavailable` if executions can't be read (rule 5).
  router.get('/:instanceId/:id/executions', async (req, res) => {
    const { instanceId, id } = req.params;
    const row = getConnectionRow(db, instanceId ?? '');
    if (!row) {
      res.status(404).json({ error: 'connection not found' });
      return;
    }
    const client = createN8nClient({ baseUrl: row.base_url, apiKey: decryptApiKey(row, encryptionKey) });
    const result = await fetchWorkflowExecutions(client, {
      baseUrl: row.base_url, workflowId: id ?? '', limit: 10, reasonForError: executionsReason,
    });
    res.json(workflowExecutionsResponseSchema.parse({ ...result, generatedAt: new Date().toISOString() }));
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

/** Default catalog page size when the request doesn't specify a `limit`. */
const WORKFLOWS_PAGE_SIZE = 50;

/** '?flag=true|false' → boolean | undefined (absent/other → no filter). */
function parseBool(v: unknown): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** Parse a non-negative integer query param, or undefined if absent/invalid. */
function parseNonNegInt(v: unknown): number | undefined {
  const s = typeof v === 'string' ? v : undefined;
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
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
    stale: parseBool(query.stale) === true ? true : undefined,
    systems: parseList(query.system),
    triggers: parseList(query.trigger),
    criticality: parseList(query.criticality),
    health: parseList(query.health),
    q,
    limit: parseNonNegInt(query.limit),
    offset: parseNonNegInt(query.offset),
  };
}
