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

  function auditQuery(f: AuditFilterState): string {
    const p = new URLSearchParams();
    if (f.action) p.set('action', f.action);
    if (f.actor) p.set('actor', f.actor);
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  /** The CSV export URL for the current filters (a plain download link, no fetch). */
  function exportUrl(): string {
    return `/api/ownership/audit/export.csv${auditQuery(filters.value)}`;
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
      audit.value = await api(`/api/ownership/audit${auditQuery(filters.value)}`, {}, auditTimelineResponseSchema);
      auditState.value = 'ok';
      auditError.value = null;
    } catch (err) {
      auditState.value = 'error';
      auditError.value = err instanceof Error ? err.message : 'could not load the audit timeline';
    }
  }

  return {
    gaps, gapsState, gapsError,
    audit, auditState, auditError, filters,
    exportUrl, refreshGaps, refreshAudit,
  };
});
