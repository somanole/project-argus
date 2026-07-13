# Governance overview — spec

<!--
One file per subsystem, kept in sync with code (standing rule 9).
Plain-English behavior contract — the product owner's review surface, not code.
PLAN.md is the master spec; this is its decomposition; the verify report is the
executable form of the Acceptance criteria below.
-->

This is the **S6** slice, and it **closes the core**. S1b–S5 each answered one
question about the estate — what's running, what it means, what's failing, who's
accountable, what's the blast radius. S6 is the **one screen that composes all of
them** into "here's the state of our estate": a governance dashboard a platform
owner reads at a glance, drills into, trusts, and exports.

**The discipline of the slice: composition, never divergence.** Every figure on
this screen is a query that *already exists* from S1b–S5. S6 adds **no new
analysis** — it is a view layer over the existing reads (`governanceGaps()`,
`healthEstate()`, `coverageOf()`, `facets()`, `listAudit()`). The one genuinely new
computation is the **governance score**, and it too is composed deterministically
from those same reads. The invariant: **a number on the dashboard is byte-for-byte
the same query result the individual view shows** — the dashboard composes, it
never re-derives, and it can never drift from its source view. This invariant is
tested (a non-divergence test), not asserted.

**Honesty is preserved through the composition (rule 5).** The estate's built-in
uncertainty is never laundered into false precision. In particular, **factual
ownership means an explicitly ASSIGNED owner** — confirming ownership is a core job
of Argus, and **inferred ownership is advisory only: a lead for who to confirm, never
a substitute.** So an inferred-only (or unowned) workflow is **not counted as owned**
by the score or by any "has an owner" figure; the inferred suggestion is still shown,
as a hint to act on. Likewise: unreadable / poll-stale health is **excluded** from
the score (never scored as "healthy") and surfaced separately; `possible`
blast-radius and MCP-reach edges are **excluded** from every exposure count
(confirmed-only, per S5's trust spine); every figure carries its freshness.

## Behavior

<!-- Inputs → outputs, stated as assertions that must be true. -->

**One composed overview payload.** A single backend read, `governanceOverview()`,
composes the existing S1b–S5 reads into one payload behind `GET
/api/governance/overview`: the governance score + its full pillar breakdown, and
every headline figure with the **exact workflow set behind it** (so every number is
drillable). It calls the *same* repo functions the individual views call — it does
not re-query n8n or re-run any analysis. It carries a single `generatedAt` plus the
per-source freshness (health poll windows, enrichment last-run) so staleness is
visible, never hidden.

**The governance score — deterministic, explainable, drillable (the one new
computation).** A single estate score **0–100**, computed as a weighted average of
**five pillars**, each itself 0–100 and each drillable to the workflows that
produced it. The score is a pure function of the current composed reads — same
inputs always yield the same number — and **every pillar exposes its inputs**, so
the headline is never a black box.

| Pillar | Weight | Scored from |
|---|---|---|
| **Ownership** | 30% | Share of workflows with a **confirmed (assigned) owner**, criticality-weighted (critical ×3, high ×2, medium/low ×1). An unowned *critical* costs far more than an unowned *low*. **Inferred ownership is advisory only and does NOT count** — a workflow that is only inferred, or unowned, is not owned; only an explicit assignment is ownership. |
| **Reliability** | 25% | Penalizes **failing** (and, half-weight, **degraded**) among active workflows, criticality-weighted. Workflows whose health is **unknown/unavailable** (unreadable executions, missing scope) are **excluded from the denominator** — never scored as healthy — and reported separately. Idle counts as neither pass nor fail. |
| **Accountability resilience** | 20% | Over the estate's **critical** workflows, penalizes each one that lacks resilient accountability: **no assigned owner at all** (the worst case — nobody accountable), a **single-point-of-failure owner** (one person owning many criticals), or **no backup owner**. Reports **"couldn't score"** only when there are no *known* critical workflows (criticality not yet analyzed) — never for criticals that are merely unowned. |
| **Hygiene** | 15% | Penalizes **broken references**, **stale enrichment**, **personal-space-critical** workflows, and **active workflows with no executions** in the retention window. |
| **Exposure** | 10% | Penalizes **MCP-exposed workflows reaching sensitive systems** (S5 forward-reach, **confirmed edges only**), weighted worse when the exposed workflow is **unowned**. |

Weights are fixed defaults, defined in one place, surfaced in the breakdown. The
score rounds for display but the breakdown shows each pillar's raw sub-score and the
counts that drove it. **When a pillar has no measurable inputs** (e.g. health
entirely unavailable estate-wide), that pillar reports **"couldn't score"** and is
dropped from the weighted average with its weight redistributed — never silently
counted as 100 (rule 5).

**Every headline figure, and every figure drills to its exact workflows.** The
dashboard surfaces, each with a count that opens the precise set behind it:

- **Governance score** + the five-pillar breakdown (each pillar drills to its
  contributing workflows).
- **Unowned by criticality** — unowned workflow counts split critical / high /
  medium / low; drills to that filtered catalog set.
- **Single-point-of-failure owners** — owners holding ≥2 criticals, cross-instance
  span flagged; drills to that owner's workflows.
- **Failing** — the raw count of **`failing`-status** workflows (failure rate > 50% in the
  health window). No degraded, no ownership qualifier — just "how many are mostly-failing
  right now"; drills to the Health view. *(The owner-subset figure `failingWithOwner` is still
  composed in the payload and pinned by the non-divergence check, but is no longer the headline
  tile — the owner wanted the plain failing count front-and-centre.)*
