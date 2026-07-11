# Relationships & blast radius (graph) — spec

<!--
One file per subsystem, kept in sync with code (standing rule 9).
Plain-English behavior contract — the product owner's review surface, not code.
PLAN.md is the master spec; this is its decomposition; the verify report is the
executable form of the Acceptance criteria below.
-->

This is the **S5** slice. S1b answered "what does *this one* workflow reference?"
(direct deps, resolved/broken/dynamic — stored per workflow). S5 adds the
**cross-workflow layer**: it stitches every workflow's references into one
**fleet-wide directed dependency graph**, detects the edges that only exist
*between* workflows and *between* instances, attaches a **confidence** to each edge,
and answers impact questions — "what breaks if this fails?", "what does rotating
this credential touch?" — with explicit, trustworthy totals. Plus the hero graph UI.

**The trust spine (the point of the slice).** A wrong "X depends on Y" is the
fastest way to lose a governance tool. So every edge carries a confidence —
`confirmed` (n8n literally wired it) or `possible` (inferred) — and **`possible`
edges render distinctly and NEVER appear in a factual impact count** (rule 5). This
is measured (H3), not asserted.

## Behavior

<!-- Inputs → outputs, stated as assertions that must be true. -->

**Edges (the cross-workflow layer, each with a confidence).** Argus builds a
directed graph over the whole estate. An edge's direction is **source → target =
"source depends on / calls / uses target"**. Edge types:

- **`call`** *(confirmed)* — `executeWorkflow` sub-workflow calls (from S1b's
  resolved `subWorkflow` direct deps).
- **`tool`** / **`agent_tool`** *(confirmed)* — `toolWorkflow` / `agentTool` calls.
- **`error_workflow`** *(confirmed)* — `settings.errorWorkflow`.
- **`caller_policy`** *(confirmed)* — `settings.callerIds` under
  `callerPolicy: workflowsFromAList` (who is *allowed* to call this workflow).
- **`webhook_http`** *(possible, intra-instance)* — an HTTP Request URL whose host is
  *this* instance and whose path matches a webhook `path` in the same instance.
  Expression-valued URLs or webhook paths → unmatchable → **no edge** (never a guess).
- **`cross_instance_webhook`** *(confirmed when host known, else possible)* — an HTTP
  Request in instance A whose URL host matches **another** connection's known
  `webhook_host` **and** whose path matches a webhook in that instance. The host
  disambiguates, so a matched edge is `confirmed`; unknown host → `possible`. This is
  the estate-level "prod depended on by staging" finding.
- **`binds_credential`** / **`binds_datatable`** *(confirmed)* — a workflow node
  genuinely binds a credential id / references a data table. Credentials and data
  tables are **first-class graph nodes**; these binding edges are what
  "rotate this credential — what breaks?" traverses.
- **`shared_credential`** / **`shared_datatable`** *(possible, association not
  dependency)* — a derived workflow↔workflow relation ("both use resource R"), used
  only for shared-resource SPOF/clustering visuals. **Never counted in impact.**

Broken references (found in S1b) stay **node badges**, not phantom edges — a broken
ref has no valid target to point at.

**Extraction (build on S1b, do not redo it).** S1b already extracts and resolves the
call/tool/agent/error references. S5 adds the endpoint facts S1b deliberately held
back, in the same analyzer pass (facts schema bumped so it recomputes cleanly):
webhook **paths** (from `n8n-nodes-base.webhook` / form triggers), HTTP Request
**host + path** (from `n8n-nodes-base.httpRequest` `parameters.url`, expression-aware),
credential **ids** per node (S1b captured only credential *types*), and resolution of
the data-table refs S1b captured but left unresolved. Anything expression-valued or
otherwise unknowable stays unmatchable — no edge.

**Estate-wide edge pass.** After the per-connection sync loop completes, one pass
loads all workflows across all instances and builds edges in memory. This is the only
place cross-instance edges can be computed (they need every connection's
`webhook_host`). Edges live in a **disposable cache table** (`workflow_edges`),
rebuilt every cycle; sacred tables are never touched.

