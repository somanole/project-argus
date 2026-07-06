# Analyzer & catalog — spec

<!--
One file per subsystem, kept in sync with code (standing rule 9).
Plain-English behavior contract — the product owner's review surface, not code.
PLAN.md is the master spec; this is its decomposition; the verify report is the
executable form of the Acceptance criteria below.
-->

This is the **S1b** slice: turn the flat fleet list (S1a) into a **catalog you can
reason about without leaving Argus**. For every workflow, Argus computes the
**deterministic ground-truth facts** — what nodes and triggers it uses, which
credential types and external systems it touches, which data tables, whether it's
published to n8n's MCP server — and **what it directly connects to** (the
sub-workflows / tool workflows / error workflow it references). Rich filtering over
all of it, and a detail drawer with a deep-link back into the n8n editor.

The point of this slice is **trust**: it is **deterministic — no LLM**. Anything it
can't parse says **"couldn't analyze"** (standing rule 5); it never emits a
confident-wrong "broken reference." Robustness is proven against a few hundred real
public templates and the coverage reported honestly.

## Behavior

<!-- Inputs → outputs, stated as assertions that must be true. -->

**Facts (deterministic, per workflow).**
- For every workflow Argus reports, from the workflow JSON alone (no LLM): its
  **node types**, **trigger types**, **credential types**, the **external systems**
  it touches (Slack, Postgres, Stripe, Salesforce, …), any **data tables** it
  references, and whether it is **MCP-exposed**.
- Facts come from the **current workflow definition** — n8n's top-level `nodes` /
  `connections` on the list item (which is always present), **not** `activeVersion`
  (which is null for every non-active workflow). Facts are computed once per sync
  and stored, so the catalog is fast at fleet scale.
- **MCP-exposed** is the boolean fact `settings.availableInMCP === true` (the n8n
  public API surfaces it). It is *only* "is it published?" — not what it can reach.
- **Nothing is ever guessed** (rule 5). An unrecognized node or credential type is
  **recorded raw and marked `unknown`** — never dropped, never given a fabricated
  label. External systems Argus can't map are shown by their raw type.

**Direct dependencies (what a workflow directly connects to).**
- Argus detects a workflow's **outbound** direct dependencies from the *known*
  reference-bearing node types — `executeWorkflow`, `toolWorkflow`, `agentTool`
  (version-aware) — plus the workflow-level `settings.errorWorkflow`. Each is
  labeled by **kind**: sub-workflow / agent tool / error workflow. (This is a
  deliberate allow-list of node types, not a blind scan for any `workflowId`.)
- Each dependency reference resolves to exactly one honest state:
  - **resolved** — the reference is a concrete workflow id that exists in that
    instance.
  - **broken** — the reference is a concrete workflow id that **certainly does not
    exist** in that instance. This is the *only* case Argus ever calls "broken".
  - **dynamic / couldn't-analyze** — the reference is expression-valued, or the node
    supplies the sub-workflow inline / by URL (`source ≠ database`), or there is no
    id to resolve. Argus cannot know it statically and says so.
  - **unresolved** — a real reference Argus can't safely pin to an id (e.g. a
    by-name resource locator). Reported honestly as a gap, never as broken.
- **Zero false broken-refs is the contract.** A reference is `broken` **only** when
  its value is a concrete literal id (resource-locator mode `id` or `list`, or a
  bare-string id) that is absent from that instance's **complete** workflow-id set.
  If a sync read the instance only partially, no `broken` is emitted at all.
