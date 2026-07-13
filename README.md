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

> **Status — the core experiment is built and green.** Point Argus at one or more n8n
> instances and it gives you, behind a polished n8n-style UI that works on phone and
> desktop:
> - a single **live catalog** of every workflow across the whole estate (connect,
>   sync, reconcile, filter);
> - an **AI plain-English summary + category + criticality** per workflow, from the
>   LLM provider *you* choose (OpenAI, Anthropic, or any self-hosted OpenAI-compatible
>   endpoint);
> - **health** — what's healthy, failing, idle, and *silently* failing (green but a
>   node errored);
> - **ownership & accountability** — an answerable owner per workflow, governance-gap
>   detection, and a self-audit timeline of every governance action;
> - a fleet **dependency graph** + "what breaks if this fails?" blast-radius analysis,
>   including the cross-instance edges (prod↔staging) nothing else sees;
> - a single **governance overview**; and
> - **chat** — ask questions in natural language, answered only from the deterministic
>   tools (never invented).
>
> All automated checks pass (`pnpm verify` is green). Still to come in the next
> milestone: real-time push updates (Log Streaming receiver), outbound notifications,
> cross-instance identity resolution, a Docker image, and the independent "blind fleet"
> evaluation. See [`docs/PLAN.md`](docs/PLAN.md) for the full roadmap and what's
> deliberately deferred.

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
- fills each with 4 team projects, people, credentials, **~100 workflows**, and real
  execution history (including deliberate failures) — a believably messy ~200-workflow
  estate, not a tidy dozen;
- plants the governance problems every view is built to surface: a broken sub-workflow
  reference, an orphan, a single owner holding 5 critical workflows, a green-but-
  silently-failing run, MCP-exposed workflows reaching sensitive systems, an archived
  workflow still called by an active one, and more;
- wires the cross-instance scenarios (a staging workflow that reaches into prod, a
  person who owns critical workflows in both instances, a shared Salesforce system);
- and, if a local Argus is already running, **re-registers both connections into it
  with fresh read-only keys** — so the app is pointed at the freshly-seeded estate
  automatically (see step 4).

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

Then open **http://localhost:5173** (server + web UI run together). Log in with the
dev default password **`argus`** and any name/email you like (the identity is
*asserted*, stamped on your session and every audit entry — see the security note
below).

**Point the app at the estate.** The connection registry lives in the app's
**Connections** page. Since you seeded (step 1) *before* Argus was running, the app has
no connections yet — get them in with either:

- **re-run `pnpm seed`** now that Argus is up — it **auto-registers both instances** into
  the running app with fresh read-only keys; or
- add the two by hand in **Connections** — base URL `http://localhost:5678` / `:5679`
  plus a read-only n8n API key from each instance.

(Tip: start `pnpm dev` *before* your first `pnpm seed` and the auto-register happens on
that first seed.)

Once connected, Argus polls each instance (~30s), syncs the catalog, and — if you've
picked an LLM provider in **Settings** — enriches each workflow. Then explore:

- **Overview** — the estate at a glance.
- **Estate** — the workflow catalog (**Explore**), with **Health**, **Ownership**, and
  the dependency **Graph** as lenses over the same estate.
- **Chat** — ask questions in natural language.
- **Activity** — the unified governance audit timeline.
- **Connections** / **Settings** — instances and LLM provider.

> Everything except **enrichment** and **chat** is fully deterministic and works with
> **no LLM configured at all** — the catalog, health, ownership, gaps, and graph are
> all computed, not guessed. `pnpm verify` remains the executable, plain-English report
> of every signed-off behavior.

### Handy follow-ups

- `pnpm n8n:up` — just launch the two instances (what `pnpm seed` calls internally).
- `pnpm seed:unlock` — re-apply the instances' E2E licenses after a restart, without
  touching the seeded data.

---

## Point Argus at an existing fleet of instances

