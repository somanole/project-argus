# CLAUDE.md — Project Argus standing rules

Argus is the **fleet-wide governance and accountability layer for n8n** (n8n
builds and operates automations; Argus answers "what's running, who's
accountable, what's the blast radius"). I (Claude) obey the rules below in
**every** session without being reminded. The product owner builds by intent and
**never reads code, diffs, or test files** — they review behaviors, demos,
plain-English reports, and specs. My job is to make that safe.

**Read these, don't duplicate them:**
- [`docs/PLAN.md`](docs/PLAN.md) — the approved master spec (what we're building and why).
- [`docs/DEV-STRATEGY.md`](docs/DEV-STRATEGY.md) — how the owner and I work together.
- [`.agents/specs/`](.agents/specs/) — per-subsystem plain-English specs (the owner's review surface). Written just-in-time at each milestone; `TEMPLATE.md` is the shape. None yet — M1 is the first.
- [`contracts/`](contracts/) — captured real n8n request/response shapes (see rule 1).
- [`PROMPTS.md`](PROMPTS.md) — the self-maintaining build journal (see rule 8).

---

## The 10 standing rules

**1. Contract-verify before building against n8n.** Before building against any
n8n API or event, hit the **real running n8n** first, save the actual
request/response in `contracts/`, and code against that — never against memory of
n8n. (`pnpm probe:n8n` does this.) The plan already caught wrong API assumptions
this way. Probes re-run weekly and on every n8n upgrade; drift fails loudly.

**2. Tests come from intent, and are never weakened.** Everything I build gets
automated tests written from **what the owner asked for**, not from what I
happened to implement. Never weaken, skip, or delete a test to make something
pass. If a test looks wrong, **stop and tell the owner in plain English**.

**3. One `pnpm verify`, plain-English, always current.** Maintain a single
`pnpm verify` that checks **every behavior the owner has signed off**, printing a
plain-English report (behavior → pass/fail → a number to sanity-check). When the
owner approves a new behavior, add its check **in the same session**.

**4. "Done" means the verify report is green.** Run typecheck, lint, and the
relevant tests before telling the owner anything is done. Never report done on a
red report.

**5. Never guess — say "couldn't analyze."** When something can't be parsed or
detected, the data says **"couldn't analyze"**; never fabricate a value. A
governance tool that guesses is dead. (A confident wrong answer is fatal; a
visible "couldn't analyze" is fine.)

**6. One LLM wrapper; sacred tables.** All LLM calls go through **one wrapper**
(model, redaction, spend cap, logging). The **ownership**, **identity-merge**, and
**audit-log** tables are sacred: no code path may bulk-delete or rewrite them, and
**every mutation writes its audit entry in the same transaction**.

**7. Corrections can become rules.** When the owner corrects me, I ask: *"should
this become a permanent rule?"* If yes, I add it to this file myself.

**8. Journal every session; roll up at gates.** At the end of every session,
append an entry to `PROMPTS.md` using its template. At each milestone gate, append
a retro rollup. The owner never writes these. (A `Stop` hook enforces existence; a
`UserPromptSubmit` hook captures raw prompts to `prompts-raw.jsonl`.)

**9. Specs stay in sync, just-in-time.** Keep a plain-English spec per subsystem in
`.agents/specs/`, in sync with the code. At the **start** of each milestone,
write/update the relevant spec(s) from the owner's intent (behavior + acceptance
criteria) **before** building; when code and spec diverge, update the spec **in the
same session**; every acceptance criterion becomes a check in the verify report.
The spec is the review surface, not the code. Never ask the owner to prompt "per
the spec" — I write it from their intent. Specs are just-in-time (none for M0).

**10. UI on vendored n8n tokens; both themes, always.** All UI is built on n8n's
vendored design tokens via `var(--…)` — **never** hard-code colors, spacing, or
fonts. Preserve light/dark mode (n8n's tokens theme via `body[data-theme]` +
`prefers-color-scheme`; a handful use `light-dark()`); never collapse to a single
theme. **Every UI element must render correctly in both.** Tokens live in
[`apps/web/src/styles/n8n-tokens/`](apps/web/src/styles/n8n-tokens/) — see its
`VENDORED.md` for provenance and re-sync.

---

## Commands (every command to run/build/test this project)

Run from the repo root. Package manager is **pnpm** (workspace); Node **>=22.22**.

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace deps. Native deps (`better-sqlite3`, `esbuild`) are allowlisted in `pnpm.onlyBuiltDependencies`; if their binaries are missing, `pnpm rebuild -r better-sqlite3 esbuild`. |
| `pnpm verify` | **The definition of done.** Plain-English report of every signed-off behavior. Needs n8n running (check 3). |
| `pnpm build` | Build all packages (`shared` → `server` → `web`). |
| `pnpm typecheck` | `tsc --noEmit` across all packages (TypeScript strict). |
| `pnpm lint` | ESLint (flat config) over TS + Vue. |
| `pnpm test` | Vitest across all packages. |
| `pnpm dev:server` | Run the Express API in watch mode (tsx) on `http://127.0.0.1:3000` (`/api/health`). |
| `pnpm dev:web` | Run the Vite dev server on `http://localhost:5173` (proxies `/api` → server). |
| `pnpm probe:n8n` | Capture n8n contract + discovery probes into `contracts/` (rule 1). Resets the E2E instance. |

**Before saying "done":** `pnpm typecheck && pnpm lint && pnpm test && pnpm verify` — all green.

### Workspace layout

```
apps/server      Express + better-sqlite3 + tsx   (GET /api/health today)
apps/web         Vue 3 + Vite + Pinia             (token-styled placeholder today)
packages/shared  TypeScript types + Zod schemas   (the server↔web contract)
scripts/         verify.mjs, probe-n8n.mjs, hooks/
contracts/       captured real n8n request/response shapes
.agents/specs/   per-subsystem specs (just-in-time)
docs/            PLAN.md, DEV-STRATEGY.md, M0-KICKOFF.md
```

---

## Running local n8n (our reference instance)

The n8n monorepo is a **sibling at `../n8n`** — our reference **source** and local
**dev instance**. Pinned version: **2.29.0** (design-system tokens 2.28.0).

**⚠️ NEVER modify `../n8n`.** We read it and run it; it is read-only by convention.
Its source is our contract oracle, not our codebase.

**Start it (already built):**
```bash
cd ../n8n && E2E_TESTS=true N8N_PORT=5678 pnpm start
```
The build is already done (`packages/*/dist` present). If a rebuild is ever needed
it is **long** — redirect to a log and tail it:
```bash
cd ../n8n && pnpm build > /tmp/n8n-build.log 2>&1 &   # then: tail -f /tmp/n8n-build.log
```

**🔒 `E2E_TESTS=true` disables auth on the `/rest/e2e/*` endpoints** (reset,
feature/quota patch). This unlocks the enterprise surface for dev/demo. **An
E2E-mode instance must NEVER be internet-exposed** — private network / localhost
only. (Feature toggles are in-memory and reset on n8n restart; re-apply via the
probe/seeder — this is the future `pnpm seed:unlock`.)

**Verify it's up:** `curl -s http://localhost:5678/healthz` → `{"status":"ok"}`.

---

## n8n version pins (drift = loud failure)

- n8n instance / source: **2.29.0**
- `@n8n/design-system` tokens: **2.28.0** (vendored — see `apps/web/src/styles/n8n-tokens/VENDORED.md`)
- Re-check contracts on every n8n upgrade and weekly (`pnpm probe:n8n`).
