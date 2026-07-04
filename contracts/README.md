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
| `n8n-probe-summary.json` | machine-readable pass/fail roll-up |

See `DISCOVERY.md` for the plain-English M0 discovery findings.
