import { LlmError } from './types.js';

/**
 * The one HTTP path for provider calls: a JSON POST with a hard timeout (composed with
 * the caller's AbortSignal) and status→LlmError mapping so both adapters classify
 * failures identically (retryable vs not). No SDKs — we call the wire shapes captured
 * in contracts/llm-*-structured.json (standing rule 1).
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: { timeoutMs: number; signal?: AbortSignal | undefined; provider: string },
): Promise<{ status: number; json: unknown }> {
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(new Error('llm request timed out')), opts.timeoutMs);
  // Abort if EITHER the caller or our timeout fires.
  const onCallerAbort = () => timer.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) timer.abort(opts.signal.reason);
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: timer.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) throw mapHttpError(res.status, opts.provider, json);
    return { status: res.status, json };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    // Timeout / network abort.
    if (err instanceof Error && (err.name === 'AbortError' || /abort|timed out/i.test(err.message))) {
      throw new LlmError('timeout', `${opts.provider} request timed out or was aborted`, true);
    }
    throw new LlmError('unknown', `${opts.provider} request failed: ${(err as Error).message}`, false);
  } finally {
    clearTimeout(timeout);
    if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort);
  }
}

function mapHttpError(status: number, provider: string, body: unknown): LlmError {
  const detail = typeof body === 'object' && body !== null ? JSON.stringify(body).slice(0, 300) : String(body);
  if (status === 401 || status === 403) return new LlmError('auth', `${provider} auth rejected (${status}): ${detail}`, false, status);
  if (status === 429) return new LlmError('rate_limit', `${provider} rate limited (429): ${detail}`, true, status);
  if (status === 408 || status === 409 || status === 529 || status >= 500)
    return new LlmError('overloaded', `${provider} unavailable (${status}): ${detail}`, true, status);
  return new LlmError('unknown', `${provider} error (${status}): ${detail}`, false, status);
}
