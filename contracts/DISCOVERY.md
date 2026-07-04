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
