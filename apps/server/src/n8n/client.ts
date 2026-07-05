import {
  n8nWorkflowListItemSchema,
  n8nProjectSchema,
  type N8nWorkflowListItem,
  type N8nProject,
} from '@argus/shared';
import type { ConnectionStatus } from '@argus/shared';

/**
 * Read-only client for one n8n instance's public API. Auth is the
 * `X-N8N-API-KEY` header (contracts/n8n-02-*). Argus never writes to n8n — the
 * only endpoints here are cursor-paginated GET lists (contracts/n8n-15-*,
 * n8n-03-*). Shapes are validated against the captured contracts; an item that
 * fails validation is skipped, not fabricated (standing rule 5).
 */
export interface N8nClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout in ms (default 10s) so a dead instance can't hang a sync. */
  timeoutMs?: number;
}

export interface TestResult {
  status: ConnectionStatus;
  error: string | null;
}

const PAGE_LIMIT = 250;

export function createN8nClient(opts: N8nClientOptions) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function get(path: string): Promise<{ status: number; json: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/api/v1${path}`, {
        headers: { 'X-N8N-API-KEY': opts.apiKey, accept: 'application/json' },
        signal: ctrl.signal,
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Walk every page of a cursor-paginated list, validating items one by one. */
  async function paginate<T>(pathBase: string, parseItem: (v: unknown) => T | null): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const q = cursor
        ? `?limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
        : `?limit=${PAGE_LIMIT}`;
      const { status, json } = await get(`${pathBase}${q}`);
      if (status !== 200) throw new HttpError(status);
      const body = json as { data?: unknown[]; nextCursor?: unknown } | undefined;
      for (const raw of body?.data ?? []) {
        const parsed = parseItem(raw);
        if (parsed !== null) out.push(parsed);
      }
      cursor = typeof body?.nextCursor === 'string' ? body.nextCursor : undefined;
    } while (cursor);
    return out;
  }

  return {
    async listWorkflows(): Promise<N8nWorkflowListItem[]> {
      return paginate('/workflows', (raw) => {
        const r = n8nWorkflowListItemSchema.safeParse(raw);
        return r.success ? r.data : null;
      });
    },

    async listProjects(): Promise<N8nProject[]> {
      return paginate('/projects', (raw) => {
        const r = n8nProjectSchema.safeParse(raw);
        return r.success ? r.data : null;
      });
    },

    /** Classify reachability for the connection-health indicator. */
    async testConnection(): Promise<TestResult> {
      try {
        const { status } = await get('/workflows?limit=1');
        if (status === 200) return { status: 'ok', error: null };
        if (status === 401 || status === 403) return { status: 'unauthorized', error: `n8n rejected the API key (HTTP ${status})` };
        return { status: 'unreachable', error: `unexpected response from n8n (HTTP ${status})` };
      } catch (err) {
        return { status: 'unreachable', error: reason(err) };
      }
    },
  };
}

export class HttpError extends Error {
  constructor(public readonly status: number) {
    super(`n8n responded ${status}`);
  }
}

export function reason(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) return `n8n rejected the API key (HTTP ${err.status})`;
    return `n8n responded ${err.status}`;
  }
  if (err instanceof Error && err.name === 'AbortError') return 'n8n did not respond in time';
  if (err instanceof Error) return err.message;
  return 'could not reach n8n';
}

export function statusForError(err: unknown): ConnectionStatus {
  return err instanceof HttpError && (err.status === 401 || err.status === 403) ? 'unauthorized' : 'unreachable';
}
