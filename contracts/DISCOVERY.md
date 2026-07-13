# M0 discovery-probe findings

Captured live against n8n **2.29.0** (E2E mode) on 2026-07-04. These answer the
open questions PLAN.md flagged for M0. Raw evidence is in the sibling JSON files.

## 1. Agents-v2 in the Public API → **NOT exposed** (as PLAN predicted)

`GET /api/v1/agents` and `/api/v1/agents/v2` both return **404** with a valid API
key. n8n source has no public-API agents handler group (agents-v2 lives only under
internal REST `/rest/projects/:id/agents/v2/*`).

**Consequence:** the AI-agent registry scope stays **workflow-based agents only**
(`agent`/`agentTool` node types + `ai_*` connections). This is the declared
boundary in PLAN.md Pillar 3 — confirmed, not assumed. `UPSTREAM.md` should request
public exposure. Evidence: `n8n-07-agents-v2-visibility.json`.

## 2. Folders in the Public API → **EXPOSED** (better than PLAN's open question)

`GET /api/v1/projects/{projectId}/folders` returns **200** (license: `feat:folders`).
n8n source has a full public-api folders handler group
(`/projects/{projectId}/folders` and `/…/{folderId}`).

**Consequence:** folder context is available as a catalog/enrichment dimension via
the Public API — PLAN.md listed this as a "candidate addition, M0 probe whether
folders surface." **They do.** This unblocks folder-as-a-dimension whenever we
choose to use it (not an M0 deliverable). Evidence: `n8n-06-folders-visibility.json`.

## 3. Workflow `shared` / projects / users shapes → **captured, and richer than assumed**

- **`shared` array is present** on `GET /api/v1/workflows/{id}` and carries exactly
  the ownership-inference input PLAN.md Pillar 2 needs:
  ```json
  "shared": [{
    "role": "workflow:owner",
    "workflowId": "…", "projectId": "…",
    "project": { "id": "…", "name": "Nathan Owner <nathan@n8n.io>",
                 "type": "personal", "creatorId": "…" }
  }]
  ```
  Note the role slug format is `workflow:owner` (not a bare `owner`), and each
  `shared` entry embeds the full `project` (including `type: personal | team` and
  `creatorId`). Evidence: `n8n-05-workflow-shared-shape.json`.

- **Projects** (`GET /api/v1/projects`) return `{ id, name, type, icon, description,
  creatorId, customTelemetryTags, createdAt, updatedAt }`. Personal projects are
  named `"<First Last> <email>"` with `type: "personal"`. Evidence:
  `n8n-03-projects-shape.json`.

- **Users** (`GET /api/v1/users?includeRole=true`) return one row per user with the
  global role included. Evidence: `n8n-04-users-shape.json`.