- **Hygiene issues** — broken refs, stale enrichment, active-no-executions counts;
  each drills to its set.
- **MCP exposure surface** — MCP-exposed workflows, how many reach sensitive
  systems (confirmed-only), how many of those are unowned; drills to the set.
- **Personal-space-critical** — criticals living in personal projects that belong in
  team projects; drills to the set.
- **Fleet changelog + audit timeline** — the recent estate changes (ownership
  assignments, corrections, config) from the append-only audit log, newest first,
  with a link to the full filterable timeline (S4's).

**Tile mechanics (navigate to the owning page, never reproduce it).** The dashboard
is a glanceable router, not a place that reproduces detail. Each figure is a **uniform
metric tile** — label + ⓘ tooltip, a count coloured by severity (a problem count reads
warn/danger; a **clean zero reads green** — 0 of a problem is a positive signal), a
one-line context — and the **whole tile navigates** to the page that owns
that set, **deep-linked** to exactly it:
- Accountability tiles → the **Ownership** view, anchored to the matching gap section
  (`#gap-unowned`, `#gap-single-owner`, `#gap-personal-space`).
- Failing (the raw count of `failing`-status workflows — no degraded, no ownership qualifier)
  → the **Health** view.
- **Silently failing (S6.3)** → Estate `?silentlyFailing` — green runs that swallowed a node
  error. Warn-toned; the tooltip states it's *observed among the workflows inspected*, not a
  full-fleet guarantee (rule 5). `count === list.length` pinned like every other figure.
- Broken refs → Estate `?broken`; stale analysis → Estate `?stale`; idle-but-active →
  Estate `?health=idle&active=true`; MCP exposure → Estate `?mcp` (the MCP-exposed set).
The composition guarantee still holds — the composed payload carries the exact set
behind every count, and `count === list.length` per figure is pinned by test, which is
what makes each deep-link honest (the number leads to precisely that set). The longer
"why" prose and every uncertainty caveat (advisory inferred owner, confirmed-reach-only)
live in the tile's **ⓘ tooltip**, off the surface but one hover away. *(Build note:
redesigned from inline drill-down to deep-linking after the owner asked for a cleaner,
uniform surface — every widget now behaves the same way and points to its page rather
than expanding in place. Two Estate catalog filters — `stale`, and `idle-active` via the
existing `health`+`active` filters — were added so "deep-link everything" lands on the
exact set, not merely near it.)*