**Impact analysis — edge-type-aware BFS, confirmed-only totals.**
- *"What breaks if X fails?"* → reverse-BFS over `call` / `tool` / `agent_tool` /
  `error_workflow` / `cross_instance_webhook` edges (X's transitive callers),
  **confirmed only**, returning the affected set **and an explicit total**
  ("N affected, nothing else").
- *"Rotate credential C — what breaks?"* → the workflows binding C (confirmed
  `binds_credential` edges) — a **different** answer than the failure query.
- *"Deprecate sub-workflow X"* → X's callers.
- A `possible` edge (a webhook guess, a shared-credential association) is **excluded**
  from every one of these totals.

**MCP exposure-reach.** For each MCP-exposed workflow (S1b fact), Argus computes the
forward-reachable set — the credentials, external systems, and sub-workflows an
external caller can touch through it — via forward BFS. Surfaced as the graph's
"highlight MCP exposure" mode and feeds the S4 `mcp_exposed_sensitive` signal.

**Graph views (scale-designed).** The graph endpoint serves **scoped** views so the
client never renders thousands of raw nodes: a workflow's N-hop **neighborhood**, a
single **instance**, a **system cluster**, and the **estate** (all instances,
clustered by instance). Instance is a first-class dimension. The **UI scope switcher
surfaces instance / system / estate** — the neighborhood view was removed from the UI
(it wasn't pulling its weight); the endpoint still supports it. Nodes are colored by
**health** (reusing S3's mapping) and badged (AI-agent / broken-ref / archived /
MCP-exposed). **Node kinds read apart at a glance:** a workflow shows its health color on
the left accent; a **credential is distinct — a purple (secondary) accent + a key icon**;
a data table carries a database icon. Edges are styled by **type and confidence** —
`possible` visibly distinct, **cross-instance edges visually prominent**, archived dimmed
and hidden by default. Clicking a node highlights its blast radius (edge-type-aware) with the
impact answer + explicit total shown in plain English; the selected workflow and every
workflow in its blast radius are **clickable into the shared workflow detail drawer**,
and the blast-radius list grows with the panel (which scrolls) rather than clipping.

**Estate layout reads as a constellation, not a column.** A fleet is fan-out heavy —
a few shared utilities/credentials called by many workflows, and many workflows that
reference nothing. The estate view lays connected dependency clusters out in 2D (a
deterministic force-directed pass) with the reference-nothing workflows packed into a
tidy grid beside them, so the graph **fills the canvas** (width *and* height) and every
node stays a real, legible, clickable size — never a centred hairline. A **zoom / pan
affordance** (scroll + drag, plus explicit +/−/Fit buttons) lets the user navigate a
dense estate and always recover the full view. The layout is deterministic: the same
graph payload always frames identically.

**Independent oracle (dev/demo).** Argus's `confirmed` call/error edges are
cross-checked against n8n's own `workflow-index` dependency index
(`POST /rest/workflow-dependencies/details`) on the seeded estate — independent
confirmation on exactly the edges where a wrong answer kills H3.

## Non-goals

<!-- What this subsystem deliberately does NOT do. Stops scope creep mid-session. -->

- **Not redoing S1b.** Per-workflow reference extraction/resolution already exists;
  S5 consumes it and adds only the cross-workflow layer.
- **No LLM.** The graph and impact analysis are 100% deterministic; the model never
  computes blast radius (Principle 1).
- **No `possible` edge in any factual number.** They exist for visualization and
  SPOF clustering only.
- **No chat `impact_analysis` tool** — that surface is S7. S5 exposes impact via the
  API + graph UI.
- **No cross-instance *identity* resolution** (people) — that is S8. S5 resolves
  cross-instance *webhook* edges (machines), not humans.
- **No new governance scoring / dashboard** — that is S6. S5 surfaces edges, impact,
  and the graph.
- **No live-event freshness** — edges refresh on the existing ~30s poll (the Log
  Streaming receiver stays deferred).

## Contracts consumed

<!-- Links into contracts/ for every n8n API/event shape relied on. Probe first if missing. -->

- **`contracts/n8n-20-graph-shapes.json`** *(new — probe first, rule 1)* — captures,
  from the real seeded estate: (a) the **workflow-index oracle**
  `POST /rest/workflow-dependencies/details` + `/counts` request/response (internal
  REST, cookie auth; the cross-check), and (b) the real node shapes S5's extraction
  reads — `n8n-nodes-base.webhook` `parameters.path`, `n8n-nodes-base.httpRequest`
  `parameters.url`, and credential-binding (`node.credentials`) with ids.
- [`contracts/n8n-16-workflow-list-facts-shape.json`](../../contracts/n8n-16-workflow-list-facts-shape.json)
  — the S1b list-item shape (nodes, settings, callerPolicy/callerIds) S5 builds on.
- The vendored classification manifest (build-time, pinned n8n 2.29.0).

## Acceptance criteria

<!-- Each is a concrete checkable behavior; each maps to a row in `pnpm verify`. -->

**Impact & edges (the H3 core).**
- [x] "What breaks if **Send Slack Alert** fails?" returns **exactly its 5 callers**,
      and the answer states the total explicitly ("5 affected, nothing else").
- [x] The **prod↔staging cross-instance edge** is detected — Staging's
      "Staging → Prod Order Sync" → Prod's "Order Intake" webhook — and marked
      **`confirmed`** (host known).
- [x] A **`possible` edge** (an intra-instance webhook guess) is **excluded** from
      blast-radius totals — reported as `possibleExcluded`, never in `total`. (Unit
      test proves the invariant; verify asserts a possible-edge target's blast radius
      counts confirmed-only.)
- [x] "**Rotate** credential C" returns the set of workflows binding C — a
      **different** answer than "what breaks if it fails" — traversing credential
      (not call) edges.
- [x] Expression-valued HTTP URLs and expression-valued webhook paths produce **no
      edge** (never a guess). (endpoints unit tests.)
- [x] Argus's `confirmed` call/error edges **match n8n's workflow-index** dependency
      details on the seeded estate (independent oracle cross-check).
- [x] The three transitive sub-workflow chain (Order Intake → Enrich → Billing) is a
      connected path; archived-still-called renders as a live edge to a dimmed
      archived node.
- [x] MCP exposure-reach: forward reachability unions the reachable systems/credentials
      and flags `reachesSensitive`. (endpoint + graph mode.)

**Graph API & scale.**
- [x] The graph endpoint serves scoped views (neighborhood / instance / system /
      estate); neighborhood is a bounded BFS, estate is node-capped with all
      cross-instance edges kept (`truncated` flag when capped — no silent cap).
- [x] Graph build + impact queries stay responsive on the seeded estate (~200) and the
      estate view is bounded for scale; timed in the report. (Formal 1.5–2k stress is
      S6.2.)

**UI presence (standing rule 11 — this chrome is guarded, not just built).**
Each element carries a stable `data-testid`, a fast component test asserting it
renders with its key text/state, and a `pnpm verify` row.
- [x] The **/graph view** renders with health-colored workflow nodes.
- [x] **Workflows and credentials are visually differentiated**: credential nodes carry a
      purple accent + key icon (and a legend entry), never mistaken for a workflow.
- [x] **Cross-instance edges are visually prominent** (animated accent) and distinct
      from intra-instance edges.
- [x] **`possible` edges are visually distinct** from `confirmed` (dashed/muted) and
      never render as part of a highlighted blast radius.
- [x] **Click-to-highlight blast radius** shows the impact answer with an **explicit
      total** in plain English (`graph-impact-total`).
- [x] The selected workflow (`graph-panel-open-detail`) and every workflow in the
      blast-radius list (`graph-affected-list`) are **clickable into the workflow detail
      drawer**; the list grows with the panel and scrolls (never clipped to a few rows).
- [x] Archived nodes render **dimmed** and are hidden behind a toggle by default.
- [x] A **scope switcher** (instance / system / estate) renders. (Neighborhood was
      removed from the UI.)
- [x] The **MCP-exposure highlight** mode renders and traces reach from exposed nodes.
- [x] The estate graph **fills the canvas** as a 2D constellation (not a centred
      hairline), and a **zoom/pan control** (`graph-zoom-controls`: +/−/Fit) renders for
      navigating a dense estate.

**Responsive (standing rule 10 — both themes AND both widths).** The graph view is
rendered in a real browser at 375px + desktop, in light AND dark, asserted no
horizontal page overflow.
- [x] The **graph view** is usable at 375px — controls reflow, no horizontal page
      scroll — and in both themes (vendored tokens only).
