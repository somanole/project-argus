import { describe, expect, it } from 'vitest';
import { workflowMatchesQuery } from './workflows.js';
import type { WorkflowOwner } from './ownership.js';

const owner = (name: string | null, email: string | null, status: WorkflowOwner['status'] = 'assigned'): WorkflowOwner => ({
  status,
  owner: name != null || email != null ? { name, email } : null,
  backupOwner: null,
  reason: null,
  source: status === 'assigned' ? 'assigned' : status === 'inferred' ? 'project-member' : null,
  memberRole: null,
  assignedBy: null,
  assignedAt: status === 'assigned' ? '2026-07-06T00:00:00.000Z' : null,
});

describe('workflowMatchesQuery — search by name or owner', () => {
  const wf = (name: string, o: WorkflowOwner | null = null) => ({ name, owner: o });

  it('a blank query matches everything', () => {
    expect(workflowMatchesQuery(wf('Anything'), '')).toBe(true);
    expect(workflowMatchesQuery(wf('Anything'), '   ')).toBe(true);
  });

  it('matches on the workflow name (case-insensitive, substring)', () => {
    expect(workflowMatchesQuery(wf('Stripe Billing Sync'), 'billing')).toBe(true);
    expect(workflowMatchesQuery(wf('Stripe Billing Sync'), 'ZZZ')).toBe(false);
  });

  it('matches on an ASSIGNED owner — by name and by email', () => {
    const w = wf('Reconcile Ledger', owner('Sam Rivers', 'sam@corp.io', 'assigned'));
    expect(workflowMatchesQuery(w, 'sam')).toBe(true);
    expect(workflowMatchesQuery(w, 'rivers')).toBe(true);
    expect(workflowMatchesQuery(w, 'sam@corp')).toBe(true);
    expect(workflowMatchesQuery(w, 'nobody')).toBe(false);
  });

  it('matches on an INFERRED (advisory) owner too', () => {
    const w = wf('Nightly ETL', owner('Priya Member', 'priya@n8n.io', 'inferred'));
    expect(workflowMatchesQuery(w, 'priya')).toBe(true);
    expect(workflowMatchesQuery(w, 'priya@n8n')).toBe(true);
  });

  it('an unowned workflow only matches on its name', () => {
    const w = wf('Orphan Flow', owner(null, null, 'unowned'));
    expect(workflowMatchesQuery(w, 'orphan')).toBe(true);
    expect(workflowMatchesQuery(w, 'sam')).toBe(false);
  });

  it('a null owner is safe', () => {
    expect(workflowMatchesQuery(wf('No owner field', null), 'owner field')).toBe(true);
    expect(workflowMatchesQuery(wf('No owner field', null), 'sam')).toBe(false);
  });
});
