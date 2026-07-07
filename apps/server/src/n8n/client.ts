import {
  n8nWorkflowListItemSchema,
  n8nProjectSchema,
  n8nProjectMemberSchema,
  n8nUserSchema,
  n8nExecutionSchema,
  type N8nWorkflowListItem,
  type N8nProject,
  type N8nProjectMember,
  type N8nUser,
  type N8nExecution,
} from '@argus/shared';
import type { ConnectionStatus } from '@argus/shared';

/** How far back health looks: n8n's default execution retention (~14 days). */
export const DEFAULT_HEALTH_WINDOW_HOURS = 336;
/** Safety cap so a busy fleet can't make one health sweep unbounded (250×24 rows). */
const EXECUTIONS_MAX_PAGES = 24;

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
    // Some paths already carry a query string (e.g. /users?includeRole=true).
    const sep = pathBase.includes('?') ? '&' : '?';
    do {
      const q = cursor
        ? `${sep}limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
        : `${sep}limit=${PAGE_LIMIT}`;
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

    /**
     * Members of ONE team project, with their per-project role (S4 ownership-inference
     * source, contracts/n8n-19). Throws HttpError on a non-200 — notably 401/403 when
     * the instance isn't licensed for project roles or the key lacks `user:list` — so
     * inference degrades honestly to "couldn't infer" (rule 5), never a fabricated owner.
     */
    async listProjectMembers(projectId: string): Promise<N8nProjectMember[]> {
      return paginate(`/projects/${encodeURIComponent(projectId)}/users`, (raw) => {
        const r = n8nProjectMemberSchema.safeParse(raw);
        return r.success ? r.data : null;
      });
    },

    /**
     * The instance's users with their GLOBAL role (contracts/n8n-04) — resolves a
     * personal project's creator to a person and populates the assign-owner picker.
     * Throws HttpError on a non-200 (e.g. a key without `user:list`).
     */
    async listUsers(): Promise<N8nUser[]> {
      return paginate('/users?includeRole=true', (raw) => {
        const r = n8nUserSchema.safeParse(raw);
        return r.success ? r.data : null;
      });
    },

    /**
     * Executions within the retention window (S3 health source, contracts/n8n-17).
     * Fetched newest-first WITHOUT `includeData` + WITH `redactExecutionData=true`
     * (no execution payloads reach Argus). Stops paging once it crosses the window
     * cutoff (list is id-desc = newest-first) or hits the page cap. Invalid rows are
     * skipped, never fabricated (rule 5). Throws HttpError on a non-200 (e.g. a key
     * lacking `execution:list`) so the caller can degrade health to `unknown`.
     */
    async listExecutions(opts: { windowMs: number; now?: number }): Promise<N8nExecution[]> {
      const now = opts.now ?? Date.now();
      const cutoff = now - opts.windowMs;
      const out: N8nExecution[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const q =
          `/executions?limit=${PAGE_LIMIT}&includeData=false&redactExecutionData=true` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const { status, json } = await get(q);
        if (status !== 200) throw new HttpError(status);
        const body = json as { data?: unknown[]; nextCursor?: unknown } | undefined;
        let crossedWindow = false;
        for (const raw of body?.data ?? []) {
          const parsed = n8nExecutionSchema.safeParse(raw);
          if (!parsed.success) continue;
          const started = parsed.data.startedAt ? Date.parse(parsed.data.startedAt) : NaN;
          // A dated run older than the window → we've paged past it (newest-first).
          if (!Number.isNaN(started) && started < cutoff) { crossedWindow = true; continue; }
          out.push(parsed.data);
        }
        cursor = typeof body?.nextCursor === 'string' ? body.nextCursor : undefined;
        pages += 1;
        if (crossedWindow) break;
      } while (cursor && pages < EXECUTIONS_MAX_PAGES);
      return out;
    },

    /**
     * The most-recent executions for ONE workflow (S3 drawer, on-demand). Metadata
     * only — WITHOUT `includeData` — so no payloads reach Argus. Newest-first.
     */
    async recentExecutions(opts: { workflowId: string; limit?: number }): Promise<N8nExecution[]> {
      const limit = Math.min(opts.limit ?? 10, PAGE_LIMIT);
      const { status, json } = await get(
        `/executions?workflowId=${encodeURIComponent(opts.workflowId)}&limit=${limit}&includeData=false`,
      );
      if (status !== 200) throw new HttpError(status);
      const body = json as { data?: unknown[] } | undefined;
      const out: N8nExecution[] = [];
      for (const raw of body?.data ?? []) {
        const parsed = n8nExecutionSchema.safeParse(raw);
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    },

    /**
     * Redacted debug detail for ONE execution (S3 drawer, on-demand). Fetched WITH
     * `redactExecutionData=true` so n8n strips the error MESSAGE + all node data
     * server-side. Argus **allowlists** only the failing-node name + the error
     * type/code — it never reads or returns the message or any payload (rule 6,
     * contracts/n8n-18). Returns null when the detail can't be read.
     */
    async executionDebug(executionId: string): Promise<{ failedNode: string | null; errorType: string | null; errorCode: string | null } | null> {
      const { status, json } = await get(
        `/executions/${encodeURIComponent(executionId)}?includeData=true&redactExecutionData=true`,
      );
      if (status !== 200) return null;
      const body = json as { data?: { resultData?: unknown } } | { resultData?: unknown } | undefined;
      const resultData = (body as { data?: { resultData?: unknown } })?.data?.resultData
        ?? (body as { resultData?: unknown })?.resultData;
      const rd = resultData as { lastNodeExecuted?: unknown; redactedError?: { type?: unknown; httpCode?: unknown } } | undefined;
      if (!rd) return null;
      const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
      return {
        failedNode: str(rd.lastNodeExecuted),
        errorType: str(rd.redactedError?.type),
        errorCode: str(rd.redactedError?.httpCode),
      };
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
