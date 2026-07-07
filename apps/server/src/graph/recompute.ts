import type Database from 'better-sqlite3';
import { buildEdges } from './build.js';
import { readBuildWorkflows, readGraphInstances, replaceAllEdges } from './repo.js';

/**
 * The estate-wide edge pass (S5). Runs AFTER the per-connection sync loop, because
 * cross-instance edges need every connection's facts + public webhook host in hand.
 * Reads the whole cache from the DB, rebuilds every edge, and atomically replaces the
 * edge table. Idempotent, never throws — a failure here must never break inventory
 * sync (rule 5); the graph simply keeps its last-known edges.
 */
export function recomputeEstateEdges(db: Database.Database): number {
  try {
    const workflows = readBuildWorkflows(db);
    const instances = readGraphInstances(db);
    const edges = buildEdges(workflows, instances);
    replaceAllEdges(db, edges, new Date().toISOString());
    return edges.length;
  } catch (err) {
    console.warn(`[argus] estate edge recompute failed (keeping last-known graph): ${(err as Error).message}`);
    return -1;
  }
}
