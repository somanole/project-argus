<script setup lang="ts">
// The drawer's ownership section (S4): who is accountable for this workflow, and the
// audited controls to assign / reassign / remove. Shows the resolved owner (assigned
// over inferred over unowned), backup owner, reason, and provenance. Every mutation is
// an audited PUT/DELETE; the section reflects the server's resolved owner back.
import { ref, watch, computed } from 'vue';
import { workflowOwnerSchema, type WorkflowOwner } from '@argus/shared';
import { api } from '../lib/api';
import { relativeTime } from '../lib/time';
import OwnerBadge from './OwnerBadge.vue';
import AssignOwnerDialog from './AssignOwnerDialog.vue';

const props = defineProps<{ instanceId: string; workflowId: string; owner: WorkflowOwner | null }>();
const emit = defineEmits<{ updated: [WorkflowOwner] }>();

const owner = ref<WorkflowOwner | null>(props.owner);
watch(() => props.owner, (o) => { owner.value = o; });

const dialogOpen = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

const isAssigned = computed(() => owner.value?.status === 'assigned');
const path = computed(() => `/api/ownership/${encodeURIComponent(props.instanceId)}/${encodeURIComponent(props.workflowId)}`);

async function assign(input: Record<string, string | undefined>): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const next = await api(`${path.value}/owner`, { method: 'PUT', body: input }, workflowOwnerSchema);
    owner.value = next;
    emit('updated', next);
    dialogOpen.value = false;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'could not save the owner';
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const next = await api(`${path.value}/owner`, { method: 'DELETE', body: {} }, workflowOwnerSchema);
    owner.value = next;
    emit('updated', next);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'could not remove the owner';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="d-sec" data-testid="ownership-section">
    <div class="sec-head">
      <h3>Ownership</h3>
      <div class="sec-actions">
        <button class="btn btn--ghost btn--sm" data-testid="ownership-assign-button" :disabled="busy" @click="dialogOpen = true">
          {{ isAssigned ? 'Reassign' : 'Assign owner' }}
        </button>
        <button v-if="isAssigned" class="btn btn--ghost btn--sm" data-testid="ownership-remove-button" :disabled="busy" @click="remove">
          Remove
        </button>
      </div>
    </div>

    <div class="own-body">
      <OwnerBadge :owner="owner" />

      <!-- Backup owner. -->
      <p v-if="owner?.backupOwner" class="line">
        <span class="k">Backup</span>
        <span>{{ owner.backupOwner.name ?? owner.backupOwner.email }}</span>
      </p>

      <!-- Assigned provenance: who + when + reason. -->
      <template v-if="owner?.status === 'assigned'">
        <p v-if="owner.reason" class="line" data-testid="ownership-reason"><span class="k">Reason</span><span>{{ owner.reason }}</span></p>
        <p v-if="owner.assignedBy" class="prov muted">
          Assigned by {{ owner.assignedBy.name ?? owner.assignedBy.email }}<template v-if="owner.assignedAt"> · {{ relativeTime(owner.assignedAt, Date.now()) }}</template>
        </p>
      </template>

      <!-- Inferred is advisory — say so, and say why it might be wrong. -->
      <p v-else-if="owner?.status === 'inferred'" class="prov muted" data-testid="ownership-inferred-note">
        Inferred from n8n project membership<template v-if="owner.memberRole"> ({{ owner.memberRole }})</template> — advisory. Assign to make it authoritative.
      </p>

      <!-- Unowned: show the honest "couldn't infer" reason when there is one. -->
      <p v-else-if="owner && owner.reason" class="prov muted">{{ owner.reason }}</p>
    </div>

    <p v-if="error" class="err" role="alert">{{ error }}</p>

    <AssignOwnerDialog
      v-if="dialogOpen"
      :instance-id="instanceId"
      :current="owner"
      @cancel="dialogOpen = false"
      @save="assign"
    />
  </section>
</template>

<style scoped>
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm); }
.sec-actions { display: flex; gap: var(--spacing--4xs); }
.d-sec h3 {
  margin: 0 0 var(--spacing--2xs);
  font-size: var(--font-size--3xs); text-transform: uppercase; letter-spacing: var(--letter-spacing--wide);
  font-weight: var(--font-weight--bold); color: var(--color--text--shade-1); opacity: 0.6;
}
.own-body { display: flex; flex-direction: column; gap: var(--spacing--4xs); align-items: flex-start; }
.line { margin: 0; font-size: var(--font-size--2xs); display: flex; gap: var(--spacing--2xs); }
.line .k { color: var(--color--text--shade-1); opacity: 0.6; min-width: 3.5rem; }
.prov { margin: 0; font-size: var(--font-size--3xs); line-height: var(--line-height--md); }
.err { color: var(--text-color--danger, var(--color--danger)); font-size: var(--font-size--2xs); margin: var(--spacing--2xs) 0 0; }
</style>
