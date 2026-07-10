# Analyzer freshness — spec

<!--
One file per subsystem, kept in sync with code (standing rule 9).
Plain-English behavior contract — the product owner's review surface, not code.
PLAN.md is the master spec; this is its decomposition; the verify report is the
executable form of the Acceptance criteria below.
Authored just-in-time at the start of S6.1 (post-core), per Decision #23/#32.
-->

This is the **S6.1** slice. The analyzer ([`analyzer-catalog.md`](analyzer-catalog.md))
recognizes n8n node types from a **vendored manifest pinned to n8n 2.29.0**, generated at
build time from the n8n **source tree** — a deployed Argus has no source tree to regenerate
from. So when an admin **upgrades** a connected instance past 2.29.0, the manifest goes stale:
nodes introduced after the pin become unrecognized and their workflows are quietly
**under-analyzed**. This slice makes that staleness **visible in-product** on the
connection-health surface, quantifies the lost coverage, and tells the admin how to restore it.

The framing is rule 5: a stale manifest makes the analyzer **incomplete, not wrong** — unknown
nodes are still "couldn't analyze", never mislabeled. So the alert is a **coverage nudge**
("coverage may have dropped"), never a correctness alarm ("data is wrong"). It is the runtime
counterpart of the build-time weekly drift probe (rule 1).

## The gating probe (Decision #23 → Decision #32)

Decision #23 split this slice by feasibility: **detection + alert always ships**; **runtime
"refresh from the live instance" is gated** on whether the connection's read-only API key can
reach the live n8n version and node metadata. The rule-1 probe at pickup (captured in
`contracts/`) settled it against the running instances **and** n8n source:

- **The running n8n version is NOT reachable with an API key.** `versionCli` is served by
  `/rest/settings` only to a browser **session cookie**; an API-key caller gets the reduced
  public payload with no version. No `/api/v1/version`, no version header on `/healthz`.
- **Node-type metadata is NOT reachable with an API key** — `/types/nodes.json` is
  **cookie-only** (401 with a valid key). No public-API node-type route exists.

Both halves resolve to **"No"**: Argus (read-only API key, no cookie) can neither read the
instance version nor refresh the manifest from the live instance at runtime. So **regeneration
stays a build/ops step** and the UI action **degrades to upgrade guidance**. Detection ships
regardless — anchored on the one signal Argus can **verify**: unrecognized node types in the
real workflows it already syncs.

## Behavior

<!-- Inputs → outputs, stated as assertions that must be true. -->

**Detection (piggybacks on the S1a poll — no new fetch, no new subsystem).**
- Every poll, for each connection, Argus already computes per-workflow facts, including each
  workflow's **unrecognized node types** (`coverage.unknownNodeTypes`). Analyzer-freshness
  reuses those facts — it does not re-parse or call n8n.
- Argus classifies each unrecognized node type by **namespace**:
  - **Core** — `n8n-nodes-base.*` or `@n8n/n8n-nodes-langchain.*`. These ship *with* n8n, so a
    core type the pinned manifest doesn't know almost certainly means the instance runs a
    **newer n8n than the manifest** → the manifest is stale → **regenerate**.
  - **Community / custom** — any other namespace. These are third-party nodes the
    source-vendored manifest **can never know**; a manifest rebuild **won't** add them, so this
    is **not** a regenerate case.
- Per connection Argus produces an advisory **analyzer-drift** summary: the manifest's pinned
  n8n version, a status, distinct **core** unrecognized type count + affected-workflow count,
  distinct **community** unrecognized type count + affected-workflow count, and the **actual
  unrecognized type names** — split by kind (core vs community), capped for display, with the
  true totals kept so the UI shows an honest **"+N more"** rather than an illustrative "e.g."
  (rule 5). Status is one of:
  - **current** — no unrecognized node types on this instance.
  - **core-drift** — ≥1 unrecognized **core** type (coverage may have dropped; regenerate).
  - **community-only** — unrecognized types exist but are **all** community/custom (no
    regenerate). `core-drift` wins when both kinds are present.

**Alert surface (on the existing connection-health element — additive, rule 11).**
- A connection in **core-drift** shows an advisory notice: **"Coverage may have dropped — N
  core node types on this instance aren't recognized by the analyzer (built for n8n 2.29.0). If
  you upgraded n8n, rebuild the analyzer for your version,"** with a link to the documented
  rebuild step. It reads as *coverage may have dropped*, never *data is wrong*.
- A connection in **community-only** shows a **distinct** message: **"N community/custom node
  types can't be analyzed — a manifest rebuild won't add them"** — and **no** regenerate CTA.
- A **current** connection shows no alert (at most a quiet "analyzer current for n8n 2.29.0").

