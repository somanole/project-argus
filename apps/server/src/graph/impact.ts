import type { ImpactMode, ImpactResult, ImpactedWorkflow } from '@argus/shared';
import { FAILURE_IMPACT_EDGE_TYPES } from '@argus/shared';
import type { StoredEdge, GraphWorkflowMeta } from './repo.js';

/**
 * Edge-type-aware blast-radius BFS (S5) — the H3 core.
 *
 * THE TRUST SPINE: only `confirmed` edges are ever traversed for a factual count.
 * `possible` edges are filtered out here (and their touching-count is reported as
 * `possibleExcluded`, so the honesty is visible). Each mode traverses a DIFFERENT
 * edge set:
 *   - failure            → reverse over confirmed call-like edges (X's transitive callers).
 *   - deprecate          → same as failure (who calls this sub-workflow).
 *   - credential_rotation→ direct workflows binding the credential (binds_credential).
 */

const wfKey = (instanceId: string, id: string) => `${instanceId}::${id}`;
const nodeKey = (kind: string, instanceId: string, id: string) => `${kind}::${instanceId}::${id}`;

export interface ImpactFocus {
  mode: ImpactMode;
  /** For failure/deprecate: a workflow. For credential_rotation: a credential id. */
  kind: 'workflow' | 'credential';
  instanceId: string;
  id: string;
}

/** Human label for the focus, from the workflow map or the edge that names the credential. */
function focusLabel(focus: ImpactFocus, wfByKey: Map<string, GraphWorkflowMeta>, edges: StoredEdge[]): string {
  if (focus.kind === 'workflow') return wfByKey.get(wfKey(focus.instanceId, focus.id))?.name ?? focus.id;
  // credential: pick the label off any binding edge.
  const e = edges.find((x) => x.dst.kind === 'credential' && x.dst.instanceId === focus.instanceId && x.dst.id === focus.id);
  return e?.dst.label ?? focus.id;
}

export function computeImpact(
  edges: StoredEdge[],
  workflows: GraphWorkflowMeta[],
  focus: ImpactFocus,
  generatedAt: string,
): ImpactResult {
  const wfByKey = new Map(workflows.map((w) => [wfKey(w.instanceId, w.id), w]));

  // Reverse adjacency over CONFIRMED, failure-relevant edge types: target → its sources.
  const impactTypes = new Set<string>(FAILURE_IMPACT_EDGE_TYPES);
  const callers = new Map<string, StoredEdge[]>(); // key(dst) → edges pointing at it
  let possibleTouchingFocus = 0;

  for (const e of edges) {
    if (e.confidence !== 'confirmed') continue;
    if (!impactTypes.has(e.type)) continue;
    const k = nodeKey(e.dst.kind, e.dst.instanceId, e.dst.id);
    const arr = callers.get(k) ?? [];
    arr.push(e);
    callers.set(k, arr);
  }

  const affected: ImpactedWorkflow[] = [];
  const seen = new Set<string>();

  if (focus.mode === 'credential_rotation' || focus.kind === 'credential') {
    // Direct binders of the credential. binds_credential is confirmed; the rotation
    // breaks exactly the workflows that use the credential.
    for (const e of edges) {
      if (e.type !== 'binds_credential') continue;
      if (e.dst.instanceId !== focus.instanceId || e.dst.id !== focus.id) continue;
      const w = wfByKey.get(wfKey(e.src.instanceId, e.src.id));
      const key = wfKey(e.src.instanceId, e.src.id);
      if (w && !seen.has(key)) {
        seen.add(key);
        affected.push({ instanceId: w.instanceId, instanceLabel: w.instanceLabel, workflowId: w.id, name: w.name, hops: 1 });
      }
    }
  } else {
    // failure / deprecate: transitive reverse-BFS over confirmed call-like edges.
    // possibleExcluded = possible edges that point AT the focus (transparency).
    possibleTouchingFocus = edges.filter(
      (e) => e.confidence === 'possible' && e.dst.kind === 'workflow' && e.dst.instanceId === focus.instanceId && e.dst.id === focus.id,
    ).length;

    let frontier: Array<{ instanceId: string; id: string }> = [{ instanceId: focus.instanceId, id: focus.id }];
    let hops = 0;
    while (frontier.length > 0) {
      hops += 1;
      const next: Array<{ instanceId: string; id: string }> = [];
      for (const node of frontier) {
        const incoming = callers.get(nodeKey('workflow', node.instanceId, node.id)) ?? [];
        for (const e of incoming) {
          const key = wfKey(e.src.instanceId, e.src.id);
          if (seen.has(key)) continue;
          seen.add(key);
          const w = wfByKey.get(key);
          affected.push({
            instanceId: e.src.instanceId,
            instanceLabel: w?.instanceLabel ?? e.src.instanceId,
            workflowId: e.src.id,
            name: w?.name ?? e.src.label,
            hops,
          });
          next.push({ instanceId: e.src.instanceId, id: e.src.id });
        }
      }
      frontier = next;
    }
  }

  const total = affected.length;
  const label = focusLabel(focus, wfByKey, edges);
  const statement =
    total === 0
      ? `Nothing depends on ${label} — 0 affected.`
      : `${total} affected, nothing else.`;

  return {
    mode: focus.mode,
    focusKind: focus.kind,
    focusInstanceId: focus.instanceId,
    focusId: focus.id,
    focusLabel: label,
    edgeTypesTraversed:
      focus.mode === 'credential_rotation' || focus.kind === 'credential' ? ['binds_credential'] : FAILURE_IMPACT_EDGE_TYPES,
    affected,
    total,
    possibleExcluded: possibleTouchingFocus,
    statement,
    generatedAt,
  };
}