- **Bonus fields observed** on the workflow response beyond PLAN's list, worth
  noting for later milestones: `activeVersionId`, `versionCounter`,
  `sourceWorkflowId`, `triggerCount`, `nodeGroups`, `activeVersion`, `isArchived`.
  (`versionId` + `isArchived` are the ones PLAN's sync/analyzer rely on — both present.)

## Also verified (core M0 contract probes)

- n8n reachable (`GET /healthz` → 200).
- `PATCH /rest/e2e/feature` accepts `{ feature, enabled }` (skipAuth) → 200 — this
  is the E2E unlock mechanism (`pnpm seed:unlock` territory for M1).
- Public API rejects unauthenticated requests (`GET /api/v1/workflows` → 401).

## Gotcha captured for M1 (seeder)

`POST /rest/e2e/reset` requires **owner, admin, and chat as objects** (plus a
`members` array). Passing `null` for admin/chat crashes the reset with a 500
(`setupUserManagement` dereferences `admin.password`). The seeder must send all
three. Encoded in `scripts/probe-n8n.mjs`.

## M1 seeder contracts (08–14) — captured live 2026-07-04

All green against n8n 2.29.0. Evidence in the sibling `n8n-08..14-*.json`.

- **08 · manual run → real execution.** `POST /rest/workflows/{id}/run` (cookie
  auth, **not** public API) with body
  `{ triggerToStartFrom: { name: "<trigger node name>" } }` returns
  `{ data: { executionId } }`. The run is **async** — poll
  `GET /rest/executions/{id}` until `status` leaves `running`/`new`/`waiting`. A
  workflow whose HTTP node targets an unreachable host (`http://127.0.0.1:1/…`)
  ends `status: "error"` deterministically. This is how the seeder plants failing
  run history. Mode is `manual` (not `trigger`).
- **09 · production webhook → real execution.** With a webhook workflow **active**
  (see 14), `POST <baseUrl>/webhook/<path>` returns 200 and records one execution
  (confirmed via `GET /rest/executions?filter={workflowId}`). This is the faithful
  way to generate webhook-triggered history and implicit webhook→HTTP edges.
- **10 · create project.** `POST /api/v1/projects { name }` → **201**, response
  includes `type: "team"`, `id`, and the caller's `role: "project:admin"` +
  scopes. An owner API key creates **team** projects. `mcp:manage` is among the
  scopes (relevant to `availableInMCP` later).
- **11 · add member to project.** `POST /api/v1/projects/{id}/users` with
  `{ relations: [{ userId, role }] }` → **201**. Role is an *assignable project
  role*: `project:admin | project:editor | project:viewer`.
- **12 · create credential in project.** `POST /api/v1/credentials
  { name, type, data, projectId }` → **200**, response `{ id, name, type, … }`
  (the response does **not** echo the project; trust the `projectId` on create).
- **13 · create workflow in project.** `POST /api/v1/workflows` with `projectId`
  → the workflow's `shared[]` `workflow:owner` entry carries that `projectId`
  (confirmed the workflow lands in the target team project, not owner's personal).
- **14 · activate workflow.** `POST /api/v1/workflows/{id}/activate` → **200**,
  `active: true`. Required before a production webhook (09) will fire.

**Members via reset.** Passing `members: [{ email, password, firstName, lastName }]`
to `/rest/e2e/reset` creates **fully active** users (not pending invites), each with
a personal project — the seeder uses this to plant real owners rather than the
public invite flow (which leaves users pending).

## Seeder build-time findings (rule 1 — reality caught assumptions)

- **Workflow *publishing* gates activation (n8n 2.29).** A workflow that references
  a sub-workflow via `executeWorkflow` **cannot be activated** until every
  referenced sub-workflow is **published** (`POST /api/v1/workflows/{id}/activate`
  publishes; error otherwise: *"references workflow X which is not published"*).
  The seeder therefore publishes a parent's non-archived callees first, in
  topological order. **Consequence for the estate:** an **active** workflow can
  **never** reference an **archived** sub-workflow (publishing is blocked) — so the
  `depends_on_archived` finding is "a *live/non-archived* (but unpublished) workflow
  calls an archived one," not "an active one." Spec + verify reflect this.
- **`GET /api/v1/credentials` needs `credential:list` + `credential:read`** on the
  API key (create/update/delete alone → empty list).
- **Assigning tags needs the `workflowTags:update` scope** (not `tag:update`);
  `PUT /api/v1/workflows/{id}/tags` with `[{ id }]`. Also: you cannot tag an
  **archived** workflow (archive last).
- **`availableInMCP` is a real entity column, not just a setting.** Passing
  `settings.availableInMCP:true` on create persists in settings but does **not**
  flip the column/filter. Set it authoritatively via internal REST
  `PATCH /rest/mcp/workflows/toggle-access { availableInMCP, workflowIds }`; the
  internal list filter `/rest/workflows?filter={"availableInMCP":true}` then
  reflects it (the *public* list does not expose this filter).
- **Ownership placement.** The owner API key **can** create a workflow directly in
  another user's **personal** project (pass that project's `projectId`) — used for
  the personal-space-critical workflow. Team-project creation via the owner key
  also auto-adds the **owner** as a project member, so "sole owner" is asserted
  over *assigned* members (excluding the instance owner).
- **Members cannot mint API keys** (`POST /rest/api-keys` → 400 "Invalid scopes for
  user role"), so all seeding runs through the single owner key + `projectId`.
- **Manual-run input injection.** `POST /rest/workflows/{id}/run` with
  `triggerToStartFrom.data` does **not** inject item data into the flow; deterministic
  mixed success/error history is driven via **production webhook body** instead
  (`{ fail: true|false }` → a Code node throws on `fail`).

## S3 health contract (17) — captured live 2026-07-06

- **17 · public executions LIST shape.** `GET /api/v1/executions` (public API, API-key
  auth) returns `{ data: [...], nextCursor }`, cursor-paginated. Each item carries
  `id, status, startedAt, stoppedAt, workflowId, finished, mode, retryOf,
  retrySuccessId, waitTill`. **`status` is the health signal, not `finished`** — an
  errored run showed `finished: false` with `status: "error"`. Observed status values
  include `success | error | waiting | running | new` (n8n also emits `canceled`/`crashed`).
  The `?status=error` filter works (returns only error rows); `?includeData=false` keeps
  execution payloads out; `?redactExecutionData=true` passes through. Durations =
  `stoppedAt − startedAt` (both ISO strings, both nullable for `running`/`waiting`).
  This is the health service's source — fetched **without** `includeData`, **with**
  `redactExecutionData=true`. Evidence: `n8n-17-executions-list.json`.

## S3 redacted-execution debug (18) — captured live 2026-07-06

- **18 · redacted single-execution detail.** `GET /api/v1/executions/{id}?includeData=true&redactExecutionData=true`
  returns the execution with **server-side-redacted** result data. The debug signal that
  survives redaction: **`resultData.lastNodeExecuted`** (the failing node's NAME, e.g.
  "Fetch Stripe Ledger") and **`resultData.redactedError`** — a classification object,
  e.g. `{ "type": "NodeApiError", "httpCode": "ECONNREFUSED" }`. The error **message**
  and **all node input/output data are stripped** (a Code-node throw yields
  `redactedError: {}`). n8n's per-execution UI deep link is
  **`/workflow/{workflowId}/executions/{executionId}`** (VIEWS.EXECUTION_PREVIEW,
  verified in `../n8n` router). Argus's drawer reads this **on-demand only** (when a user
  opens a workflow) and **allowlists only** `lastNodeExecuted` + `redactedError.{type,httpCode}`
  — never the message/payload, never persisted. Evidence: `n8n-18-execution-redacted.json`.

- **Silent failures are invisible under redaction (S6.3, drove a design change).** The PLAN's
  S6.3 Layer-2 premise was to read `runData[node].executionStatus === 'error'` on a `success`
  run from the **redacted** detail. The probe **disproved it** at n8n 2.29: a node error
  swallowed by any `onError: continue*` mode makes the node read **`executionStatus: 'success'`**
  (n8n treats it as handled), and `redactExecutionData=true` **clears `item.json` to `{}`** — so
  **nothing** signals the swallow. The error only survives **un-redacted**, at
  `runData[node].data.main[*][*].json.error` (a structured `{name,code,message,stack}` for
  HTTP/app nodes; a bare message **string** for Code nodes). Owner-approved resolution: Layer 2
  — and **only** Layer 2 — reads the **un-redacted** detail for the can-mask-failures workflows,
  and Argus **allowlists it to node name + error type/code** (`error.name` + `error.code`/
  `httpCode`) **server-side**, never the message/stack/payload, never persisted. Evidence:
  `n8n-23-execution-silent-failure.json` (characterizes all three swallow mechanisms, redacted
  vs un-redacted).

## Two-instance ports (rule 1 — reality vs. PLAN's illustration)

PLAN illustrates "prod :5678 / staging :5679". **`:5679` is not free** — it is the
default **task-runner broker port** (`N8N_RUNNERS_BROKER_PORT`, default `5679`,
`runners.config.ts`), which a prod instance on `:5678` already binds on
`127.0.0.1`. The seeder keeps prod=`5678` / staging=`5679` as the **main HTTP
ports** but moves each instance's broker off them via
`N8N_RUNNERS_BROKER_PORT` (prod `6779`, staging `6780`) so the two instances (and
their brokers) never collide. Isolation is by `N8N_USER_FOLDER` per instance (own
SQLite DB + encryption key + settings); no `../n8n` edits.

## S6.1 analyzer-freshness gate (21–22) — captured live 2026-07-10

Decision #23 gated "runtime one-click refresh from the live instance" on two rule-1
questions. `pnpm probe:freshness` (non-destructive) settled both against the running
instance, cross-checked against n8n source — and **both are "No"** for a caller holding
only a read-only public API key (Argus's model; it has no browser session cookie):

1. **n8n version → unreachable via API key.** `/rest/settings` serves `versionCli` only to a
   **session cookie** (`req.user` branch of `frontend.service.ts`); an API-key caller gets the
   reduced public payload with no version field. There is no `/api/v1/version` and no version
   header on `/healthz`. So Argus has **no version anchor** to detect an upgrade with.
2. **Node-type metadata → cookie-only.** `/types/nodes.json` is **401 with a valid API key**,
   **200 (898 node types) with a cookie**; `/rest/node-types` is cookie-gated too. So Argus
   **cannot refresh the manifest from the live instance** at runtime.

**Consequence (Decision #32):** regeneration stays a build/ops step and the UI action degrades
to upgrade guidance. Detection still ships — anchored not on a version Argus can't read but on
the one signal it can **verify**: unrecognized node types in the workflows it already syncs,
split by namespace (core `n8n-nodes-base.*` / `@n8n/n8n-nodes-langchain.*` → likely a newer n8n
→ regenerate; anything else → community/custom, which a rebuild won't fix).

(Rule-1 note: in this E2E build the *cookie* `/rest/settings` also omitted `versionCli` — the
owner login didn't satisfy the stricter `allowSkipMFA:false` gate that `/rest/settings` uses,
whereas `/types/*` uses `allowSkipMFA:true`. Immaterial to the design: Argus never holds a
cookie, so the API-key "No" is what governs.)
