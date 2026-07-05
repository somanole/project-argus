// Topological sort for the workflow registry: a workflow that calls another is
// created AFTER its callee, so the callee's real n8n id can be injected into the
// caller's executeWorkflow node. Cycles fail loudly (rule 5 — never guess).

/**
 * @param entries array of { key, dependsOn?: string[] }
 * @returns the same entries, callee-first
 */
export function topoSort(entries) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const state = new Map(); // key -> 'visiting' | 'done'
  const ordered = [];

  function visit(key, trail) {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') {
      throw new Error(`Workflow dependency cycle: ${[...trail, key].join(' → ')}`);
    }
    const entry = byKey.get(key);
    if (!entry) throw new Error(`Unknown dependency "${key}" (referenced by ${trail[trail.length - 1] ?? '?'})`);
    state.set(key, 'visiting');
    for (const dep of entry.dependsOn ?? []) visit(dep, [...trail, key]);
    state.set(key, 'done');
    ordered.push(entry);
  }

  for (const e of entries) visit(e.key, []);
  return ordered;
}
