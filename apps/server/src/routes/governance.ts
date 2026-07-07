import { Router } from 'express';
import type Database from 'better-sqlite3';
import { governanceOverviewResponseSchema } from '@argus/shared';
import { governanceOverview } from '../governance/summary.js';
import { overviewToMarkdown } from '../governance/export.js';

/**
 * The S6 governance-overview API — pure composition of existing S1b–S5 reads
 * (spec .agents/specs/governance-overview.md). `GET /overview` is the composed
 * dashboard payload (score + every drillable figure); `GET /export` is the
 * structured compliance report, generated from the SAME payload so it matches the
 * screen exactly. Read-only; mutates nothing.
 */
export function governanceRouter(db: Database.Database): Router {
  const router = Router();

  router.get('/overview', (_req, res) => {
    const payload = governanceOverview(db, new Date().toISOString());
    res.json(governanceOverviewResponseSchema.parse(payload));
  });

  router.get('/export', (_req, res) => {
    const payload = governanceOverview(db, new Date().toISOString());
    const markdown = overviewToMarkdown(governanceOverviewResponseSchema.parse(payload));
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="argus-governance-report.md"');
    res.send(markdown);
  });

  return router;
}
