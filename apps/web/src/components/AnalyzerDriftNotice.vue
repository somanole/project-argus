<script setup lang="ts">
import { computed } from 'vue';
import type { AnalyzerDrift } from '@argus/shared';

// Advisory analyzer-freshness drift (S6.1). A COVERAGE NUDGE, never a correctness
// alarm (rule 5): a stale manifest makes the analyzer incomplete, not wrong. Anchored
// on verifiable unrecognized node types — never on an n8n version Argus can't read.
// Renders nothing when there's nothing to act on (null / 'current').
defineOptions({ inheritAttrs: false });

const props = defineProps<{ drift: AnalyzerDrift | null }>();

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const variant = computed(() => props.drift && props.drift.status !== 'current' ? props.drift.status : null);

// The listed names ARE the actual unrecognized types; if the total exceeds what we list,
// say "+N more" — never present them as illustrative "examples".
const coreMore = computed(() => props.drift ? props.drift.coreUnknown.types - props.drift.coreExamples.length : 0);
const communityMore = computed(() => props.drift ? props.drift.communityUnknown.types - props.drift.communityExamples.length : 0);
</script>

<template>
  <div
    v-if="variant && drift"
    v-bind="$attrs"
    class="drift"
    :class="variant === 'core-drift' ? 'drift--warn' : 'drift--muted'"
    :data-drift-status="drift.status"
    role="status"
  >
    <!-- Core-drift: likely a newer n8n than the manifest → rebuild restores coverage. -->
    <template v-if="variant === 'core-drift'">
      <p class="drift-title">Coverage may have dropped</p>
      <p class="drift-body">
        {{ plural(drift.coreUnknown.types, 'core node type', 'core node types') }} on this instance
        {{ drift.coreUnknown.types === 1 ? "isn't" : "aren't" }} recognized by the analyzer, which is
        built for <strong>n8n {{ drift.manifestN8nVersion }}</strong>. If you've upgraded n8n,
        rebuild the analyzer for your version to restore coverage.
      </p>
      <p class="drift-meta">
        Affects {{ plural(drift.coreUnknown.workflows, 'workflow', 'workflows') }}.
        <span v-if="drift.communityUnknown.types > 0">
          ({{ plural(drift.communityUnknown.types, 'community/custom type', 'community/custom types') }}
          a rebuild won't add.)
        </span>
      </p>
      <p v-if="drift.coreExamples.length" class="drift-examples">
        <span class="drift-examples-label">Unrecognized core types:</span>
        <span class="mono">{{ drift.coreExamples.join(', ') }}</span>
        <span v-if="coreMore > 0"> +{{ coreMore }} more</span>
      </p>
      <details class="drift-how">
        <summary>How to rebuild the analyzer</summary>
        <ol>
          <li>Point the build at your upgraded n8n source and bump the pinned version.</li>
          <li>Run <code class="mono">pnpm gen:manifest</code> to regenerate the node manifest.</li>
          <li>Redeploy Argus with the new image.</li>
        </ol>
        <p class="drift-note muted">See <code class="mono">docs/ANALYZER-REBUILD.md</code> for the full runbook.</p>
      </details>
    </template>

    <!-- Community-only: third-party nodes the source manifest can never know — no rebuild CTA. -->
    <template v-else>
      <p class="drift-body">
        {{ plural(drift.communityUnknown.types, 'community/custom node type', 'community/custom node types') }}
        can't be analyzed. These aren't part of n8n itself, so rebuilding the analyzer won't add them.
      </p>
      <p v-if="drift.communityExamples.length" class="drift-examples">
        <span class="drift-examples-label">Unrecognized:</span>
        <span class="mono">{{ drift.communityExamples.join(', ') }}</span>
        <span v-if="communityMore > 0"> +{{ communityMore }} more</span>
      </p>
    </template>
  </div>
</template>

<style scoped>
.drift {
  display: flex;
  flex-direction: column;
  gap: var(--spacing--5xs);
  margin-top: var(--spacing--4xs);
  padding: var(--spacing--2xs) var(--spacing--xs);
  border-radius: var(--radius);
  border: var(--border-width-base) solid var(--border-color);
  font-size: var(--font-size--2xs);
}
.drift--warn {
  background: var(--background--warning, var(--color--warning-tint-2));
  border-color: var(--color--warning, var(--border-color));
}
.drift--muted {
  background: var(--background--subtle);
}
.drift-title {
  margin: 0;
  font-weight: var(--font-weight--bold);
  color: var(--text-color--warning, var(--color--text--shade-1));
}
.drift-body { margin: 0; color: var(--color--text--shade-1); }
.drift-body strong { font-weight: var(--font-weight--medium); }
.drift-meta { margin: 0; color: var(--color--text--shade-1); opacity: 0.85; }
.drift-examples {
  margin: 0;
  font-size: var(--font-size--3xs);
  color: var(--color--text--shade-1);
  opacity: 0.8;
}
.drift-examples-label { font-weight: var(--font-weight--medium); margin-right: var(--spacing--5xs); }
.drift-examples .mono { word-break: break-all; }
.drift-how { margin-top: var(--spacing--5xs); }
.drift-how summary {
  cursor: pointer;
  font-size: var(--font-size--3xs);
  color: var(--color--text--shade-1);
  opacity: 0.85;
}
.drift-how ol { margin: var(--spacing--4xs) 0 0; padding-left: var(--spacing--md); }
.drift-how li { margin: 0 0 var(--spacing--5xs); color: var(--color--text--shade-1); }
.drift-note { margin: var(--spacing--4xs) 0 0; font-size: var(--font-size--3xs); }
code.mono, .mono { font-family: var(--font-family--monospace); }
</style>