**Unowned and the Ownership score agree by construction.** Both key on the same
notion — *assigned* ownership. The **unowned figure** counts workflows with no
assigned owner (matching the Governance view exactly), and the **Ownership pillar**
scores the assigned share, so a high unowned count means a low ownership score, as it
should. Where a workflow has an inferred suggestion, the unowned card surfaces it as a
**hint to confirm** ("Argus can suggest an owner — inference is a lead, not
ownership; assign a person to close the gap"), never as ownership already achieved.

**Export — a structured, readable compliance report.** `GET
/api/governance/export` produces a structured governance report of the current
estate state: the score + pillar breakdown, each gap category with its workflows,
the exposure surface, and the freshness stamps — as a readable **Markdown report**
(human-readable, hand-to-a-colleague) plus the existing **audit CSV** for the
timeline. The report is generated from the same composed payload, so it matches the
screen exactly.

**Read-at-a-glance quality.** The screen is legible without a tour: each figure
states in plain English what it means and why it matters, the score shows its
composition, and uncertainty is labelled inline (advisory owner, health
unavailable, `possible` excluded). This is the demo surface (D / DEMOS.md), so it
must be genuinely demo-quality in both themes and at both widths.

## Non-goals

<!-- What this subsystem deliberately does NOT do. Stops scope creep mid-session. -->

- **No new analysis.** S6 computes nothing about a workflow that S1b–S5 didn't
  already compute. The score is a composition of existing reads; if a figure needs a
  fact that doesn't exist yet, that's out of scope — flag it, don't invent it.
- **No divergent source of truth.** The dashboard never re-implements a count with
  its own query. It calls the same repo functions the views call; the non-divergence
  test guards this.
- **No false precision.** Inferred ownership stays advisory, unavailable health stays
  unavailable, `possible` edges stay excluded from factual counts. No pillar is
  silently scored 100 on absent data.
- **No LLM.** The score and every figure are 100% deterministic. The model never
  computes a governance number.
- **No restructuring of existing views (rule 11).** Deep-link preset reading is
  strictly additive; Catalog/Health/Graph/Governance chrome is not removed or
  rewritten. If scoped work genuinely forces touching existing chrome, stop and flag
  it first.
- **No mutation.** S6 is read-only over Argus's own reads (which are themselves
  read-only over n8n). It assigns nothing, corrects nothing; it links to the S4
  surfaces that do.
- **No fuzzy identity.** SPOF is exact-email (S5/S4 semantics). Cross-instance
  person-merge is S8; the score treats `alice@a` and `alice@b` as distinct owners
  and says so.
- **No chat surface** — narrating the estate via chat is S7.

## Contracts consumed

<!-- Links into contracts/ for every n8n API/event shape this relies on. Probe first if missing. -->

S6 consumes **no new n8n API shape** — it is pure composition of Argus's own
existing reads, which already sit on captured contracts. It relies transitively on:

- [`contracts/n8n-16-workflow-list-facts-shape.json`](../../contracts/n8n-16-workflow-list-facts-shape.json)
  — the workflow facts/catalog shape (S1b) that ownership, criticality, MCP, and
  broken-ref figures read.
- The S3 execution/health contracts and S4 user/project contracts already captured
  for those slices — health status and inferred-owner inputs flow through unchanged.
- The append-only `audit_log` (Argus-internal, sacred) for the changelog/timeline.

No probe is required for S6; if any consumed read's underlying contract has drifted,
that slice's own probe/verify catches it first.

## Acceptance criteria

<!-- Each is a concrete checkable behavior; each maps to a row in `pnpm verify`. -->

