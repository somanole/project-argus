import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  governanceGapsResponseSchema,
  auditTimelineResponseSchema,
  type GovernanceGapsResponse,
  type AuditTimelineResponse,
} from '@argus/shared';
import { api } from '../lib/api';

/** Audit-timeline filter state (all optional; empty = no filter). */
export interface AuditFilterState {
  action: string;
  actor: string;
  from: string;
  to: string;
}

/**
 * The Governance view's data (S4): the governance gaps (`GET /api/ownership/gaps`) and
 * the Argus self-audit timeline (`GET /api/ownership/audit`, filterable + CSV-exportable).
 * Honest states only (rule 5): errors surface a plain-English reason.
 */
export const useOwnershipStore = defineStore('ownership', () => {
  const gaps = ref<GovernanceGapsResponse | null>(null);
  const gapsState = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const gapsError = ref<string | null>(null);

  const audit = ref<AuditTimelineResponse | null>(null);
  const auditState = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const auditError = ref<string | null>(null);
  const filters = ref<AuditFilterState>({ action: '', actor: '', from: '', to: '' });

  /** Timeline pagination: page size + the current (0-based) page. */
  const AUDIT_PAGE_SIZE = 50;
  const auditPage = ref(0);

  /** Filter-only query string (no pagination) — shared by the CSV export link. */
  function filterQuery(f: AuditFilterState): URLSearchParams {
    const p = new URLSearchParams();
    if (f.action) p.set('action', f.action);
    if (f.actor) p.set('actor', f.actor);
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    return p;
  }

  /** The CSV export URL for the current filters (a plain download link, no fetch; all pages). */
  function exportUrl(): string {
    const q = filterQuery(filters.value).toString();
    return `/api/ownership/audit/export.csv${q ? `?${q}` : ''}`;
  }

  async function refreshGaps(): Promise<void> {
    if (gapsState.value === 'idle') gapsState.value = 'loading';
    try {
      gaps.value = await api('/api/ownership/gaps', {}, governanceGapsResponseSchema);
      gapsState.value = 'ok';
      gapsError.value = null;
    } catch (err) {
      gapsState.value = 'error';
      gapsError.value = err instanceof Error ? err.message : 'could not load governance gaps';
    }
  }

  async function refreshAudit(): Promise<void> {
    if (auditState.value === 'idle') auditState.value = 'loading';
    try {
      const p = filterQuery(filters.value);
      p.set('limit', String(AUDIT_PAGE_SIZE));
      p.set('offset', String(auditPage.value * AUDIT_PAGE_SIZE));
      audit.value = await api(`/api/ownership/audit?${p.toString()}`, {}, auditTimelineResponseSchema);
      auditState.value = 'ok';
      auditError.value = null;
    } catch (err) {
      auditState.value = 'error';
      auditError.value = err instanceof Error ? err.message : 'could not load the audit timeline';
    }
  }

  /** Apply the filters from page 1 — resets pagination so a new filter isn't stuck on a stale page. */
  async function applyAuditFilters(): Promise<void> {
    auditPage.value = 0;
    await refreshAudit();
  }

  /** Jump to a 0-based page (clamped to the available range) and reload. */
  async function goToAuditPage(page: number): Promise<void> {
    const total = audit.value?.total ?? 0;
    const lastPage = Math.max(Math.ceil(total / AUDIT_PAGE_SIZE) - 1, 0);
    const next = Math.min(Math.max(page, 0), lastPage);
    if (next === auditPage.value) return;
    auditPage.value = next;
    await refreshAudit();
  }

  return {
    gaps, gapsState, gapsError,
    audit, auditState, auditError, filters,
    auditPage, auditPageSize: AUDIT_PAGE_SIZE,
    exportUrl, refreshGaps, refreshAudit, applyAuditFilters, goToAuditPage,
  };
});
