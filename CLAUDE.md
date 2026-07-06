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
- [`.agents/skills/`](.agents/skills/) — reusable build skills (e.g. `argus-ui`, `spec-driven-development`). **Author/edit skills here, under `.agents/skills/<name>/SKILL.md` — this is the canonical source.** Each is symlinked into `.claude/skills/<name>` so Claude Code auto-discovers it; never author a real skill file in `.claude/skills/`. New skill → add it under `.agents/skills/` and `ln -sfn ../../.agents/skills/<name> .claude/skills/<name>`.
- [`contracts/`](contracts/) — captured real n8n request/response shapes (see rule 1).
- [`PROMPTS.md`](PROMPTS.md) — the self-maintaining build journal (see rule 8).

---

## The 11 standing rules

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

**6. One provider-abstracting LLM wrapper; sacred tables.** All LLM calls go through
**one wrapper** (provider [Anthropic or OpenAI, user-chosen + BYO key], model,
redaction, spend cap, logging) behind two stable seams — structured output against a
Zod schema, and a streaming tool loop — so no caller sees provider specifics. The
**ownership**, **identity-merge**, and
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

**10. UI on vendored n8n tokens; both themes and both viewports, always.** All UI is
built on n8n's vendored design tokens via `var(--…)` — **never** hard-code colors,
spacing, or fonts. Preserve light/dark mode (n8n's tokens theme via `body[data-theme]`
+ `prefers-color-scheme`; a handful use `light-dark()`); never collapse to a single
theme. **Responsiveness is designed in from the start, never retrofitted:** desktop is
the primary target, but **every element must render correctly and remain usable from a
375px mobile width up through desktop — no horizontal overflow, no cut-off content.**
Wide content (tables, catalog rows) reflows or scrolls within its container; it never
clips. **Every UI element must render correctly in both themes and at both widths** —
checked at 375px + desktop in `pnpm verify`, mechanics in the `argus-ui` skill. Tokens
live in [`apps/web/src/styles/n8n-tokens/`](apps/web/src/styles/n8n-tokens/) — see its
`VENDORED.md` for provenance and re-sync.

**11. Don't drop UI I can't see go missing; presence is a verify check.** The owner
never reads diffs, so a silently removed or restructured UI element reaches no one
until it reaches their eyes. Therefore: (a) **never remove or restructure existing UI
outside the stated scope** — prefer **additive edits over rewrites**; if scoped work
genuinely forces touching existing chrome, **stop and flag it in plain English**
before doing it. (b) Every UI element the owner signs off becomes a **UI-presence
check**: a fast component test (keyed on a stable `data-testid`, asserting the element
renders with its key text/state) **and** a plain-English `pnpm verify` row — the same
rule-3 discipline behaviors get, extended to UI. UI-presence acceptance criteria go
into the subsystem spec (rule 9), not just behavioral ones. A visual/both-theme
snapshot tripwire may back this on hero views; if so, **updating a baseline gets the
same scrutiny as changing a test (rule 2)** — never a reflex.

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
| `pnpm dev` | Run the server + web together (parallel). Open `http://localhost:5173`. |
| `pnpm dev:server` | Run just the Express API in watch mode (tsx) on `http://127.0.0.1:3000` (`/api/health`). |
| `pnpm dev:web` | Run just the Vite dev server on `http://localhost:5173` (proxies `/api` → server). |
| `pnpm probe:n8n` | Capture n8n contract + discovery probes into `contracts/` (rule 1). Resets the E2E instance. |
| `pnpm n8n:up` | Launch the two managed n8n instances — prod `:5678` + staging `:5679` — isolated by per-instance `N8N_USER_FOLDER` under `.n8n-instances/` (brokers moved off `:5679` to `6779/6780`). Does not modify `../n8n`. |
| `pnpm seed` | **The one command.** Ensures both instances are up (launches if needed), then seeds the two-instance demo estate with the planted governance problems (rule-1 verified). Idempotent. |
| `pnpm seed:unlock` | Re-apply the E2E license flags + quotas to both instances (lost on restart/reset) without touching seeded data. |

**Before saying "done":** `pnpm typecheck && pnpm lint && pnpm test && pnpm verify` — all green.

### Server environment (S1a+)

The Argus server reads these env vars (safe dev defaults if unset — it warns, and
`pnpm dev` works out of the box; **set them for any real use**):

| Var | Default | Purpose |
|---|---|---|
| `ARGUS_ADMIN_PASSWORD` | `argus` | Login password (the asserted identity — name/email — is entered at login). |
| `ARGUS_SESSION_SECRET` | dev value | HMAC key for the signed session cookie. |
| `ARGUS_ENCRYPTION_KEY` | dev value | AES-256-GCM key encrypting each connection's n8n API key at rest. |
| `ARGUS_DB_PATH` | `data/argus.sqlite` | Argus's own DB (sacred connections + audit; gitignored, never committed). |
| `ARGUS_POLL_INTERVAL_MS` | `30000` | Per-connection re-list + reconcile cadence (the freshness loop). |

Registering a connection needs a **read-only n8n API key** (n8n → Settings → n8n
API); scopes `workflow:list` + `project:list` are enough. Argus is read-only
against every instance.

### Workspace layout

```
apps/server      Express + better-sqlite3 + tsx   (GET /api/health today)
apps/web         Vue 3 + Vite + Pinia             (token-styled placeholder today)
packages/shared  TypeScript types + Zod schemas   (the server↔web contract)
scripts/         verify.mjs, probe-n8n.mjs, seed.mjs, n8n-up.mjs, seed/, lib/, hooks/
contracts/       captured real n8n request/response shapes
.agents/specs/   per-subsystem specs (just-in-time)
.agents/skills/  reusable build skills (argus-ui, spec-driven-development)
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