**Composition & non-divergence (the point of the slice).**
- [x] The overview payload's headline counts **equal the source reads** —
      unowned-by-criticality equals `governanceGaps().unowned`, failing-with-owner
      equals the owned subset of `healthEstate().failing`+`degraded`, MCP-exposure
      equals the confirmed S5 reach — asserted by a non-divergence test that computes
      each figure both ways and requires equality.
- [x] Every headline figure's count **equals its exact workflow set** (N == list
      length, tested per figure) — the composition guarantee that makes each tile's
      deep-link honest (the number leads to precisely that set).
- [x] The dashboard reads correctly against the **seeded estate** — the planted
      problems (unowned criticals, prod↔staging SPOF, personal-space criticals,
      MCP-to-sensitive) all appear with non-zero, sane counts.

**Governance score (deterministic, explainable).**
- [x] The score is a **pure function** of the composed inputs — same inputs yield the
      same number (determinism test).
- [x] The score exposes a **five-pillar breakdown** (ownership / reliability /
      resilience / hygiene / exposure) with each pillar's sub-score and the counts
      that drove it — no black-box number.
- [x] **Only ASSIGNED ownership is factual** — an inferred (or unowned) workflow is
      **not** counted as owned by the ownership pillar, the resilience pillar, the
      exposure `owned` flag, or the failing-with-owner figure; the inferred suggestion
      is shown only as an advisory hint to confirm (tested).
- [x] **Unavailable health is excluded** from the reliability pillar (never scored
      healthy) and surfaced separately; a pillar with no measurable inputs reports
      **"couldn't score"** and is dropped from the average, weight redistributed
      (tested — no silent 100).
- [x] `possible` edges are **excluded** from the exposure pillar and the MCP-exposure
      figure (confirmed-only, S5 invariant re-asserted at the dashboard).

**Export.**
- [x] `GET /api/governance/export` returns a **structured, readable report** (score +
      breakdown + gaps + exposure + freshness) that **matches the screen** (generated
      from the same composed payload), plus the audit CSV.

**UI presence (standing rule 11 — this chrome is guarded, not just built).**
Each element carries a stable `data-testid`, a fast component test asserting it
renders with its key text/state, and a `pnpm verify` row.
- [x] The **/overview view** renders with the **governance score** and its five-pillar
      breakdown (`overview-view`, `overview-score`, `overview-score-breakdown`).
- [x] Each metric is a **uniform tile** that **navigates** to its exact set — no inline
      drill. Accountability tiles deep-link to the Ownership gap sections
      (`overview-unowned` → `#gap-unowned`, `overview-spof` → `#gap-single-owner`,
      `overview-personal-space` → `#gap-personal-space`).
- [x] **Failing** (`overview-failing`, the raw `failing`-status count — no degraded, no
      ownership qualifier) → Health.
- [x] The three **hygiene** metrics render as peer tiles and deep-link to the filtered
      Estate catalog: `overview-broken` → `?broken`, `overview-stale` → `?stale`,
      `overview-idle-active` → `?health=idle&active=true`.
- [x] **MCP exposure surface** (`overview-exposure`) → Estate `?mcp` (the MCP-exposed set).
- [x] **Recent activity** renders newest-first with "View all →" to the Activity view
      (`overview-changelog`).
- [x] An **export** control renders and downloads the report (`overview-export`).
- [x] Uncertainty is **preserved, one hover away**: the advisory-owner and
      confirmed-reach-only caveats live in the tiles' ⓘ tooltips (`infotip`), and the
      health-unavailable banner still renders on-surface (`overview-health-unavailable`)
      — nothing laundered.

**Responsive (standing rule 10 — both themes AND both widths).** The overview view is
rendered in a real browser at 375px + desktop, in light AND dark, asserted no
horizontal page overflow.
- [x] The **overview view** is usable at 375px — score card and section cards reflow,
      no horizontal page scroll — and in both themes (vendored tokens only).
</content>
</invoke>