- Inward references (`settings.callerPolicy` / `settings.callerIds` — "who may call
  me") are **extracted and stored** in the same pass, but are **not shown** in the
  outbound "connects to" view; they are held for the later fleet-graph slice (S5).

**Filtering (one estate, every filter is a WHERE, never a partition).**
- The catalog is filterable by **external system** (e.g. everything touching
  Salesforce returns matching workflows from **both** instances in one view), by
  **trigger type**, by **instance**, by **active / archived**, and by
  **MCP-exposed** — all combinable, all server-side.

**Detail drawer.**
- Opening any workflow shows its facts and its **outbound direct dependencies with
  their resolution state**, without leaving Argus, plus an **"Open in n8n"**
  deep-link to that workflow in its instance's editor.

**Coverage (the trust number).**
- The verify report prints **"understands X% of the real-template corpus, the rest
  explicitly unparsed, zero false broken-refs"**, with a breakdown of what it can't
  parse (a ranked list of unknown node types). A workflow is "understood" when every
  node type is recognized (or deterministically classified) and every outbound
  dependency reached a defensible state (`resolved` / `broken` / `dynamic`); a
  by-name `unresolved` reference is the only thing that counts against coverage.
- Coverage is **honest**: understood + gaps = total. The floor only ratchets **up**;
  it is never lowered to make the report green (test-integrity rule).

**Scale.**
- The catalog stays **snappy at ~1.5–3k workflows** (list + detail + filter queries
  timed in the report), serving precomputed facts over indexed queries.

## Non-goals

<!-- What this subsystem deliberately does NOT do. Stops scope creep mid-session. -->

- **No fleet graph.** Facts + *direct* dependencies only — no graph rendering, no
  confidence-scored edge types, no cross-instance webhook matching, no transitive /
  blast-radius reachability. (Those are the S5 graph slice.)
- **MCP-exposed is just the fact + badge + filter** ("is it published?"). **Not**
  "what it can reach."
- **No enrichment / LLM** of any kind in this slice.
- **No governance flags** (orphan, single-owner-critical, archived-but-called, …) —
  later slices. This slice is ground-truth facts, not judgments.
- **`callerPolicy` / `callerIds` captured but not displayed** here (held for S5).
- The full **`seed:large`** synthetic generator is deferred to **S1b.1**; this slice
  ships a lightweight scale smoke-test instead.

## Contracts consumed

<!-- Links into contracts/ for every n8n API/event shape relied on. Probe first if missing. -->

- [`contracts/n8n-16-workflow-list-facts-shape.json`](../../contracts/n8n-16-workflow-list-facts-shape.json)
  — `GET /api/v1/workflows?limit=N`, the FULL list-item shape the analyzer reads.
  Non-destructive probe of the seeded estate (`scripts/probe-catalog.mjs`). Key
  findings: node facts come from the **top-level `nodes`** array (always present;
  `activeVersion` is null for 22/29 workflows); **MCP-exposed = `settings.availableInMCP`**
  (surfaced by the public API); sub-workflow refs are resource locators
  `{__rl, mode:"list", value:<id>}` where mode `list`/`id` both carry a **literal
  workflow id** (so the planted broken ref resolves correctly); `agentTool` may carry
  `workflowId: null` (no reference → emit nothing, never broken); typeVersion-1
  `executeWorkflow` uses a bare-string `workflowId`; `source:"parameter"` is inline
  (dynamic, no id).
- [`contracts/n8n-15-workflow-list-shape.json`](../../contracts/n8n-15-workflow-list-shape.json)
  — the S1a inventory fields (id, name, active, isArchived, updatedAt, shared→projectId).
- The vendored classification manifest is generated from the pinned n8n **2.29.0**
  source (`packages/nodes-base` credentials + nodes, `@n8n/n8n-nodes-langchain`) — a
  build-time artifact, not fetched at runtime. See `scripts/gen-manifest.mjs`.

## Acceptance criteria

<!-- Each is a concrete checkable behavior; each maps to a row in `pnpm verify`. -->

- [x] For every workflow the catalog reports node types, trigger types, credential
      types, external systems, data tables, and MCP-exposed — deterministically, no
      LLM (N workflows analyzed, 0 fabricated values).
- [x] Unknown node/credential types are recorded raw and marked `unknown`, never
      dropped and never given a fabricated label (rule 5).
- [x] Exactly the 2 seeded MCP-exposed workflows per instance are flagged
      (`settings.availableInMCP`); the MCP filter returns 2 per instance.
- [x] Outbound direct deps are detected from `executeWorkflow` / `toolWorkflow` /
      `agentTool` + `settings.errorWorkflow`, labeled by kind.
- [x] The Order Intake → Enrich Customer → Billing Service references resolve, and
      "Send Slack Alert" is depended on by exactly 5 workflows (fan-in of 5).
- [x] The one planted broken reference (Lead Scorer → a deleted id) is reported as
      **broken**, and it is the **only** broken ref — zero false positives across the
      whole estate and the corpus.
- [x] Dynamic references (expression-valued, `source=parameter`/inline, by-name, or
      `agentTool` with no id) are reported as **dynamic / unresolved**, never broken;
      the Plain-String Ref Caller resolves and the Inline Sub-Workflow Runner is
      dynamic.
- [x] Filter "everything touching Salesforce" returns the Salesforce workflows from
      **both** instances in one view.
- [x] The catalog is filterable by trigger type, instance, active/archived, and
      MCP-exposed — combinable — server-side.
- [x] Opening a workflow shows its facts + outbound direct deps with resolution
      state + an "Open in n8n" deep-link.
- [x] The verify report prints "understands X% of the real-template corpus, rest
      explicitly unparsed, zero false broken-refs", with a ranked breakdown of
      unknown node types.
- [x] Coverage is honest: understood + gaps = total; the floor only ratchets up.
- [x] The catalog stays snappy at ~1.5–3k workflows (list + detail queries timed).

**UI presence (standing rule 11 — this chrome is guarded, not just built).**
Each element carries a stable `data-testid`, a fast component test asserting it
renders with its key text/state (not appearance), and a `pnpm verify` row.
- [x] The catalog header shows the **coverage number**.
- [x] The catalog header shows the **polling freshness pill** ("Polling — updates
      within ~30s") and the **"synced N ago"** indicator (assert the static label,
      not the live timestamp).
- [x] The catalog shows every **filter control** — search, state (All/Active/
      Archived), MCP-exposed, instance, system, trigger.
- [x] The **connection-health indicator** renders on the Connections screen (a
      signed-off S1a element; it lives there, not in the catalog header).

**Responsive (standing rule 10 — both themes AND both widths).** Each hero view is
rendered in a real browser at 375px + desktop, in light AND dark, and asserted to
have no horizontal overflow (`documentElement.scrollWidth <= innerWidth`).
- [x] The **catalog list** is usable at 375px — the table reflows to stacked cards,
      no horizontal page scroll, no cut-off fields; the filter facets collapse behind
      a "Filters" control.
- [x] The **detail drawer** is full-width at 375px with no overflow.
- [x] The **login** view is usable at 375px with no overflow.

