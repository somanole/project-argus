# Health — spec

<!--
One file per subsystem, kept in sync with code (standing rule 9).
Plain-English behavior contract — the product owner's review surface, not code.
PLAN.md is the master spec; this is its decomposition; the verify report is the
executable form of the Acceptance criteria below.
-->

This is the **S3** slice: a **live, trustworthy health status on every workflow**, and
**"what's failing across the estate" as one view**. The point is that you learn
something broke *from Argus* — not from a downstream complaint. Facts (S1b) say what a
workflow *is*; enrichment (S2) says what it *means*; health says whether it is
**working right now**.

Two things make this safe enough to ship in a governance tool:
1. **Health is computed deterministically from n8n's own execution history** —
   failure rate, last-run recency, and run durations over the retention window. The
   thresholds are **Argus's own, owned and unit-tested**; nothing is guessed.
2. **When the data isn't there, the status says so.** No executions in the window →
   **idle** ("no runs in the last ~14 days"), never "never runs". Executions
   unreachable (missing scope / error) → **unknown** with a reason, **never a green
   "healthy"** (standing rule 5).

Health is **poll-fresh**: it is recomputed on the same ~30s reconciliation loop that
syncs inventory. Real-time failure/waiting/resumed events wait on the deferred Log
Streaming receiver — until then, health is bounded by the poll interval, and a
stale/last-synced connection is **never mistaken for healthy**.

## Behavior

<!-- Inputs → outputs, stated as assertions that must be true. -->

