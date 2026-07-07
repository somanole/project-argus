<script setup lang="ts">
import { computed } from 'vue';
import type { WorkflowOwner } from '@argus/shared';

/**
 * The resolved owner of a workflow (S4). Honest by construction (rule 5):
 *  - assigned → the explicit owner (authoritative).
 *  - inferred → an advisory owner from n8n project membership, VISIBLY labeled
 *    "inferred" and never presented as fact.
 *  - unowned → "Unowned" (carrying the honest "couldn't infer" reason as a tooltip
 *    when inference was attempted but nothing was resolvable).
 * null = ownership not resolved yet (freshly synced).
 */
const props = defineProps<{ owner: WorkflowOwner | null }>();

const displayName = (o: WorkflowOwner): string => o.owner?.name ?? o.owner?.email ?? '—';

const view = computed(() => {
  const o = props.owner;
  if (!o) return { cls: 'badge--muted', dot: 'dot--muted', label: 'owner…', status: 'pending', title: 'ownership not resolved yet' };
  switch (o.status) {
    case 'assigned':
      return { cls: 'badge--ok', dot: 'dot--ok', label: displayName(o), status: 'assigned',
        title: `Assigned owner${o.assignedBy?.name ? ` — by ${o.assignedBy.name}` : ''}` };
    case 'inferred':
      return { cls: 'badge--muted', dot: 'dot--muted', label: `${displayName(o)} · inferred`, status: 'inferred',
        title: o.memberRole ? `Inferred from n8n project membership (${o.memberRole}) — advisory` : 'Inferred from n8n project membership — advisory' };
    default:
      return { cls: 'badge--warn', dot: 'dot--warn', label: 'Unowned', status: 'unowned',
        title: o.reason ?? 'No owner assigned' };
  }
});
</script>

<template>
  <span class="badge" :class="view.cls" data-testid="owner-badge" :data-status="view.status" :title="view.title">
    <span class="dot" :class="view.dot" />
    {{ view.label }}
  </span>
</template>
