import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ownershipRegisterResponseSchema, type OwnershipRegisterResponse } from '@argus/shared';
import { api } from '../lib/api';

/**
 * The ownership register — the Ownership Estate view's data. One paginated, filterable,
 * server-composed table (`GET /api/ownership/register`): every workflow with its resolved
 * owner + the accountability risks that apply. A single `view` selects the working set
 * (needs-owner is the default — the actionable gap); instance + search narrow further.
 * Honest states only (rule 5): a failed load surfaces a plain-English reason.
 */
export type RegisterView =
  | 'needs-owner'
  | 'confirmed'
  | 'inferred'
  | 'unowned'
  | 'critical-at-risk'
  | 'no-backup'
  | 'spof'
  | 'personal-space'
  | 'all';

/** Map a view to the server query params (state / risk / criticalAtRisk). */
function viewParams(v: RegisterView): Record<string, string> {
  switch (v) {
    case 'confirmed': return { state: 'confirmed' };
    case 'inferred': return { state: 'inferred' };
    case 'unowned': return { state: 'unowned' };
    case 'all': return { state: 'all' };
    case 'critical-at-risk': return { criticalAtRisk: 'true' };
    case 'no-backup': return { risk: 'no-backup' };
    case 'spof': return { risk: 'spof' };
    case 'personal-space': return { risk: 'personal-space' };
    default: return { state: 'needs-owner' };
  }
}

export const useOwnershipRegisterStore = defineStore('ownership-register', () => {
  const data = ref<OwnershipRegisterResponse | null>(null);
  const state = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const error = ref<string | null>(null);

  const PAGE_SIZE = 50;
  const page = ref(0);
  const view = ref<RegisterView>('needs-owner');
  const instanceId = ref<string>('all');
  const q = ref<string>('');

  const rows = computed(() => data.value?.rows ?? []);
  const summary = computed(() => data.value?.summary ?? null);
  const total = computed(() => data.value?.total ?? 0);

  function buildQuery(): string {
    const p = new URLSearchParams(viewParams(view.value));
    if (instanceId.value !== 'all') p.set('instanceId', instanceId.value);
    if (q.value.trim()) p.set('q', q.value.trim());
    p.set('limit', String(PAGE_SIZE));
    p.set('offset', String(page.value * PAGE_SIZE));
    return `?${p.toString()}`;
  }

  async function refresh(): Promise<void> {
    if (state.value === 'idle') state.value = 'loading';
    try {
      data.value = await api(`/api/ownership/register${buildQuery()}`, {}, ownershipRegisterResponseSchema);
      state.value = 'ok';
      error.value = null;
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : 'could not load the ownership register';
    }
  }

  /** Switch the working set — always from page 1. */
  function setView(v: RegisterView): void {
    if (view.value === v && page.value === 0) return;
    view.value = v;
    page.value = 0;
    void refresh();
  }
  function setInstance(id: string): void {
    instanceId.value = id;
    page.value = 0;
    void refresh();
  }
  function setQuery(v: string): void {
    q.value = v;
    page.value = 0;
    void refresh();
  }
  function goToPage(next: number): void {
    const lastPage = Math.max(Math.ceil(total.value / PAGE_SIZE) - 1, 0);
    const clamped = Math.min(Math.max(next, 0), lastPage);
    if (clamped === page.value) return;
    page.value = clamped;
    void refresh();
  }

  const VIEWS: readonly RegisterView[] = ['needs-owner', 'confirmed', 'inferred', 'unowned', 'critical-at-risk', 'no-backup', 'spof', 'personal-space', 'all'];
  /** Apply a deep-link (e.g. Overview tiles → ?view=needs-owner). Does NOT refresh; caller does. */
  function applyFromQuery(query: Record<string, unknown>): void {
    const str = (val: unknown): string | undefined => (typeof val === 'string' && val ? val : undefined);
    const v = str(query.view);
    view.value = (VIEWS as readonly string[]).includes(v ?? '') ? (v as RegisterView) : 'needs-owner';
    instanceId.value = str(query.instanceId) ?? 'all';
    q.value = str(query.q) ?? '';
    page.value = 0;
  }

  return {
    data, state, error, rows, summary, total,
    page, pageSize: PAGE_SIZE, view, instanceId, q,
    refresh, setView, setInstance, setQuery, goToPage, applyFromQuery,
  };
});
