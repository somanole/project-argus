<script setup lang="ts">
// One metric tile on the governance overview — a number that leads to its exact set.
// A SINGLE component (used by every tile in both groups) so the format is guaranteed
// identical: label + ⓘ + a top-right nav arrow, the big number, the FULL context
// (never truncated), and a destination link pinned to the bottom so it sits at the same
// position in every tile regardless of how much the context wraps. The whole tile is a
// stretched link; the ⓘ sits above it (z-index) so it stays hoverable without navigating.
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import InfoTip from './InfoTip.vue';

export type TileTone = 'ok' | 'warn' | 'danger' | 'muted';

/** The data behind one overview tile (built in OverviewView from the composed payload). */
export interface OverviewTileData {
  key: string;
  testid: string;
  label: string;
  count: number;
  tone: TileTone; // the colour when the count is a problem; a clean zero always reads muted
  context: string; // the "X of Y" line — shown IN FULL, never cut
  info: string; // the longer "why" / caveat — lives in the ⓘ tooltip
  to: RouteLocationRaw;
  dest: string; // short destination label ("Ownership", "Health", "Estate")
}

const props = defineProps<{ tile: OverviewTileData }>();
const tone = computed<TileTone>(() => (props.tile.count > 0 ? props.tile.tone : 'muted'));
</script>

<template>
  <div class="tile" :data-testid="tile.testid">
    <router-link class="tile-link" :to="tile.to" :aria-label="`${tile.label}: ${tile.count} — open ${tile.dest}`" />
    <div class="tile-top">
      <span class="tile-label">{{ tile.label }}</span>
      <InfoTip :text="tile.info" />
      <svg class="tile-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>
    </div>
    <div class="tile-num" :class="`t-${tone}`">{{ tile.count }}</div>
    <p class="tile-ctx muted">{{ tile.context }}</p>
    <div class="tile-foot">
      <span class="tile-dest">{{ tile.dest }} <span aria-hidden="true">›</span></span>
    </div>
  </div>
</template>

<style scoped>
.tile {
  position: relative; display: flex; flex-direction: column; gap: var(--spacing--4xs);
  min-height: 8.5rem; padding: var(--spacing--sm) var(--spacing--md);
  border: 1px solid var(--border-color--subtle); border-radius: var(--radius--lg);
  background: var(--background--surface);
  transition: border-color var(--duration--snappy, 0.12s) ease;
}
.tile:hover { border-color: var(--border-color--strong, var(--border-color)); }
/* Stretched link — the whole tile navigates; the ⓘ sits above it so it stays hoverable. */
.tile-link { position: absolute; inset: 0; z-index: 1; border-radius: inherit; }

/* Reserve two label lines so the number sits at the same height whether the label wraps
   to one line or two — that's what keeps the numbers (and everything below) aligned. */
.tile-top { display: flex; align-items: flex-start; gap: var(--spacing--4xs); min-height: 2.5em; }
.tile-top .infotip { position: relative; z-index: 2; }
.tile-label { flex: 1; min-width: 0; font-size: var(--font-size--sm); font-weight: var(--font-weight--medium); color: var(--color--text--shade-1); line-height: 1.25; }
.tile-go { flex: none; width: 0.85rem; height: 0.85rem; margin-top: 2px; opacity: 0.4; color: var(--color--text--shade-1); }
.tile:hover .tile-go { opacity: 0.75; color: var(--background--brand); }

.tile-num { font-size: var(--font-size--2xl, 1.75rem); font-weight: var(--font-weight--bold); line-height: 1.1; font-variant-numeric: tabular-nums; }

/* The context shows IN FULL — it wraps, it never truncates. */
.tile-ctx { margin: 0; font-size: var(--font-size--2xs); line-height: 1.4; }

/* Pinned to the bottom so the destination link is at the SAME position in every tile. */
.tile-foot { margin-top: auto; padding-top: var(--spacing--4xs); display: flex; align-items: center; }
.tile-dest { font-size: var(--font-size--2xs); font-weight: var(--font-weight--medium); color: var(--color--text--shade-1); opacity: 0.65; white-space: nowrap; }
.tile:hover .tile-dest { color: var(--background--brand); opacity: 1; }

.t-ok { color: var(--color--success); }
.t-warn { color: var(--color--warning); }
.t-danger { color: var(--color--danger); }
.t-muted { color: var(--color--text--shade-1); opacity: 0.55; }
</style>
