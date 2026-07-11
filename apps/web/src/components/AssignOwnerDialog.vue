<script setup lang="ts">
// Assign / reassign a workflow's owner. The owner (and optional backup) can be picked
// from the instance's known n8n users OR typed free-text (someone without an n8n
// account — a manager, an on-call rota). Emits the assignment; the parent performs the
// audited PUT. Honest (rule 5): if the user list can't be read, the picker says so and
// free-text still works.
import { ref, computed, onMounted } from 'vue';
import { assignableUsersResponseSchema, type WorkflowOwner, type AssignableUser } from '@argus/shared';
import { api } from '../lib/api';

const props = defineProps<{ instanceId: string; current: WorkflowOwner | null }>();
const emit = defineEmits<{
  save: [{ ownerEmail?: string | undefined; ownerName?: string | undefined; backupOwnerEmail?: string | undefined; backupOwnerName?: string | undefined; reason?: string | undefined }];
  cancel: [];
}>();

// Prefill from the current owner (so "Reassign" starts from what's there).
const cur = props.current;
const ownerName = ref(cur?.status === 'assigned' ? cur.owner?.name ?? '' : '');
const ownerEmail = ref(cur?.status === 'assigned' ? cur.owner?.email ?? '' : '');
const backupName = ref(cur?.backupOwner?.name ?? '');
const backupEmail = ref(cur?.backupOwner?.email ?? '');
const reason = ref('');
const ownerPick = ref('');

const users = ref<AssignableUser[]>([]);
const pickerAvailable = ref(true);
const pickerReason = ref<string | null>(null);
const error = ref<string | null>(null);

// The advisory inferred owner (from n8n project membership), offered as a one-click
// suggestion so the operator confirms rather than re-types it.
const inferred = computed(() => (props.current?.status === 'inferred' && props.current.owner ? props.current : null));
const inferredLabel = computed(() => inferred.value?.owner?.name ?? inferred.value?.owner?.email ?? '');

function confirmInferred(): void {
  const o = inferred.value?.owner;
  if (!o) return;
  ownerName.value = o.name ?? '';
  ownerEmail.value = o.email ?? '';
  // Reflect the selection in the picker when the inferred person is a known user.
  ownerPick.value = o.email && users.value.some((u) => u.email === o.email) ? o.email : '';
}

onMounted(async () => {
  try {
    const res = await api(`/api/ownership/${encodeURIComponent(props.instanceId)}/assignable-users`, {}, assignableUsersResponseSchema);
    users.value = res.users;
    pickerAvailable.value = res.available;
    pickerReason.value = res.reason;
  } catch {
    pickerAvailable.value = false;
    pickerReason.value = 'could not load the user list';
  }
});

function pickOwner(email: string): void {
  const u = users.value.find((x) => x.email === email);
  if (u) { ownerEmail.value = u.email; ownerName.value = u.name; }
}
function pickBackup(email: string): void {
  const u = users.value.find((x) => x.email === email);
  if (u) { backupEmail.value = u.email; backupName.value = u.name; }
}

function save(): void {
  if (!ownerName.value.trim() && !ownerEmail.value.trim()) {
    error.value = 'an owner needs a name or email';
    return;
  }
  emit('save', {
    ownerEmail: ownerEmail.value.trim() || undefined,
    ownerName: ownerName.value.trim() || undefined,
    backupOwnerEmail: backupEmail.value.trim() || undefined,
    backupOwnerName: backupName.value.trim() || undefined,
    reason: reason.value.trim() || undefined,
  });
}
</script>

