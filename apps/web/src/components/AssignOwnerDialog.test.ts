import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { WorkflowOwner } from '@argus/shared';
import AssignOwnerDialog from './AssignOwnerDialog.vue';

/**
 * Rule-11 UI-presence for the assign-owner dialog's inferred-owner suggestion: the
 * advisory owner is offered as a one-click confirm (never auto-applied) that fills the
 * owner fields and selects the picker.
 */
const inferredOwner: WorkflowOwner = {
  status: 'inferred', owner: { email: 'nathan@n8n.io', name: 'Nathan Owner' }, backupOwner: null,
  reason: null, source: 'project-member', memberRole: 'project:admin', assignedBy: null, assignedAt: null,
};

function stub(users = [{ email: 'nathan@n8n.io', name: 'Nathan Owner', role: 'global:owner' }], available = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ users, available, reason: null }) })));
}
const val = (w: ReturnType<typeof mount>, id: string) => (w.find(`[data-testid="${id}"]`).element as HTMLInputElement).value;

describe('AssignOwnerDialog — inferred-owner suggestion (rule 11)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('suggests the inferred owner and confirming fills the owner fields', async () => {
    stub();
    const w = mount(AssignOwnerDialog, { props: { instanceId: 'a', current: inferredOwner } });
    await flushPromises();

    const sug = w.find('[data-testid="assign-owner-suggestion"]');
    expect(sug.exists()).toBe(true);
    expect(sug.text()).toContain('Nathan Owner');
    expect(sug.text()).toContain('project:admin');
    // Not auto-applied — the fields start empty.
    expect(val(w, 'assign-owner-name')).toBe('');

    await w.find('[data-testid="assign-owner-confirm-inferred"]').trigger('click');
    expect(val(w, 'assign-owner-name')).toBe('Nathan Owner');
    expect(val(w, 'assign-owner-email')).toBe('nathan@n8n.io');

    await w.find('[data-testid="assign-owner-save"]').trigger('click');
    expect(w.emitted('save')?.[0]?.[0]).toMatchObject({ ownerEmail: 'nathan@n8n.io', ownerName: 'Nathan Owner' });
    w.unmount();
  });

  it('shows no suggestion when there is nothing inferred', async () => {
    stub();
    const w = mount(AssignOwnerDialog, { props: { instanceId: 'a', current: null } });
    await flushPromises();
    expect(w.find('[data-testid="assign-owner-suggestion"]').exists()).toBe(false);
    w.unmount();
  });
});
