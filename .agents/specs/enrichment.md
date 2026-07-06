# Enrichment (sense-making) — spec

<!--
One file per subsystem, kept in sync with code (standing rule 9).
Plain-English behavior contract — the product owner's review surface, not code.
PLAN.md is the master spec; this is its decomposition; the verify report is the
executable form of the Acceptance criteria below.
-->

This is the **S2** slice: the **meaning layer** on top of S1b's deterministic facts.
Facts say a workflow *uses an HTTP node and a Postgres credential*; they don't say
*what it does for the business* or *how much it matters*. For every workflow, Argus
asks one LLM (the user's chosen provider) for a **plain-English summary, a category, a
criticality with a reason, and advisory risk flags** — meaning someone new to the
estate can read and trust.

Two things make this safe enough to ship in a governance tool:
1. **The LLM never computes, only narrates.** Counts, dependencies, broken refs, and
   MCP exposure stay deterministic (S1b); the model phrases *purpose and importance*.
   When it can't, the row is a **labeled stub** that says "couldn't analyze" — never a
   fabricated answer (standing rule 5).
2. **Data minimization is the defense.** Only a strict, built-by-inclusion allowlist of
   safe fields leaves Argus — **never** parameter values, execution data, pinned data,
   or **any URL, hostname, or domain** (DECISION #26). A redaction backstop scrubs the
   free-text that does leave, and a planted-secrets test proves it before any live call.

All LLM access goes through **one provider-abstracting wrapper** (standing rule 6):
OpenAI **or** Anthropic, user-chosen, BYO key encrypted at rest, one active at a time,
model pinned per provider, **one prompt for both**. The reference provider for the
pre-registered H1 numbers is **OpenAI**; Anthropic is measured against the same bar.

## Behavior

<!-- Inputs → outputs, stated as assertions that must be true. -->

**Enrichment output (per workflow).**
- Every workflow Argus reports gets, from the LLM: a **summary** (what it does, plain
  English), a longer **description**, a **category** (closed enum below), a
  **criticality** (`critical | high | medium | low`) **with a reason that is always
  displayed next to the label** — never a bare level — plus advisory **risk flags**
  (enum array), a **suggested-owner rationale**, and **business context**.
- **Category** is a closed set: `revenue-ops`, `sales-marketing`, `customer-support`,
  `data-pipeline`, `integration`, `internal-ops`, `monitoring-alerting`, `ai-agent`,
  `other`. `other` is the honest bucket when nothing fits — never a forced guess.
- **Risk flags** are business-risk *judgments* the model infers from purpose, distinct
  from S1b's deterministic governance flags (orphan, broken_ref, …): `handles-pii`,
  `handles-financial-data`, `external-egress`, `customer-facing`, `production-write`,
  `compliance-sensitive`. They complement, never restate, the structural flags.
  **Status: experimental (S2 finding).** The first H1 measurement met the bar on
  summary/category/criticality but not on risk-flag precision (a label-agreement issue
  on a fuzzy field — see `EXPERIMENT.md`). Per the pre-registered miss decision, risk
  flags ship as **advisory/experimental**; summary + category + criticality are the
  trustworthy core.
- Each enriched row carries visible provenance: **provider + model + prompt-version**,
  and a **status**: `analyzed | stub | stale`.

**What leaves Argus — the strict allowlist (built by inclusion, DECISION #7 & #26).**
- Only these fields are ever sent: workflow **name**, **project**, **tags**, **trigger
  types**, **node names + types** (not parameters), a **connection-topology summary**
  (shape only), **credential types**, **failure stats**, and the **safe analyzer facts**
  (node count, mcp-exposed, broken-ref count, understood, and the **credential-/node-
  derived** external systems).
- **Never sent:** raw parameter values, pinned data, execution data, and — per
  **DECISION #26** — **any URL, hostname, or domain**. External-system identity comes
  from **credential types** (already mapped to systems); the analyzer may resolve
  domain→system locally for the catalog facet, but that resolved fact is **not**
  forwarded to enrichment. Nothing URL/host-derived leaves.
- A **redaction backstop** (regex families for keys/JWTs/tokens/connection-strings +
  Shannon-entropy) scans the **free-text fields only** (name, tags, node names) before
  storage and before any call — URLs need no scrubbing because they never enter.
- Workflow-derived text is delimited as **data** in the prompt (prompt-injection
  posture; injection cases live in the eval set).

**Provider abstraction (standing rule 6, DECISION #25).**
- One wrapper, two stable seams: **structured output against a Zod schema** (used by
  S2) and a **streaming tool loop** (declared now, built in S7). Enrichment only ever
  sees the structured-output seam; it never sees provider specifics.
- Switching the active provider (OpenAI ↔ Anthropic) and re-enriching **still works**,
  with the **same prompt**. Provider + model + prompt-version are recorded per row, so a
  provider switch invalidates and re-enriches.

**Lifecycle — idempotent, hash-gated, honest.**
- Argus re-enriches a workflow **only when the enrichment-input hash changes** (a hash
  of the allowlisted input). Renames and settings-only edits that don't bump n8n's
  `versionId` still change the hash → they re-enrich; nothing else does. A **re-run over
  an unchanged fleet makes 0 API calls.** A provider/model/prompt-version/schema bump
  invalidates all rows (a deliberate global re-enrich lever).
- Enrichment runs in a **background worker after each sync**, never blocking the
  freshness loop. Concurrency 3, retry-once on transient errors, a **per-run spend cap**,
  and **large-fleet prioritization** (active + recently-updated first) with a visible
  **progress state** ("enriched 400/3,000 — catalog fully usable, summaries filling
  in"). Enrichment **persists across the ~30s cache rebuild** — it is never thrown away
  and re-paid-for.
- **Failure → labeled stub.** After retry-once, a failed enrichment becomes a **stub**
  ("couldn't analyze this workflow"), never presented as analysis (rule 5). When the
  input changed but the worker hasn't caught up, the row is labeled **stale**. Spend-cap
  cutoff leaves the rest **pending** (honest), not stubbed.
- **Kill switch — two layers.** A **persisted in-app master switch** (toggled in
  Settings) is the owner's on/off control; `ENRICHMENT_ENABLED=false` is a **hard ops
  override** that force-disables it and locks the toggle. When off (either layer), or
  with no provider/key configured, Argus is a **fully functional deterministic** tool —
  catalog, facts, filters, coverage all work; the UI states the off/locked reason
  honestly, shows no fabricated content, and makes 0 calls. Enrichment-input building is
  also non-fatal: a per-workflow failure never breaks the core inventory sync.

**Corrections (a mutation, so it's audited — DECISION #6).**
- The owner can **one-click correct** a category or criticality label from the UI. Each
  correction writes an **audit entry in the same transaction** as the change; the
  correction is overlaid on the LLM output at read time. `audit_log` stays append-only.

**Evaluation (the pre-registered bar).**
- An eval scorecard scores enrichment against a labeled set (~50 self-labeled + a hand-
  labeled real-template slice + injection cases): **category accuracy**, **criticality
  within-one-level**, **risk-flag precision/recall**, **schema-parse rate** —
  **provider-parameterized, one bar (H1)**, reported per provider, not two goalposts.
  **`EXPERIMENT.md` pre-registers H1** (category ≥85% / criticality within-one ≥90% /
  risk-flag P ≥95% & R ≥80%) against the **OpenAI** reference **before any number is
  measured**. Anthropic's numbers are filled in when its key is available.

## Non-goals

<!-- What this subsystem deliberately does NOT do. Stops scope creep mid-session. -->

- **The LLM computes nothing.** No counts, no blast radius, no ownership, no broken-ref
  detection from the model — all of that is deterministic (S1b/S5). It only narrates.
- **No chat / streaming tool loop yet.** The second seam is declared but throws
  `not_implemented` until S7.
- **No third provider.** OpenAI + Anthropic only; no per-provider prompt forks.
- **No parameter-value egress**, even opt-in, in this slice. No URL/host/domain egress
  at all (DECISION #26).
- **No health/ownership scoring.** Criticality is the model's judgment of importance,
  not a computed governance score (that's S3/S4).
- **No blind-fleet generalization measurement** here — self-labeled eval + injection
  cases only; blind fleet comes later.

## Contracts consumed

<!-- Links into contracts/ for every n8n API/event shape relied on. Probe first if missing. -->

- [`contracts/n8n-16-workflow-list-facts-shape.json`](../../contracts/n8n-16-workflow-list-facts-shape.json)
  — the workflow list-item shape the allowlist reads (name, tags, nodes, settings). The
  same shape S1b's analyzer consumes; `excludePinnedData` on all fetches.
- `contracts/llm-openai-structured.json` — real OpenAI structured-output (json_schema
  strict) request/response, captured by the rule-1 probe (auth redacted). Pins the
  fast/cheap reference model id.
- `contracts/llm-anthropic-structured.json` — real Anthropic structured-output (forced
  tool_use) request/response, captured by the probe (or stubbed until a key is
  available). Pins Haiku 4.5.

## Acceptance criteria

<!-- Each is a concrete checkable behavior; each maps to a row in `pnpm verify`. -->

- [ ] Every workflow gets a summary, category, and criticality **with a reason** — or a
      labeled stub (N enriched, N stub, 0 fabricated).
- [ ] Criticality is **never shown without its reason** (asserted in the payload and UI).
- [ ] The enrichment input is a **strict allowlist**: no parameter values, no execution
      or pinned data, and **no URL / hostname / domain** ever appears in what is sent
      (DECISION #26).
- [ ] **Planted secrets never reach the model** — including a URL stuffed with a
      query-string token and `user:pass@` — proven by capturing the exact egress payload
      (both providers, one code path).
- [ ] The redaction backstop scrubs secrets pasted into **free-text** (workflow name,
      tags, node names).
- [ ] **Provider switch works:** enrichment runs on both OpenAI and Anthropic with the
      **same prompt**; switching the active provider re-enriches.
- [ ] **Re-run on an unchanged fleet makes 0 API calls** (hash-gated; hit/miss counts
      reported).
- [ ] A **rename-only** edit (no `versionId` bump) re-enriches; a settings-only edit that
      changes the allowlist re-enriches; nothing else does.
- [ ] A **provider / model / prompt-version / schema bump** invalidates and re-enriches.
- [ ] **Kill switch:** `ENRICHMENT_ENABLED=false` → catalog, facts, filters, coverage all
      work; UI shows "enrichment off"; **0 LLM calls**.
- [ ] Enrichment **survives the ~30s cache rebuild** (persisted, not re-fetched).
- [ ] **Failure → labeled stub** ("couldn't analyze"), never fabricated analysis; a
      changed-but-not-yet-processed row is labeled **stale**; spend-cap cutoff leaves the
      rest **pending**, not stub.
- [ ] **Large-fleet prioritization:** active + recently-updated workflows enrich first;
      a progress state ("enriched X/Y") is exposed.
- [ ] **One-click label correction** writes an **audit entry in the same transaction**;
      the correction shows in the catalog; `audit_log` rejects UPDATE/DELETE.
- [ ] The **LLM key is never returned** by any API and is stored **encrypted at rest**.
- [ ] The eval scorecard reports **category accuracy, criticality within-one, risk-flag
      P/R, schema-parse rate**, per provider against **one bar**; **`EXPERIMENT.md`** is
      committed with the pre-registered H1 target (OpenAI reference) **before** any
      measured number.

**UI presence (standing rule 11 — this chrome is guarded, not just built).**
Each element carries a stable `data-testid`, a fast component test asserting it renders
with its key text/state (not appearance), and a `pnpm verify` row.
- [ ] The **catalog** shows each workflow's **category** and **criticality** badges (and
      an honest empty/stub/stale/off state when not analyzed).
- [ ] The **detail drawer** shows the summary, business context, **criticality with its
      reason**, risk flags, and suggested-owner rationale — with a **correction** control.
- [ ] The **stub** ("couldn't analyze") and **stale** states are clearly labeled, never
      dressed as analysis.
- [ ] The **enrichment-progress** indicator renders next to coverage ("enriched X/Y").
- [ ] The **Settings** screen shows a **master on/off switch** (the kill switch),
      provider selection as clear cards with the **active provider plainly stated**, key
      entry, and honest off/unconfigured/ops-locked status (key never displayed back).

**Responsive (standing rule 10 — both themes AND both widths).** Each hero view is
rendered at 375px + desktop, in light AND dark, asserted to have no horizontal overflow.
- [ ] The **catalog with enrichment badges** is usable at 375px (badges reflow into the
      stacked card, no overflow).
- [ ] The **detail drawer** enrichment section is full-width at 375px with no overflow.
- [ ] The **Settings** screen is usable at 375px with no overflow.
