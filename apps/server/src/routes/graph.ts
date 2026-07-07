import { Router } from 'express';
import type Database from 'better-sqlite3';
import {
  dependencyGraphSchema,
  impactResultSchema,
  mcpReachSchema,
  graphScopeSchema,
  impactModeSchema,
} from '@argus/shared';
import { readAllEdges, readGraphWorkflows } from '../graph/repo.js';
import { buildGraphView } from '../graph/query.js';
import { computeImpact, type ImpactFocus } from '../graph/impact.js';
import { computeMcpReach } from '../graph/mcp.js';

/**
 * The S5 graph API. Deterministic reads over the precomputed `workflow_edges` cache:
 *   GET /            — a scoped graph view (neighborhood / instance / system / estate)
 *   GET /impact      — edge-type-aware blast radius (confirmed-only totals)
 *   GET /mcp-reach   — what an MCP-exposed workflow can touch (forward reach)
 *
 * Everything is estate-wide; `instanceId` is a filter, never a partition.
 */
export function graphRouter(db: Database.Database): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const scopeParsed = graphScopeSchema.safeParse(req.query.scope ?? 'estate');
    if (!scopeParsed.success) {
      res.status(400).json({ error: 'invalid scope (neighborhood|instance|system|estate)' });
      return;
    }
    const focus = typeof req.query.focus === 'string' ? req.query.focus : null;
    const hopsRaw = typeof req.query.hops === 'string' ? Number(req.query.hops) : null;
    const hops = hopsRaw != null && Number.isFinite(hopsRaw) ? Math.max(1, Math.min(5, Math.trunc(hopsRaw))) : null;

    const workflows = readGraphWorkflows(db);
    const edges = readAllEdges(db);
    const view = buildGraphView(workflows, edges, { scope: scopeParsed.data, focus, hops }, new Date().toISOString());
    res.json(dependencyGraphSchema.parse(view));
  });

  router.get('/impact', (req, res) => {
    const modeParsed = impactModeSchema.safeParse(req.query.mode ?? 'failure');
    if (!modeParsed.success) {
      res.status(400).json({ error: 'invalid mode (failure|deprecate|credential_rotation)' });
      return;
    }
    const instanceId = typeof req.query.instanceId === 'string' ? req.query.instanceId : '';
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (!instanceId || !id) {
      res.status(400).json({ error: 'instanceId and id are required' });
      return;
    }
    const mode = modeParsed.data;
    const focus: ImpactFocus = {
      mode,
      kind: mode === 'credential_rotation' ? 'credential' : 'workflow',
      instanceId,
      id,
    };
    const workflows = readGraphWorkflows(db);
    const edges = readAllEdges(db);
    const result = computeImpact(edges, workflows, focus, new Date().toISOString());
    res.json(impactResultSchema.parse(result));
  });

  router.get('/mcp-reach', (req, res) => {
    const instanceId = typeof req.query.instanceId === 'string' ? req.query.instanceId : '';
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (!instanceId || !id) {
      res.status(400).json({ error: 'instanceId and id are required' });
      return;
    }
    const workflows = readGraphWorkflows(db);
    const edges = readAllEdges(db);
    const reach = computeMcpReach(edges, workflows, { instanceId, workflowId: id }, new Date().toISOString());
    res.json(mcpReachSchema.parse(reach));
  });

  return router;
}
