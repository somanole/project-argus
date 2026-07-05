import type Database from 'better-sqlite3';
import type { ConnectionHealth, N8nWorkflowListItem, N8nProject } from '@argus/shared';
import { listConnectionRows, getConnectionRow, decryptApiKey, type ConnectionRow } from '../connections/repo.js';
import { replaceInstanceWorkflows, countByInstance, type CacheWorkflow } from '../workflows/repo.js';
import { createN8nClient, statusForError, reason } from '../n8n/client.js';

/**
 * The freshness engine. Every `pollIntervalMs` it re-lists each connection's
 * workflows and reconciles the cache (a full re-list IS the reconciliation —
 * see replaceInstanceWorkflows). This delivers within-a-minute updates for
 * edit/archive/delete and self-heals after downtime, with no event delivery
 * required (PLAN.md: reconciliation is the source of truth).
 */

/** The subset of the n8n client the engine needs — injectable for tests. */
export interface N8nReader {
  listWorkflows(): Promise<N8nWorkflowListItem[]>;
  listProjects(): Promise<N8nProject[]>;
}
export type N8nReaderFactory = (opts: { baseUrl: string; apiKey: string }) => N8nReader;

const defaultFactory: N8nReaderFactory = (opts) => createN8nClient(opts);

export interface SyncEngine {
  start(): void;
  stop(): void;
  /** Sync one connection now (used right after it is registered). */
  syncNow(id: string): Promise<void>;
  /** Current health for one connection (pending if never synced). */
  health(id: string): ConnectionHealth;
}

export function createSyncEngine(
  db: Database.Database,
  encryptionKey: string,
  pollIntervalMs: number,
  factory: N8nReaderFactory = defaultFactory,
): SyncEngine {
  const health = new Map<string, ConnectionHealth>();
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function currentHealth(id: string): ConnectionHealth {
    const existing = health.get(id);
    if (existing) return existing;
    return { status: 'pending', lastSyncedAt: null, lastError: null, workflowCount: countByInstance(db, id) };
  }

  function normalize(workflows: N8nWorkflowListItem[], projects: N8nProject[]): CacheWorkflow[] {
    const nameById = new Map(projects.map((p) => [p.id, p.name]));
    return workflows.map((w) => {
      const ownerProjectId = w.shared.find((s) => s.role === 'workflow:owner')?.projectId ?? null;
      return {
        id: w.id,
        name: w.name,
        active: w.active,
        isArchived: w.isArchived,
        projectId: ownerProjectId,
        // null (not a guess) when the project can't be resolved (standing rule 5).
        projectName: ownerProjectId ? nameById.get(ownerProjectId) ?? null : null,
        updatedAt: w.updatedAt,
        versionId: w.versionId,
      };
    });
  }

  async function syncRow(row: ConnectionRow): Promise<void> {
    if (inFlight.has(row.id)) return;
    inFlight.add(row.id);
    try {
      const client = factory({ baseUrl: row.base_url, apiKey: decryptApiKey(row, encryptionKey) });
      const [projects, workflows] = await Promise.all([client.listProjects(), client.listWorkflows()]);
      const normalized = normalize(workflows, projects);
      replaceInstanceWorkflows(db, row.id, normalized, new Date().toISOString());
      health.set(row.id, {
        status: 'ok',
        lastSyncedAt: new Date().toISOString(),
        lastError: null,
        workflowCount: normalized.length,
      });
    } catch (err) {
      // Keep the last-known cache; report the connection as unhealthy, honestly.
      const prev = health.get(row.id);
      health.set(row.id, {
        status: statusForError(err),
        lastSyncedAt: prev?.lastSyncedAt ?? null,
        lastError: reason(err),
        workflowCount: countByInstance(db, row.id),
      });
      console.warn(`[argus] sync failed for "${row.label}" (${row.base_url}): ${reason(err)}`);
    } finally {
      inFlight.delete(row.id);
    }
  }

  async function tick(): Promise<void> {
    const rows = listConnectionRows(db);
    // Prune health for connections that no longer exist.
    const live = new Set(rows.map((r) => r.id));
    for (const id of [...health.keys()]) if (!live.has(id)) health.delete(id);
    await Promise.all(rows.map((r) => syncRow(r)));
  }

  return {
    start(): void {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), pollIntervalMs);
      // Don't keep the process alive solely for the poll timer.
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async syncNow(id: string): Promise<void> {
      const row = getConnectionRow(db, id);
      if (row) await syncRow(row);
    },
    health: currentHealth,
  };
}
