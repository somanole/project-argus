<script setup lang="ts">
import type { ChatToolChip } from '../stores/chat';

/**
 * One tool-call chip (spec .agents/specs/chat.md) — shows WHAT the assistant queried
 * (tool name + key argument) and its result, so every figure in the answer is
 * auditable at a glance. Grounded: the chip reflects a real tool call the server ran.
 */
defineProps<{ chip: ChatToolChip }>();

const PRETTY: Record<string, string> = {
  search_catalog: 'catalog',
  get_workflow_detail: 'workflow',
  impact_analysis: 'blast radius',
  system_map: 'system map',
  ownership_query: 'ownership',
  governance_gaps: 'gaps',
  mcp_exposure: 'MCP exposure',
  fleet_stats: 'fleet stats',
  audit_log: 'audit',
  changelog: 'changelog',
};
</script>

<template>
  <span
    class="tool-chip"
    data-testid="chat-tool-chip"
    :class="{ 'is-pending': chip.ok === null, 'is-fail': chip.ok === false }"
    :title="chip.arg"
  >
    <span class="dot" :class="chip.ok === null ? 'dot--muted' : chip.ok ? 'dot--ok' : 'dot--danger'" />
    <span class="mono name">{{ PRETTY[chip.name] ?? chip.name }}</span>
    <span v-if="chip.arg" class="arg">{{ chip.arg }}</span>
    <span v-if="chip.summary" class="summary">→ {{ chip.summary }}</span>
  </span>
</template>

<style scoped>
.tool-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing--3xs);
  max-width: 100%;
  padding: var(--spacing--5xs) var(--spacing--2xs);
  border: 1px solid var(--border-color--subtle);
  border-radius: var(--radius--full);
  background: var(--background--subtle);
  font-size: var(--font-size--3xs);
  color: var(--color--text--shade-1);
  overflow: hidden;
}
.name { font-weight: var(--font-weight--medium); }
.arg,
.summary {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.arg { opacity: 0.8; }
.summary { color: var(--color--text--shade-2); }
.is-fail { border-color: var(--border-color); }
</style>
