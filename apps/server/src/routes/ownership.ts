import { Router } from 'express';
import type Database from 'better-sqlite3';
import {
  ownerAssignmentInputSchema,
  backupOwnerInputSchema,
  governanceGapsResponseSchema,
  assignableUsersResponseSchema,
  auditTimelineResponseSchema,
} from '@argus/shared';
import { assignOwner, setBackupOwner, removeOwner, resolveOwner, governanceGaps } from '../ownership/repo.js';
import { listAudit, countAudit, distinctAuditActions, auditToCsv, type AuditFilters } from '../audit/read.js';
import { getConnectionRow, decryptApiKey } from '../connections/repo.js';
import { createN8nClient, HttpError, reason as n8nReason } from '../n8n/client.js';
import { actorOf } from '../auth/middleware.js';

/** Honest reason when the n8n user list can't be read (missing scope / error) — never a fake roster. */
function usersReason(err: unknown): string {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
    return `the API key may lack \`user:list\` (HTTP ${err.status})`;
  }
  return n8nReason(err);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * The S4 ownership & accountability API. Explicit assignments are audited mutations
 * (assign/reassign/backup/remove — each through the sacred audit DAO); `GET /gaps` is
 * the governance-gaps payload; `GET /:instanceId/assignable-users` proxies the picker;
 * `GET /audit` is the filterable self-audit timeline (+ CSV export).
 */
export function ownershipRouter(db: Database.Database, encryptionKey: string): Router {
  const router = Router();

  // Governance gaps (single segment — declared before the param routes).
  router.get('/gaps', (_req, res) => {
    res.json(governanceGapsResponseSchema.parse({ ...governanceGaps(db), generatedAt: new Date().toISOString() }));
  });

  // The Argus self-audit timeline, filterable + CSV-exportable. The CSV exports the whole
  // filtered set (every page), so it strips pagination — an export must never silently
  // truncate to one page (rule 5).
  router.get('/audit/export.csv', (req, res) => {
    const filters = parseAuditFilters(req.query);
    const entries = listAudit(db, { ...filters, limit: undefined, offset: undefined });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="argus-audit-log.csv"');
    res.send(auditToCsv(entries));
  });

  router.get('/audit', (req, res) => {
    const filters = parseAuditFilters(req.query);
    // Default to a 50-row page for the timeline UI; the query can override.
    const limit = filters.limit ?? AUDIT_PAGE_SIZE;
    const offset = filters.offset ?? 0;
    const entries = listAudit(db, { ...filters, limit, offset });
    res.json(
      auditTimelineResponseSchema.parse({
        entries,
        actions: distinctAuditActions(db),
        total: countAudit(db, filters),
        limit,
        offset,
        generatedAt: new Date().toISOString(),
      }),
    );
  });

  // The assign-owner picker: that instance's known n8n users (honest empty if unreadable).
  router.get('/:instanceId/assignable-users', async (req, res) => {
    const row = getConnectionRow(db, req.params.instanceId ?? '');
    if (!row) {
      res.status(404).json({ error: 'connection not found' });
      return;
    }
    const client = createN8nClient({ baseUrl: row.base_url, apiKey: decryptApiKey(row, encryptionKey) });
    try {
      const users = await client.listUsers();
      const list = users.map((u) => ({
        email: u.email,
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
        role: u.role ?? null,
      }));
      res.json(assignableUsersResponseSchema.parse({ users: list, available: true, reason: null }));
    } catch (err) {
      res.json(assignableUsersResponseSchema.parse({ users: [], available: false, reason: usersReason(err) }));
    }
  });

  // Assign / reassign the primary owner (+ optional backup + reason) — audited.
  router.put('/:instanceId/:id/owner', (req, res) => {
    const parsed = ownerAssignmentInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    if (!getConnectionRow(db, req.params.instanceId ?? '')) {
      res.status(404).json({ error: 'connection not found' });
      return;
    }
    const owner = assignOwner(db, actorOf(res), req.params.instanceId ?? '', req.params.id ?? '', parsed.data);
    res.json(owner);
  });

  // Set / clear ONLY the backup owner — audited.
  router.put('/:instanceId/:id/backup', (req, res) => {
    const parsed = backupOwnerInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    if (!getConnectionRow(db, req.params.instanceId ?? '')) {
      res.status(404).json({ error: 'connection not found' });
      return;
    }
    const owner = setBackupOwner(db, actorOf(res), req.params.instanceId ?? '', req.params.id ?? '', parsed.data);
    res.json(owner);
  });

  // Remove the explicit assignment (falls back to inferred/unowned) — audited.
  router.delete('/:instanceId/:id/owner', (req, res) => {
    const reasonText = str((req.body as { reason?: unknown } | undefined)?.reason);
    const ok = removeOwner(db, actorOf(res), req.params.instanceId ?? '', req.params.id ?? '', reasonText ?? null);
    if (!ok) {
      res.status(404).json({ error: 'workflow has no assigned owner' });
      return;
    }
    res.json(resolveOwner(db, req.params.instanceId ?? '', req.params.id ?? ''));
  });

  return router;
}

/** Default timeline page size when the request doesn't specify a `limit`. */
const AUDIT_PAGE_SIZE = 50;

/** Parse a positive integer query param, or undefined if absent/invalid. */
function posInt(v: unknown): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function parseAuditFilters(query: Record<string, unknown>): AuditFilters {
  return {
    action: str(query.action),
    entityType: str(query.entity),
    actor: str(query.actor),
    from: str(query.from),
    to: str(query.to),
    limit: posInt(query.limit),
    offset: posInt(query.offset),
  };
}
