/**
 * Thin fetch wrapper for the Argus API. Sends/receives JSON, surfaces the
 * server's plain-English `error` on failure, and validates success bodies
 * against the shared contract when a parser is given (a shape mismatch is an
 * error we surface, never paper over — standing rule 5).
 */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

interface Options {
  method?: string;
  body?: unknown;
}

/** Structural shape of a zod schema — avoids a direct zod dependency here. */
interface Parser<T> {
  parse(value: unknown): T;
}

export async function api<T>(path: string, opts: Options = {}, schema?: Parser<T>): Promise<T> {
  const init: RequestInit = { method: opts.method ?? 'GET', headers: { accept: 'application/json' } };
  if (opts.body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'could not reach the Argus server');
  }

  if (res.status === 204) return undefined as T;

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const message = (json as { error?: string } | undefined)?.error ?? `request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }

  return schema ? schema.parse(json) : (json as T);
}