**Honesty & the "since the upgrade" framing (rule 5).**
- The alert is **anchored on verifiable coverage impact**, not on a version number Argus can't
  read. Argus never claims "you upgraded to version X" — it reports what it can prove
  (unrecognized core nodes in real workflows) and names the *only* version it knows for certain:
  the manifest's own pin.
- A bare upgrade that introduces no newly-used node types produces **no alert** — because
  coverage genuinely hasn't dropped. That is **correct behavior**, not a gap: there is nothing
  to fix until a post-pin node actually appears in a workflow.
- The drift number is advisory context on the connection; it **never** counts against any
  accountability metric, and an unrecognized node is still surfaced as "couldn't analyze"
  everywhere else — never reclassified.

**Nothing else degrades.**
- A connection in drift still lists its workflows, computes health, and infers ownership
  exactly as before. Drift detection is read-only aggregation over facts Argus already holds;
  it changes no sacred table and adds no failure path to the sync.

## Non-goals

<!-- What this subsystem deliberately does NOT do. Stops scope creep mid-session. -->

- **No runtime "refresh from the live instance."** The probe proved node metadata is
  cookie-only; Argus holds only a read-only API key. Regeneration is a build/ops step.
- **No manual/typed n8n version as the drift anchor.** A self-asserted version rots and would
  nag "regenerate" while coverage is actually fine — the alert must depend only on verifiable
  unrecognized-nodes, never on a typed fact. (An optional "recorded, not detected" version
  label may be added later; it is out of scope here and the alert must never depend on it.)
- **No version-canary probing** (inferring the version from which credential types exist) —
  brittle and a form of guessing (rule 5).
- **No new poll or subsystem.** Detection rides the existing S1a poll + connection-health
  surface.
- **No auto-regeneration on drift** — regeneration may not be runtime-feasible and silent
  analyzer changes violate the visible/admin-controlled posture; surface it and let the human act.

## Contracts consumed

<!-- Links into contracts/ for every n8n API/event shape relied on. Probe first if missing. -->

- [`contracts/n8n-21-version-unreachable.json`](../../contracts/n8n-21-version-unreachable.json)
  — the gating probe (Decision #23 Q1): `/rest/settings` returns no version to an API-key
  caller, and there is no `/api/v1/version`. Establishes "version unreachable → no version
  anchor".
- [`contracts/n8n-22-types-nodes-auth.json`](../../contracts/n8n-22-types-nodes-auth.json)
  — the gating probe (Decision #23 Q2): `/types/nodes.json` is **401 with an API key**, 200
  with a session cookie. Establishes "node metadata cookie-only → no runtime refresh".
- Reuses the S1b facts contract
  [`contracts/n8n-16-workflow-list-facts-shape.json`](../../contracts/n8n-16-workflow-list-facts-shape.json)
  — drift reads `coverage.unknownNodeTypes` from the facts already computed there; no new fetch.
- The vendored manifest's pinned version (`MANIFEST_DATA.n8nVersion`, n8n **2.29.0**), generated
  by `scripts/gen-manifest.mjs`. See [`analyzer-catalog.md`](analyzer-catalog.md).

## Acceptance criteria

<!-- Each is a concrete checkable behavior; each maps to a row in `pnpm verify`. -->

- [x] A connection whose synced workflows use a **core** node type the pinned manifest doesn't
      recognize is flagged **core-drift** with the correct distinct-type count, framed "coverage
      may have dropped" (never "data is wrong").
- [x] Unrecognized **community/custom** node types are labeled community-only with a distinct
      message and **no** regenerate CTA — a manifest rebuild won't add them.
- [x] When both kinds are present, status is **core-drift** (regenerate case wins); when there
      are no unrecognized types, status is **current** and no alert shows.
- [x] Baseline sanity: the current in-sync seeded estate (n8n 2.29.0 = manifest pin) shows
      **0** connections in core-drift.
- [x] Rule-5 guard: an unrecognized (drifting) node is still surfaced as "couldn't analyze" and
      is never reclassified; the drift number never counts against any accountability metric.
- [x] A connection in drift still lists workflows, computes health, and infers ownership
      normally (nothing else degrades).

**UI presence (standing rule 11 — this chrome is guarded, not just built).**
Stable `data-testid`, a fast component test asserting it renders with the right text/state, and
a `pnpm verify` row.
- [x] The analyzer-drift notice (`data-testid="analyzer-drift"`) renders on the Connections
      screen for a **core-drift** connection with its count + rebuild guidance link.
- [x] It renders the **community-only** variant (distinct text, no regenerate CTA) and renders
      **nothing** for a **current** connection.

**Responsive (standing rule 10 — both themes AND both widths).**
- [x] The drift notice renders correctly and without horizontal overflow at **375px** and
      desktop, in **light AND dark**, using vendored tokens only.
