import type { SilentFailures } from '@argus/shared';

/**
 * S6.3 Layer 2 — the silent-failure detector. Pure + unit-tested; coded against the real
 * un-redacted execution shape captured in contracts/n8n-23.
 *
 * A node error swallowed by `onError: continue*` is NOT visible in n8n's REDACTED execution
 * detail (the node reads `executionStatus: 'success'`, and redaction clears `item.json` to
 * `{}`). So Layer 2 reads the UN-redacted detail (owner-approved narrow relaxation of the S3
 * "redaction is n8n-side" rule) and this extractor immediately reduces it to an ALLOWLIST:
 * **node name + error type (`error.name`) + error code (`error.code`/`httpCode`) ONLY**. It
 * NEVER reads `message`, `stack`, or any other `json`/binary field — those never leave this
 * boundary. A swallowed error whose only detail is a message string is detected as *present*
 * (the node is named) with a null type/code, never by surfacing the string.
 */

/** One allowlisted swallowed-node error (name + type/code only — never the message). */
export interface SwallowedError {
  node: string;
  errorType: string | null;
  errorCode: string | null;
}

/** Read ONLY the allowlist-safe class off an error object; never message/stack. */
function allowlist(err: unknown): { type: string | null; code: string | null } {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; httpCode?: unknown };
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return { type: str(e.name), code: str(e.code) ?? str(e.httpCode) };
}

/**
 * Extract the allowlisted swallowed-node errors from ONE execution's un-redacted `resultData`.
 * Detects a swallowed error three ways (contracts/n8n-23), in priority order per node run:
 *  (A) `taskData.error` — an engine-level throw that `onError` continued past;
 *  (B) an output item's `error` object — a node that emitted a structured error item;
 *  (C) an output item's `json.error` — the error merged into the item's json (object → type/code;
 *      a bare string is the message → presence only, type/code null, string NEVER read).
 * At most one entry per node (the first affected run) — enough to name the offender.
 */
export function extractSwallowedErrors(resultData: unknown): SwallowedError[] {
  const runData = (resultData as { runData?: unknown } | undefined)?.runData;
  if (!runData || typeof runData !== 'object') return [];

  const out: SwallowedError[] = [];
  for (const [node, runsRaw] of Object.entries(runData as Record<string, unknown>)) {
    const runs = Array.isArray(runsRaw) ? runsRaw : [];
    let hit: { type: string | null; code: string | null } | null = null;
    for (const run of runs) {
      const task = run as { error?: unknown; data?: { main?: unknown } };
      // (A) engine-level throw recorded on the task.
      if (task.error && typeof task.error === 'object') {
        hit = allowlist(task.error);
        break;
      }
      // (B)/(C) item-level swallow on any output.
      const main = Array.isArray(task.data?.main) ? (task.data!.main as unknown[]) : [];
      for (const output of main) {
        for (const item of Array.isArray(output) ? output : []) {
          const it = item as { error?: unknown; json?: { error?: unknown } };
          if (it?.error && typeof it.error === 'object') {
            hit = allowlist(it.error);
            break;
          }
          const je = it?.json?.error;
          if (je !== undefined && je !== null) {
            // Object → allowlist its class; string → presence only (it IS the message).
            hit = typeof je === 'object' ? allowlist(je) : { type: null, code: null };
            break;
          }
        }
        if (hit) break;
      }
      if (hit) break;
    }
    if (hit) out.push({ node, errorType: hit.type, errorCode: hit.code });
  }
  return out;
}

/** One inspected success run: when it started + the swallowed errors found in it. */
export interface InspectedRun {
  startedAt: string | null;
  swallowed: SwallowedError[];
}

/**
 * Aggregate the inspected success runs of ONE workflow into the served `SilentFailures`
 * dimension. `runsAffected` counts runs with ≥1 swallowed error; the `last*` fields come
 * from the most recent affected run. Honest bounding: `runsInspected` is the denominator
 * actually fetched — absence of affected runs among them is "not observed silently failing",
 * never "verified clean" (rule 5).
 */
export function aggregateSilentFailures(inspected: InspectedRun[]): SilentFailures {
  const affected = inspected.filter((r) => r.swallowed.length > 0);
  const mostRecent = [...affected].sort(
    (a, b) => (a.startedAt ? Date.parse(a.startedAt) : 0) - (b.startedAt ? Date.parse(b.startedAt) : 0),
  )[affected.length - 1];
  const err = mostRecent?.swallowed[0] ?? null;
  return {
    runsAffected: affected.length,
    runsInspected: inspected.length,
    lastNode: err?.node ?? null,
    lastErrorType: err?.errorType ?? null,
    lastErrorCode: err?.errorCode ?? null,
    lastSeenAt: mostRecent?.startedAt ?? null,
  };
}