**Health status (per workflow).** Computed from the executions in the retention
window; one of:
- **`failing`** — runs exist and the failure rate is **> 50%**.
- **`degraded`** — runs exist and the failure rate is **10%–50%** (inclusive of both
  ends' intent: some failures, not mostly-failing).
- **`healthy`** — runs exist and the failure rate is **< 10%**.
- **`idle`** — **0 runs in the retention window**; phrased against the horizon ("no
  runs in the last ~14 days"), never "never runs".
- **`unknown`** — executions couldn't be fetched for this instance (e.g. the API key
  lacks `execution:list`, or n8n errored). Honest, carries a reason, never healthy.

Thresholds (`DEGRADED_RATE = 0.10`, `FAILING_RATE = 0.50`) are **owned by Argus**,
live as named constants in the health module, and are unit-tested. `running` /
`waiting` / `new` executions are **excluded from the failure math** (a waiting run is
not a failure). Health is **execution-derived and orthogonal to active/archived** — a
disabled, manual-only workflow with only failing runs reads `failing`; the
active/archived config state stays a separate badge (S1b's `StateBadge`).

**Per-workflow health carries** its computed status plus the numbers behind it:
failure rate, runs-in-window, failures-in-window, last-run time, last-run status,
average duration (`stoppedAt − startedAt`; **null** when timestamps are absent —
never fabricated), the **window** it was computed against, and **when** it was
computed.

**Retention-horizon honesty.** All recency is bounded by n8n's execution pruning
(default `EXECUTIONS_DATA_MAX_AGE` **336h ≈ 14 days**, and a 10k count cap that can
shrink it further on busy fleets). The window is a per-connection value defaulting to
336h — n8n's documented default, **labeled as such in the UI**, not presented as a
measured fact. "Idle" and every recency phrase are stated against this window.

**"What's failing right now" — one estate view.** A single view lists the estate's
**failing** workflows (then **degraded**), each shown with **how critical it is** (the
S2 criticality label, reused). It shows a summary (how many failing / degraded /
healthy / idle), the **retention window**, and a **poll-fresh + honest-stale**
indicator. Ordering is by criticality, then failure rate. Owner/incident context is
**not** here — that is S4.

**Freshness, honestly (rule 5, PLAN Principle 2).** Health is served from cache and
carries its `computed-at`. If a connection is failing to sync (rejected key /
unreachable), the health surfaces say so — a not-syncing instance is shown as stale,
**never as a healthy green poll**. Health computation **never blocks or breaks
inventory sync**: a health-fetch failure degrades those workflows to `unknown` and the
core catalog is unaffected.

**Execution data minimization.** The health **poll** fetches executions **without**
`includeData` — Argus reads statuses and timestamps only, never payloads.

**Debugging a failure — on-demand, redacted (why it failed).** Opening a workflow's
drawer loads, **live and on-demand only** (never on the poll, never persisted): its
**recent runs** (status, time, duration, mode) each with a **deep link to that exact
run in n8n** (`/workflow/{id}/executions/{execId}`), and — for the most recent failed
run — a **redacted failure summary**: the **failing node's name** and the **error
type/code** (e.g. `Fetch Stripe Ledger — NodeApiError · ECONNREFUSED`). This one fetch
passes `redactExecutionData=true`, so n8n strips the error **message** and **all node
data server-side**; Argus reads an **allowlist of only** `lastNodeExecuted` +
`redactedError.{type,httpCode}` — never the message, never any payload. The full logs
and data stay in n8n, one click away. Data-minimization holds: on-demand, redacted,
allowlisted, not stored (contracts/n8n-18).

**Silent-failure detection — "green but broken" (S6.3).** A run can be **green while a step
silently failed** — a node errored and was swallowed (`onError: continueRegularOutput`,
legacy `continueOnFail`, or an error branch that dead-ends). Argus surfaces this as **facts**,
never a claim about whether the workflow did "the right thing" (rule 5):

- **Layer 2 — the dynamic "silently failing" signal (this spec).** For the workflows the
  Layer-1 flag marks (see the analyzer spec), Argus reports "**node X errored but the run was
  marked success, N of M inspected runs**", with the node named and the error **type/code**
  (e.g. `Push to Warehouse — Error · ECONNREFUSED`). It is an **orthogonal dimension**, not a
  status: a silent-failer's runs are `success`, so its status stays `healthy`/`idle` and the
  signal rides **alongside** the badge, never replacing it. Recency is bounded by the same
  retention window as S3.
- **The one relaxation (contract-verified, rule 1).** `contracts/n8n-23` proved that at n8n
  2.29 a swallowed node error is **invisible in the redacted execution detail** (the node
  reads `executionStatus: success`; redaction clears `item.json` to `{}`). So Layer 2 —
  **and only Layer 2** — reads the **un-redacted** detail for the flagged workflows, and Argus
  **allowlists it server-side to node name + error type/code ONLY** (never the message, stack,
  or any payload; the allowlisting lives in one client function and the raw detail is never
  persisted). A deliberate, narrow exception to the S3 "redaction is n8n-side" rule, scoped to
  the can-mask-failures workflows + on-demand in the drawer.
- **Selective fetch, never fleet-wide.** The poll inspects only the **can-mask-failures**
  workflows' recent **success** runs (capped per workflow) — a *necessary* precondition, so
  the scope is sound, not a sample. The drawer additionally computes it **live on-demand** for
  any opened workflow. A detail-read failure leaves the signal **null** ("not inspected"),
  never a fabricated "clean".
- **Honest boundary.** Absence of the signal means **"not observed silently failing"**, never
  **"verified clean"** — only flagged/opened workflows are inspected at all, and the UI says
  so. A Code-node swallow whose only detail is a message string is reported as **present**
  (node named) with a null type/code — the message is never surfaced. Detects "a node failed
  silently" (a fact); does **not** detect business-wrong-but-error-free results (out of scope).

## Non-goals

<!-- What this subsystem deliberately does NOT do. Stops scope creep mid-session. -->

- **No real-time events.** Failure/waiting/resumed via Log Streaming is deferred;
  health is poll-fresh only, and says so.
- **No detection of what redaction hides.** Layer 2 reports only what the un-redacted detail
  exposes as an allowlisted class; it never reconstructs or stores payloads/messages.
- **No ownership or incident package.** The failing view shows health + criticality,
  not owners, downstream impact, or recent-change context — that is **S4**.
- **No fleet-level Insights corroboration.** The owner-key `insights/summary` opt-in is
  not required or used here; per-workflow health is Argus-computed from executions.
- **No formal scale pass.** Built against the current ~200-workflow seed; the
  1.5–2k Argus-only stress is **S6.2**.
- **No health *scoring*.** A single status per workflow, not a composite governance
  score (that composition is S6).
- **The health service computes nothing the LLM touches** — it is fully deterministic.
- **No raw logs, messages, or payloads in Argus.** The drawer shows the *redacted
  classification* (failing node + error type/code) and deep-links to n8n for the
  actual logs/data. Execution debug is on-demand and never persisted — Argus does not
  become an execution-log store.

## Contracts consumed

<!-- Links into contracts/ for every n8n API/event shape relied on. Probe first if missing. -->

- [`contracts/n8n-17-executions-list.json`](../../contracts/n8n-17-executions-list.json)
  — real `GET /api/v1/executions` request/response (cursor-paginated; item `status`,
  `startedAt`, `stoppedAt`, `workflowId`, `finished`, `mode`), captured by the rule-1
  probe. Fetched without `includeData`, with `redactExecutionData=true`. The health
  service codes against this shape, never against memory of n8n.
- [`contracts/n8n-18-execution-redacted.json`](../../contracts/n8n-18-execution-redacted.json)
  — real `GET /api/v1/executions/{id}?includeData=true&redactExecutionData=true`: the
  redacted single-execution detail the **drawer** reads on-demand. Confirms the debug
  signal that survives redaction (`resultData.lastNodeExecuted` +
  `resultData.redactedError.{type,httpCode}`) and that the message/payload are stripped.

## Acceptance criteria

<!-- Each is a concrete checkable behavior; each maps to a row in `pnpm verify`. -->

- [ ] The seeded **always-failing critical** workflow (`Daily Stripe Reconciliation`,
      4 error / 0 success) reads **failing**.
- [ ] The seeded **flaky** (`Zendesk Sync`) and **alternating** (`Data Quality
      Sentinel`) workflows (3✓/3✘ each) read **degraded**.
- [ ] An all-success seeded workflow (`Order Intake`) reads **healthy**.
- [ ] A workflow with **no runs** in the window (`exec: none`, e.g. `Send Slack Alert`)
      reads **idle**, phrased against the retention window — not "never runs".
- [ ] Health is **execution-derived**: the failing manual/inactive workflow still reads
      `failing` (active/archived does not override the failure signal).
- [ ] Executions **unreachable** (no `execution:list` scope) → workflows read
      **unknown** with a reason; the **inventory sync still succeeds** (catalog intact).
- [ ] Average duration is **null** (not fabricated) when execution timestamps are
      absent; status is still computed.
- [ ] The **retention window** (336h ≈ 14 days) is reported per instance and **shown in
      the UI**, labeled as n8n's default (not a measured fact).
- [ ] The **"what's failing"** feed lists failing then degraded workflows, each with its
      **criticality** (from S2), ordered by criticality then failure rate, plus a
      summary count.
- [ ] **Freshness honesty:** when a connection is failing to sync, the health surface
      reports it stale/not-syncing — **never healthy** (rule 5).
- [ ] Health is **poll-fresh**: recomputed on the reconciliation loop; a health-fetch
      failure never breaks the freshness loop.
- [ ] Opening a workflow shows its **recent runs** with per-run **n8n deep links**
      (`/workflow/{id}/executions/{execId}`) and, for the latest failed run, a
      **redacted failure summary** (failing node + error type/code) — fetched
      on-demand, **never** the message/payload, **never** persisted.
- [ ] The execution-debug fetch **degrades honestly** to "unavailable" (with a reason)
      when executions can't be read — never a fabricated/empty run list shown as truth.

**Silent-failure detection (S6.3 Layer 2).**
- [ ] The rule-1 probe `contracts/n8n-23` is captured and records the finding: a swallowed
      node error is **invisible under redaction** at n8n 2.29, so Layer 2 reads the
      **un-redacted** detail and allowlists to node name + error type/code only.
- [ ] The seeded **green-but-swallowing** workflow (`Inventory Sync`) reads as **silently
      failing** with the offending node named (`Push to Warehouse`) and the error class,
      even though n8n marks every run `success`.
- [ ] A seeded **mask-prone but healthy** workflow (`Resilient Notifier`) shows the
      **can-mask-failures** advisory flag but **no** silent-failure signal; a genuinely
      healthy control (`Order Intake`) shows **neither**.
- [ ] The silent-failure signal is **allowlisted**: node name + error type/code only —
      **no** error message, stack, or payload ever appears in Argus's output or storage.
- [ ] Absence of the signal is **"not observed"**, not "clean": only can-mask (poll) /
      opened (drawer) workflows are inspected, and a detail-read failure leaves it null.

**UI presence (standing rule 11 — this chrome is guarded, not just built).**
Each element carries a stable `data-testid`, a fast component test asserting it renders
with its key text/state (not appearance), and a `pnpm verify` row.
- [ ] The **catalog** shows a **health badge** per workflow
      (`health-badge`: failing/degraded/healthy/idle/unknown) and a **health facet**
      (`filter-health`).
- [ ] The **Health view** (`health-view`) shows a **summary strip whose tiles are the
      primary filter** (`health-tile-failing` / `-degraded` / `-healthy` / `-idle`, plus
      `-unknown` when any instance's executions are unreadable) — same stat-tile style and
      click-to-filter behaviour as the Ownership register, so the two Estate views read as
      one system. Clicking a tile switches the single **list** (`health-failing-list`) to
      that health state (default **failing**); **healthy and idle are browsable too**, not
      just counts. Criticality rides along, the **retention window** (`health-window`) and a
      **poll-fresh/honest-stale** indicator (`health-freshness`) are shown, and the list is
      **paginated** (the shared `ListPager`, 50/page). Empty state is reassuring for the
      problem views ("Nothing failing right now"), neutral otherwise ("No idle workflows…").
      For **consistency with the Ownership register**, the view also carries an instance
      **scope** (`health-scope`) + **search** (`health-search`) that narrow the active tile's
      list; the tiles stay **estate-wide** (like Ownership's summary-over-all), so their counts
      don't jump as you scope.
- [ ] The **detail drawer** shows a **health section** (`health-section`): status,
      failure rate, last run, average duration, window, and checked-N-ago — and, on
      demand, the **recent-runs list** (`execution-runs`) + the **redacted failure
      summary** (`execution-failure`) with deep-links into n8n.
- [ ] **Health-list rows are clickable** — opening the same detail drawer (the
      debugging surface); existing chrome unchanged (additive, rule 11).
- [ ] A new top-nav **"Health"** item routes to the view; existing chrome is unchanged
      (additive only, rule 11).
- [ ] **S6.3:** the catalog/drawer health badge carries an **additive silent-failure
      overlay** (`health-silent-badge`) when a green run swallowed a node error — it never
      replaces the status pill. The **drawer** shows the silently-failing box
      (`health-silent-failure`, node + count + error class) and the advisory
      **can-mask-failures** flag (`can-mask-flag`, offending node + the exact n8n On-Error
      config). The **Health view** adds a **silently-failing tile** (`health-tile-silent`)
      and a **can-mask-failures tile** (`health-tile-can-mask`, muted — a config-risk kept
      distinct from the live health-state tiles), each filtering the list. Both signals are
      also **Explore facets** (`filter-can-mask`, `filter-silently-failing`) and silently-
      failing is an **Overview tile** (`overview-silently-failing`). All additive (rule 11).

**Responsive (standing rule 10 — both themes AND both widths).** Each hero view is
rendered at 375px + desktop, in light AND dark, asserted to have no horizontal overflow.
- [ ] The **catalog with the health badge/column** is usable at 375px (badge reflows
      into the stacked card, no overflow).
- [ ] The **Health view** (failing list + summary) is usable at 375px with no overflow.
