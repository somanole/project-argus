import { Router } from 'express';
import type Database from 'better-sqlite3';
import { workflowsResponseSchema } from '@argus/shared';
import { listWorkflows } from '../workflows/repo.js';

/**
 * The estate-wide workflow inventory, served from the cache. `?instanceId=`
 * filters to one connection; the list is one estate either way.
 */
export function workflowsRouter(db: Database.Database): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const raw = req.query.instanceId;
    const instanceId = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    const workflows = listWorkflows(db, instanceId);
    res.json(workflowsResponseSchema.parse({ workflows, generatedAt: new Date().toISOString() }));
  });

  return router;
}
