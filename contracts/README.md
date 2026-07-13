# contracts/

Captured **real** request/response pairs from a running n8n instance. Standing
rule 1: Argus is never built against memory of n8n — every consumed surface is
probed against the live instance, saved here, and code is written against these
files. Probes re-run weekly and on every n8n upgrade; drift is a loud failure.

**Pinned n8n version:** 2.29.0 · **design-system tokens:** 2.28.0

## How to regenerate

1. Start n8n in E2E mode (see `CLAUDE.md` → "Running local n8n").
2. `pnpm probe:n8n` (or `node scripts/probe-n8n.mjs`).

The probe resets the E2E instance to a known owner (`nathan@n8n.io`) to mint an
API key — the same flow n8n's own Playwright harness uses. **Secrets (API keys,
cookies, passwords) are redacted before writing.** Never commit an un-redacted key.

## Files

| File | What it pins |
|---|---|
| `n8n-00-reachable.json` | instance liveness (`GET /healthz`) |
| `n8n-01-e2e-feature-patch.json` | `PATCH /rest/e2e/feature` accepts a license-flag patch (E2E unlock) |
| `n8n-02-public-api-unauth-rejected.json` | public API returns 401 without `X-N8N-API-KEY` |
| `n8n-03-projects-shape.json` | `GET /api/v1/projects` response shape |
| `n8n-04-users-shape.json` | `GET /api/v1/users?includeRole=true` response shape |
| `n8n-05-workflow-shared-shape.json` | `GET /api/v1/workflows/{id}` incl. the `shared` array |
| `n8n-06-folders-visibility.json` | M0 discovery: folders in the public API |
| `n8n-07-agents-v2-visibility.json` | M0 discovery: agents-v2 in the public API |
| `n8n-21-version-unreachable.json` | S6.1/Decision #23 gate Q1: an API-key caller gets **no** n8n version (`versionCli` is cookie-session only; no `/api/v1/version`). `pnpm probe:freshness` |
| `n8n-22-types-nodes-auth.json` | S6.1/Decision #23 gate Q2: node/credential-type metadata is **cookie-only** (`/types/nodes.json` → 401 with an API key, 200 with a cookie). `pnpm probe:freshness` |
| `n8n-23-execution-silent-failure.json` | S6.3 gate: a node error swallowed by `onError: continue*` is **invisible in the REDACTED detail** at 2.29 (node reads `executionStatus: success`, `item.json` cleared to `{}`). UN-redacted, the error lives at `runData[node].data.main[*][*].json.error` (structured `{name,code,…}` for HTTP nodes; a message string for Code nodes). Argus allowlists **node name + error type/code only**. `pnpm probe:n8n` |
| `n8n-probe-summary.json` | machine-readable pass/fail roll-up |

See `DISCOVERY.md` for the plain-English M0 discovery findings.
