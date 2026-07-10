# Project Argus

**Argus is the fleet-wide governance and accountability layer for n8n.** n8n builds
and operates automations; Argus answers the questions a platform owner has to
answer about them: **what's running, who's accountable, and what's the blast
radius** if something breaks. It reads an entire estate of n8n instances —
workflows, credentials, projects, people, executions, and the edges between them —
and surfaces the risks: unowned or single-owner-critical workflows, broken
sub-workflow references, cross-instance dependencies ("prod depends on staging"),
MCP-exposed sensitive workflows, and more.

Argus is **read-only and advisory** about the estate: it infers ownership and risk,
shows its confidence, and lets a human decide — it never rewrites your automations.

> **Status.** Argus is built milestone by milestone. **Available today:** the
> **seeder** (M1) — one command that stands up a realistic two-instance demo estate
> with real governance problems planted in it — and the app scaffold (M0). The
> ingestion + analysis that turn that estate into governance findings land in the
> next milestone (M2). See [`docs/PLAN.md`](docs/PLAN.md) for the full roadmap.

---

## Prerequisites

- **Node >= 22.22** and **pnpm >= 10** (the repo pins `pnpm@10.23.0`).
- A sibling checkout of the **n8n monorepo at `../n8n`**, pinned to **2.29.0** and
  already built. Argus runs it as the local reference/dev instance; it is
  **read-only by convention — Argus never modifies `../n8n`**.
- Install dependencies once:

  ```bash
  pnpm install
  ```

  Native deps (`better-sqlite3`, `esbuild`) are allowlisted; if their binaries are
  missing, run `pnpm rebuild -r better-sqlite3 esbuild`.

---

## Seed a fresh demo estate and start Argus

This is the fastest way to see what Argus is for. One command stands up **two
believable n8n instances — prod and staging — that together look like one
company's automation estate**, with governance problems deliberately planted so
there's real stuff to find.

### 1. Seed the estate

```bash
pnpm seed
```

`pnpm seed` is idempotent and does everything:

- launches both instances if they aren't already running — **prod on
  `http://localhost:5678`**, **staging on `http://localhost:5679`** — each isolated
  in its own data folder under `.n8n-instances/` (git-ignored), so reseeding one
  never touches the other;
- fills each with 4 team projects, people, credentials, ~25–30 workflows, and real
  execution history (including deliberate failures);
- wires the cross-instance scenarios (a staging workflow that reaches into prod, a
  person who owns critical workflows in both instances, a shared Salesforce system).

### 2. Open the two instances

Point a browser at each and log in as the owner — it should read like a real
company's n8n:

- prod — http://localhost:5678
- staging — http://localhost:5679
- **owner login:** `nathan@n8n.io` / `PlaywrightTest123`

(Only ever run these E2E-mode instances on localhost / a private network — never
internet-exposed.)

### 3. Confirm the planted problems are really there

```bash
pnpm verify
```

This prints a plain-English report — each governance problem, whether it's present,
and a number to sanity-check (Slack utility fan-in = 5, exactly one broken
reference, sub-workflow chain depth 3, one person owns 5 critical workflows, a
cross-instance edge, and so on). Green means the demo estate is exactly as
intended.

### 4. Start the Argus app

```bash
pnpm dev
```

Then open **http://localhost:5173**. This runs the Argus server + web UI together.

> Today the UI is the scaffold — it confirms the app is wired up and healthy. The
> dashboards, dependency graph, and chat that read the seeded estate and report on
> it arrive in the next milestone; `pnpm verify` is the current window into the
> estate's governance state.

### Handy follow-ups

- `pnpm n8n:up` — just launch the two instances (what `pnpm seed` calls internally).
- `pnpm seed:unlock` — re-apply the instances' E2E licenses after a restart, without
  touching the seeded data.

---

## Point Argus at an existing fleet of instances

You would **not** run `pnpm seed` against a real fleet — seeding resets and writes
demo data. Real instances are connected **read-only**: you register each instance's
URL together with a scoped, read-only **n8n API key** you create inside that
instance, and Argus ingests it without changing anything.

**What each connection needs (per instance):**

- the instance's **base URL** (e.g. `https://n8n.your-company.internal`);
- an **n8n API key** created in that instance (**Settings → n8n API**) with
  read/list scopes for workflows, executions, projects, users, credentials, and
  tags — no write scopes required;
- the instance's **public webhook host**, which lets Argus resolve cross-instance
  edges with confidence (e.g. spotting that one instance's workflow calls another's
  webhook).

Real instances do **not** need E2E mode — that switch is only for the disposable
demo estate above.

> **Availability.** The app-level connection registry and the read-only ingestion
> that consume these connections are the **next milestone (M2)** — not wired into
> the UI yet. What works against *any* running instance today is the contract
> tooling: point it at an instance with `N8N_BASE_URL=<url> pnpm probe:n8n` to
> capture and verify its real API shapes (Argus always codes against captured
> contracts, never against assumptions). When M2 lands, connecting a real fleet
> will be the registration flow described above; the inputs won't change.

---