<template>
  <div class="scrim" tabindex="-1" @click.self="emit('cancel')" @keydown.esc="emit('cancel')">
    <div class="dialog card" role="dialog" aria-label="Assign owner" data-testid="assign-owner-dialog">
      <h3>Assign owner</h3>

      <!-- Advisory inferred owner offered as a one-click confirm (never auto-applied). -->
      <div v-if="inferred" class="suggestion" data-testid="assign-owner-suggestion">
        <span class="s-text">
          Inferred owner: <strong>{{ inferredLabel }}</strong>
          <span v-if="inferred.memberRole" class="muted"> · {{ inferred.memberRole }}</span>
        </span>
        <button class="btn btn--secondary btn--sm" type="button" data-testid="assign-owner-confirm-inferred" @click="confirmInferred">Confirm owner</button>
      </div>

      <div class="field">
        <label for="own-pick">Pick a known user</label>
        <select id="own-pick" v-model="ownerPick" class="input" data-testid="assign-owner-picker" :disabled="!pickerAvailable" @change="pickOwner(ownerPick)">
          <option value="">{{ pickerAvailable ? 'Choose a person…' : 'user list unavailable — type below' }}</option>
          <option v-for="u in users" :key="u.email" :value="u.email">{{ u.name }} ({{ u.email }})</option>
        </select>
        <p v-if="!pickerAvailable" class="hint">{{ pickerReason ?? 'the API key may lack user:list' }} — you can still type an owner below.</p>
      </div>

      <div class="two">
        <div class="field">
          <label for="own-name">Owner name</label>
          <input id="own-name" v-model="ownerName" class="input" data-testid="assign-owner-name" placeholder="e.g. Sam Rivers">
        </div>
        <div class="field">
          <label for="own-email">Owner email</label>
          <input id="own-email" v-model="ownerEmail" class="input" type="email" data-testid="assign-owner-email" placeholder="sam@corp.io">
        </div>
      </div>

      <details class="backup">
        <summary>Backup owner (optional)</summary>
        <div class="field">
          <label for="bk-pick">Pick a known user</label>
          <select id="bk-pick" class="input" :disabled="!pickerAvailable" @change="pickBackup(($event.target as HTMLSelectElement).value)">
            <option value="">Choose a person…</option>
            <option v-for="u in users" :key="u.email" :value="u.email">{{ u.name }} ({{ u.email }})</option>
          </select>
        </div>
        <div class="two">
          <div class="field">
            <label for="bk-name">Backup name</label>
            <input id="bk-name" v-model="backupName" class="input" placeholder="e.g. Dana Lee">
          </div>
          <div class="field">
            <label for="bk-email">Backup email</label>
            <input id="bk-email" v-model="backupEmail" class="input" type="email" placeholder="dana@corp.io">
          </div>
        </div>
      </details>

      <div class="field">
        <label for="own-reason">Reason (optional)</label>
        <input id="own-reason" v-model="reason" class="input" data-testid="assign-owner-reason" placeholder="why this person owns it">
      </div>

      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <div class="actions">
        <button class="btn btn--ghost btn--sm" @click="emit('cancel')">Cancel</button>
        <button class="btn btn--primary btn--sm" data-testid="assign-owner-save" @click="save">Assign owner</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed; inset: 0;
  background: color-mix(in srgb, var(--color--text--shade-1) 40%, transparent);
  display: flex; align-items: center; justify-content: center;
  z-index: 60; padding: var(--spacing--md);
}
.dialog { width: min(28rem, 100%); max-height: 90vh; overflow-y: auto; display: flex; flex-direction: column; gap: var(--spacing--sm); }
.dialog h3 { margin: 0; font-size: var(--font-size--md); font-weight: var(--font-weight--bold); }
.field { display: flex; flex-direction: column; gap: var(--spacing--4xs); }
.field label { font-size: var(--font-size--2xs); color: var(--color--text--shade-1); opacity: 0.7; }
.suggestion {
  display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--sm); flex-wrap: wrap;
  padding: var(--spacing--2xs) var(--spacing--sm);
  border: 1px solid var(--border-color); border-radius: var(--radius--md);
  background: var(--background--subtle);
}
.s-text { font-size: var(--font-size--2xs); }
.suggestion .btn { flex: none; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--spacing--2xs); }
.backup summary { font-size: var(--font-size--2xs); cursor: pointer; color: var(--color--text--shade-1); opacity: 0.8; padding: var(--spacing--4xs) 0; }
.backup { display: flex; flex-direction: column; gap: var(--spacing--2xs); }
.hint { margin: 0; font-size: var(--font-size--3xs); color: var(--color--warning); }
.actions { display: flex; justify-content: flex-end; gap: var(--spacing--2xs); margin-top: var(--spacing--2xs); }
.err { color: var(--color--danger); font-size: var(--font-size--2xs); margin: 0; }
@media (max-width: 480px) { .two { grid-template-columns: 1fr; } }
</style>
