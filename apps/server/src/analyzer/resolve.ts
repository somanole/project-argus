import type { DirectDep } from '@argus/shared';
import type { RawRef } from './refs.js';

/**
 * Broken-ref resolution (S1b) — THE TRUST CORE.
 *
 * Zero false broken-refs is the contract. A reference is `broken` in EXACTLY one
 * situation:
 *
 *   the value is a concrete literal id (resource-locator mode `id` or `list`, or a
 *   bare-string id — NOT an expression) that is absent from the instance's COMPLETE
 *   workflow-id set.
 *
 * Every other case degrades honestly and is NEVER called broken:
 *   - expression-valued / dynamic source        → dynamic
 *   - resource-locator by name / url / unknown   → unresolved
 *   - the id set is incomplete (partial sync)    → unresolved (can't prove absence)
 *
 * Note: n8n `executeWorkflow` (database source), `toolWorkflow`, `agentTool`, and
 * `errorWorkflow` can only target a workflow in the SAME instance — there is no
 * valid cross-instance interpretation — so an id absent from the complete set is
 * genuinely broken. (Cross-instance webhook edges are a different mechanism and out
 * of scope for S1b.)
 */

/** DirectDep.mode is a small enum; map the richer RawRef.mode onto it. */
function outMode(mode: RawRef['mode']): DirectDep['mode'] {
  if (mode === 'id' || mode === 'name' || mode === 'list' || mode === 'expression') return mode;
  return 'unknown'; // 'url' | 'unknown'
}

/**
 * Resolve one raw ref against the instance's id set.
 * @param complete true only when the instance's full workflow list was read without
 *   error — the precondition that makes "absent ⇒ broken" sound.
 * @param nameById id → workflow name, for filling in resolved dep display names.
 */
export function resolveRef(
  ref: RawRef,
  idSet: ReadonlySet<string>,
  complete: boolean,
  nameById: ReadonlyMap<string, string>,
): DirectDep {
  const base: DirectDep = {
    kind: ref.kind,
    nodeId: ref.nodeId,
    nodeName: ref.nodeName,
    mode: outMode(ref.mode),
    rawValue: ref.rawValue,
    cachedName: ref.cachedName,
    resolution: 'dynamic',
    resolvedId: null,
    resolvedName: null,
  };

  // Inherently unknowable statically → dynamic.
  if (ref.dynamicSource || ref.isExpression || ref.mode === 'expression' || ref.mode === 'url') {
    return { ...base, resolution: 'dynamic' };
  }
  // A name is not an id; matching by name could false-match (dupes/renames) — refuse.
  if (ref.mode === 'name' || ref.mode === 'unknown') {
    return { ...base, resolution: 'unresolved' };
  }
  // mode ∈ { id, list }: n8n stores a concrete workflow id in `value`.
  if (ref.mode === 'id' || ref.mode === 'list') {
    if (ref.rawValue == null || ref.rawValue === '') {
      return { ...base, resolution: 'dynamic' }; // nothing to resolve; not a claim of brokenness
    }
    if (idSet.has(ref.rawValue)) {
      return { ...base, resolution: 'resolved', resolvedId: ref.rawValue, resolvedName: nameById.get(ref.rawValue) ?? null };
    }
    // Absent — but only CERTAIN when we read the whole instance. Otherwise unresolved.
    return { ...base, resolution: complete ? 'broken' : 'unresolved' };
  }
  return base;
}

/** Resolve every raw ref for one workflow. */
export function resolveRefs(
  refs: RawRef[],
  idSet: ReadonlySet<string>,
  complete: boolean,
  nameById: ReadonlyMap<string, string>,
): DirectDep[] {
  return refs.map((r) => resolveRef(r, idSet, complete, nameById));
}
