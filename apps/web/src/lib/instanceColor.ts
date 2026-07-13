import { ref } from 'vue';

// A per-instance accent, picked from the vendored token palette (never a hard-coded
// color — standing rule 10). Instances get DISTINCT palette colors in a stable order
// (so prod ≠ staging), wrapping only when there are more instances than palette slots.
// Same instance id → same color across every view (filter chips, drawer, graph).
const PALETTE = [
  '--color--orange-500',
  '--color--purple-500',
  '--color--blue-500',
  '--color--green-600',
  '--color--mint-500',
  '--color--pink-500',
];

// Reactive so every view's dots recolor the moment the estate's instances are known,
// regardless of which view loaded first (assignInstanceColors is seeded once at startup).
const assigned = ref<Record<string, string>>({});

/**
 * Assign each instance a DISTINCT palette color. Ids are de-duped and sorted first, so
 * the mapping is deterministic and independent of caller order — prod and staging always
 * land on different, stable colors (rather than colliding on a shared hash bucket).
 */
export function assignInstanceColors(ids: string[]): void {
  const next: Record<string, string> = {};
  [...new Set(ids)].sort().forEach((id, i) => {
    next[id] = `var(${PALETTE[i % PALETTE.length]})`;
  });
  assigned.value = next;
}

/** Stable per-id hash — the fallback before/without an explicit assignment. */
function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `var(${PALETTE[h % PALETTE.length]})`;
}

export function instanceColor(id: string): string {
  return assigned.value[id] ?? hashColor(id);
}