<!-- LLM_PROVIDERS_SECTION — kept in sync with docs/DATA-FLOW*.md (rule 9). -->

## Choose your LLM provider (or run inference inside your own network)

Argus uses an LLM for two things: **enrichment** (a summary, category, and criticality
per workflow) and **chat** (natural-language questions answered from real tool results).
Everything else — the catalog, health, ownership, the dependency graph — is fully
deterministic and works with no LLM at all.

You bring your own provider and key, chosen in **Settings**:

| Provider | What you supply | Model |
|---|---|---|
| **OpenAI** | API key | `gpt-5-mini` (pinned) |
| **Anthropic** | API key | `claude-haiku-4-5` (pinned) |
| **Custom endpoint** | Base URL + model id, **API key optional** | yours to choose |

### With a self-hosted endpoint, nothing leaves your network

"Custom endpoint" is any **OpenAI-compatible** API: **vLLM**, **TGI**, **Ollama**,
**LM Studio**, or a corporate LLM gateway. Point Argus at one running inside your own
network and **no estate metadata leaves it** — no workflow names, no owner names, no
governance metadata reach OpenAI, Anthropic, or any other third party. For a governance
tool that inventories your automations, that is often the difference between
"interesting" and "deployable".

```bash
# Local dev, end to end, with nothing leaving the machine:
ollama serve
ollama pull llama3.1:8b
# then in Argus → Settings → Custom endpoint:
#   Base URL  http://127.0.0.1:11434/v1
#   Model     llama3.1:8b
#   API key   (leave blank — Ollama is keyless)
```

Two honest caveats, both enforced in code rather than left to hope:

- **Chat needs a model that can call tools.** Argus **capability-probes** your endpoint
  when you save it. If the model can't emit tool calls, chat says **"chat unavailable on
  this provider"** and enrichment carries on — Argus never answers a governance question
  from a guess. (Tool-calling models: Llama 3.1+, Qwen, Mistral. On vLLM, start it with
  `--enable-auto-tool-choice`.)
- **Answer quality depends on the model you pick.** Our quality bar (H1) is
  pre-registered against the reference provider; a customer-chosen open-weight model is
  measured against that same bar and reported separately — never certified in advance.
  Measure yours with `pnpm eval --provider openai_compatible`.

A base URL is a destination for your data, so Argus validates its scheme, refuses
credentials embedded in the URL, and **audit-logs every change**. A plain `http://`
endpoint is allowed — it's normal on a private network — but it means metadata travels
unencrypted there, which Settings and the data-flow docs state rather than assume. See
[`docs/DATA-FLOW.md`](docs/DATA-FLOW.md) and
[`docs/DATA-FLOW-CHAT.md`](docs/DATA-FLOW-CHAT.md) for exactly what is sent.

> **Hosted OpenAI-compatible routers (OpenRouter, Together, Groq…) work too** — they speak
> the same wire format, so they need no extra support: paste the router's base URL, model id,
> and key. But understand what you're choosing: a router is a **third-party proxy**, so your
> estate metadata transits **one more data processor** than going direct to OpenAI or
> Anthropic — the opposite of the self-hosted case above, and usually a *harder* enterprise
> review, not an easier one. Prompt logging and retention vary by upstream provider and by
> your account settings. Genuinely useful for evaluating many models cheaply
> (`pnpm eval --provider openai_compatible`); think twice before making one the production
> destination for a governance tool (DECISION #31).

---

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm seed` | Stand up + seed the two-instance demo estate (idempotent). |
| `pnpm verify` | Plain-English report of every signed-off behavior. **The definition of done.** |
| `pnpm dev` | Run the Argus server + web UI (open `http://localhost:5173`). |
| `pnpm n8n:up` | Launch the two managed n8n instances (prod :5678 + staging :5679). |
| `pnpm seed:unlock` | Re-apply the instances' E2E licenses after a restart. |
| `pnpm probe:n8n` | Capture n8n contract/discovery probes into `contracts/`. |
| `pnpm build` / `pnpm typecheck` / `pnpm lint` / `pnpm test` | Build / type-check / lint / test all packages. |

The full command reference lives in [`CLAUDE.md`](CLAUDE.md).

---

## Repository layout

```
apps/server      Express + better-sqlite3 API   (GET /api/health today)
apps/web         Vue 3 + Vite + Pinia UI         (n8n-token-styled scaffold today)
packages/shared  TypeScript types + Zod schemas  (the server↔web contract)
scripts/         seed.mjs, verify.mjs, probe-n8n.mjs, n8n-up.mjs, seed/, lib/
contracts/       captured real n8n request/response shapes
.agents/specs/   per-subsystem plain-English specs (the review surface)
docs/            PLAN.md (master spec), DEV-STRATEGY.md
```

---

## Learn more

- [`docs/PLAN.md`](docs/PLAN.md) — the approved master spec: what Argus is and why.
- [`.agents/specs/seeder.md`](.agents/specs/seeder.md) — the seeder's behavior + acceptance criteria.
- [`contracts/DISCOVERY.md`](contracts/DISCOVERY.md) — what we've verified against the real n8n API.
