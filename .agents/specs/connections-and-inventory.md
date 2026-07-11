# Connections & live inventory — spec

<!--
One file per subsystem, kept in sync with code (standing rule 9).
Plain-English behavior contract — the product owner's review surface, not code.
PLAN.md is the master spec; this is its decomposition; verify report is the
executable form of the Acceptance criteria below.
Authored/updated just-in-time at the start of the milestone that touches this
subsystem — never pre-written for future milestones.
-->

This is the S1a slice: point Argus at one or more n8n instances, register them as
**connections**, and see a single, always-fresh list of every workflow across the
whole estate — in a real n8n-looking UI, behind a login. It is the first product
slice and the foundation every later slice builds on.

## Behavior

<!-- Inputs → outputs, stated as assertions that must be true. -->

**Login (admin password + asserted identity).**
- Nothing under `/api` is reachable without a session, except `/api/health` and
  `POST /api/auth/login`. An unauthenticated call to any other `/api/*` route gets
  `401`.
- Logging in requires the correct admin password (from an env var) **and** an
  asserted identity (name + email). The identity is stamped on the session and on
  every audit entry the session produces; it is displayed as **"asserted"** (we do
  not claim it is verified — OIDC is a later track).
- A wrong password never logs in and never reveals whether the password or the
  account was the problem.

**Connections registry (the sacred record of which instances Argus watches).**
- The owner registers a connection by giving Argus a **label**, the instance's
  **base URL**, and a **read-only n8n API key** (optionally a public webhook host,
  used by a later slice for cross-instance matching). No n8n password ever reaches
  Argus.
- On register, Argus **validates the key against the live instance** before saving:
  a key that can't list workflows is rejected with a plain-English reason
  (unreachable vs. unauthorized), and nothing is stored.
- A registered connection is stored in Argus's own database. The **API key is
  encrypted at rest** and is **never** returned by any API, logged, or written into
  the audit log in clear text.
- The owner can remove a connection. Removing it deletes that instance's cached
  workflows too (the cache is disposable), but the estate's other connections are
  untouched.
- Registering and removing a connection each write an **audit-log entry in the same
  database transaction** as the change itself — the change and its audit record
  commit together or not at all. The connections and audit tables are **sacred**: no
  code path bulk-deletes or rewrites them, and the audit log is append-only (updates
  and deletes are refused at the database level).

**Live inventory (one always-fresh list across the whole estate).**
- Argus keeps a local, disposable **cache** of every workflow across all registered
  connections. Each cached workflow carries its **instance** as a filter attribute
  (not a partition): the list is one estate, filterable, never N separate lists.
- For each workflow the list shows: **name, instance, owning project, active /
  archived state, and last-updated time.**
- Argus refreshes each connection on its own on a short interval (default ~30s). A
  refresh is a **full re-list that reconciles**: workflows that changed update in
  place, newly-created workflows appear, **deleted workflows disappear**, and
  **archive/unarchive and active/inactive flips are reflected**.
- A change made in n8n (edit, archive, delete) is reflected in Argus's list **within
  a minute**, with no manual action.
- **Self-healing:** because every refresh is a full reconcile, if Argus is stopped
  for a while, the next refresh after it restarts brings the whole estate back into
  agreement — no catch-up queue, no manual resync.
- Each connection reports its **health**: last-synced time, and whether it is `ok`,
  `unauthorized` (key rejected), or `unreachable` (instance down). Health is honest —
  a connection Argus can't read is shown as unreachable/unauthorized, never as an
  empty-but-ok estate (standing rule 5).

**UI (real, n8n-looking, both themes).**
- Built entirely on n8n's vendored design tokens (`var(--…)`), correct in both light
  and dark (standing rule 10).
- A workflow list (name · instance · project · state · last-updated) that
  **auto-refreshes** and can be **filtered by instance**, plus a connections screen
  to register / see health / remove, and a login screen. The list announces it is in
  **polling mode** ("updates within ~30s").

## Non-goals

<!-- What this subsystem deliberately does NOT do. Stops scope creep mid-session. -->

- **No Log Streaming event receiver yet.** Real-time push (per-instance secret route,
  rate-limit, payload cap) and its early `/security-review` are their own slice
  **S1a.1** (an immediate fast-follow, see PLAN.md); S1a's freshness is polling-only.
  Correctness never depends on events.
- **No syncing of credentials, users, tags, or executions**, and **no cross-instance
  edge detection, ownership, health scoring, enrichment, or identity merge.** S1a
  caches workflows (plus each workflow's owning project, for the column) and nothing
  more.
- **No OIDC / verified identity.** Login identity is self-asserted by design.
- **No multi-user roles.** One admin password; the asserted identity is for the audit
  trail, not authorization.
- **No editing of n8n from Argus.** Argus is read-only against every instance; the
  only writes are to Argus's own database.

## Contracts consumed

<!-- Links into contracts/ for every n8n API/event shape relied on. Probe first if missing. -->

- [`contracts/n8n-15-workflow-list-shape.json`](../../contracts/n8n-15-workflow-list-shape.json)
  — `GET /api/v1/workflows?limit=N` (cursor-paginated). The live-inventory source.
  List items carry `id, name, active, isArchived, updatedAt, versionId` and a
  `shared` owner link (`projectId`) — but **not** the nested `project` object.
- [`contracts/n8n-03-projects-shape.json`](../../contracts/n8n-03-projects-shape.json)
  — `GET /api/v1/projects`. Used to resolve the owning **project name** from the
  `projectId` on each workflow's owner share.
- [`contracts/n8n-02-public-api-unauth-rejected.json`](../../contracts/n8n-02-public-api-unauth-rejected.json)
  — public API requires the `X-N8N-API-KEY` header; a missing/invalid key is `401`
  (how Argus classifies a connection as `unauthorized`).

## Acceptance criteria

<!-- Each is a concrete checkable behavior; each maps to a row in `pnpm verify`. -->

- [ ] Both seeded instances can be registered as connections (2 registered).
- [ ] The estate lists every workflow across both instances in one view (N total).
- [ ] The catalog is **server-side paginated** (an enterprise can have thousands): the
      list serves one page (default 50/page, `?limit`/`?offset`), the response carries the
      full match `total`, and the header/pager read from `total` not the page length. Every
      filter change resets to page 1; the pages are distinct and non-overlapping.
- [ ] The list can be filtered by instance (prod n / staging m; n + m = N).
- [ ] A workflow edited / archived / deleted in n8n is reflected within a minute
      (measured seconds).
- [ ] After Argus is stopped and restarted, the next refresh reconciles the estate
      (self-heal, no manual resync).
- [ ] Every `/api/*` route except health and login requires a session
      (unauthenticated `GET /api/workflows` → 401).
- [ ] Registering/removing a connection writes its audit entry in the same
      transaction; the audit log rejects update/delete; stored API keys are encrypted
      and never returned.