You would **not** run `pnpm seed` against a real fleet — seeding resets and writes
demo data. Real instances are connected **read-only** through the app's **Connections**
page: you register each instance's URL together with a scoped, read-only **n8n API key**
you create inside that instance, and Argus ingests it without changing anything.

**To connect a real instance:**

1. In the target n8n instance, create an **n8n API key** under **Settings → n8n API**
   with read/list scopes only — no write scopes required. Scope coverage is graceful:
   `workflow:list` + `project:list` cover the catalog; add `execution:list`
   (+ `execution:read`) for **health**; add `user:list` for the **advisory inferred
   owner**. If a scope is missing, that feature degrades explicitly ("unavailable" /
   "couldn't infer") rather than guessing — everything else still works.
2. In Argus → **Connections**, add the connection: a **label**, the instance's **base
   URL** (e.g. `https://n8n.your-company.internal`), the **API key**, and optionally the
   instance's **public webhook host** (lets Argus confirm cross-instance edges — e.g.
   spotting that one instance's workflow calls another's webhook).

Argus **validates the key against the live instance before saving** (unreachable vs.
unauthorized, in plain English), stores it **encrypted at rest**, and **never** returns
it in any API response, log, or audit entry. Registering or removing a connection is
itself audit-logged. Real instances do **not** need E2E mode — that switch is only for
the disposable demo estate above.

> **Read-only, always.** Argus only ever *reads* your instances (the Public API, over
> your scoped key). It never activates, edits, or deletes a workflow. The one thing it
> writes is its *own* governance layer — owner assignments, corrections, the audit log —
> in its own database, invisible to n8n.
>
> **Not yet wired:** real-time push (the Log Streaming receiver) is deferred to the next
> milestone, so today freshness comes from the ~30s reconciliation poll (fresh within a
> minute), not seconds. See `docs/PLAN.md` → "Next milestones".

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
apps/server      Express + better-sqlite3 API — connections, sync, analyzer,
                 enrichment, health, ownership, graph, chat, audit, LLM wrapper
apps/web         Vue 3 + Vite + Pinia UI — Overview, Estate (Explore/Health/
                 Ownership/Graph), Chat, Activity, Connections, Settings
packages/shared  TypeScript types + Zod schemas  (the server↔web contract)
scripts/         seed.mjs, verify.mjs, probe-*.mjs, n8n-up.mjs, eval/, seed/, lib/
contracts/       captured real n8n request/response shapes
.agents/specs/   per-subsystem plain-English specs (the review surface)
docs/            PLAN.md (master spec), DEV-STRATEGY.md, DATA-FLOW*.md, DECISIONS.md
```

---

## A note on security posture

Argus is a **platform-owner tool** and deliberately shows the whole fleet, which
flattens n8n's per-project RBAC — a stated scope, enforced by Argus's own login. A few
things follow from that, all reflected in the app:

- **Everything is behind a login** (admin password + a required *asserted* identity —
  name/email stamped on the session and every audit entry; shown as "asserted" because
  it isn't verified — OIDC is a later track). Argus is **private-network only, never
  internet-exposed** — and the demo instances' `E2E_TESTS=true` mode makes that
  doubly true.
- **Every n8n API key is stored encrypted at rest** and never leaves in an API response,
  log, or audit entry. They are collectively the highest-value secrets in the system —
  a compromised Argus means read access to every connected instance, which is why the
  private-network stance matters more with each instance you add.
- **Argus audits itself.** Every mutation (owner assignment, correction, config change,
  connection add/remove, export) writes an append-only audit entry in the *same
  transaction* — visible in **Activity**.

---

## Learn more

- [`docs/PLAN.md`](docs/PLAN.md) — the approved master spec: what Argus is and why.
- [`.agents/specs/`](.agents/specs/) — per-subsystem plain-English specs (the review surface).
- [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md) / [`docs/DATA-FLOW-CHAT.md`](docs/DATA-FLOW-CHAT.md) — exactly what is sent to the LLM.
- [`contracts/DISCOVERY.md`](contracts/DISCOVERY.md) — what we've verified against the real n8n API.
