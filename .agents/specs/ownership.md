# Ownership & accountability — spec

<!--
One file per subsystem, kept in sync with code (standing rule 9).
Plain-English behavior contract — the product owner's review surface, not code.
PLAN.md is the master spec; this is its decomposition; the verify report is the
executable form of the Acceptance criteria below.
-->

This is the **S4** slice: **every workflow has an answerable owner**, the **ownership
governance gaps are visible**, and **every governance action Argus takes is on a
tamper-evident audit trail**. n8n has no concept of a *person* owning a workflow —
projects own workflows, not people — so "who do we call when this breaks?" has no
answer, and nothing records who decided what. S4 answers both "who do we call?" and
"who decided this?".

Facts (S1b) say what a workflow *is*; enrichment (S2) says what it *means*; health (S3)
says whether it is **working right now**; ownership (S4) says **who is accountable for
it** — and records every accountability decision.

Two guarantees this slice is built to make **structural**, not a matter of discipline:
1. **A full resync does NOT wipe ownership.** Explicit assignments live in their own
   durable table with no foreign key to the workflow cache, so the ~30s inventory
   rebuild cannot touch them.
2. **There is NO way to change ownership without an audit entry.** Every ownership
   mutation goes through the sacred audit DAO (`withAudit`) — the mutation and its
   append-only audit entry commit in one transaction, or neither does.

## Behavior

<!-- Inputs → outputs, stated as assertions that must be true. -->

**Resolved owner (per workflow).** Every workflow resolves to exactly one ownership
status:
- **`assigned`** — a human explicitly assigned an owner in Argus. Authoritative.
  Carries owner (name/email), optional backup owner, optional reason, and who assigned
  it and when.
- **`inferred`** — no explicit assignment; Argus infers an **advisory** owner from n8n
  project membership (below). Always visibly labeled **"inferred"**, never presented as
  authoritative. An explicit assignment **overrides** it.
- **`unowned`** — no assignment and nothing could be inferred.

**Ownership inference (advisory, membership/roles only).** Inference derives the
advisory owner from n8n's **project membership and roles only** — the live signal
available today:
- A workflow in a **personal project** → the inferred owner is **that person** (the
  personal space's human), resolved from the project (`source: personal-project`).
- A workflow in a **team/shared project** → the inferred owner is the project's
  **most-privileged member**, ranked `project:admin > project:editor > project:viewer`
  (ties broken deterministically). `source: project-member`, recording the winning role.
- **Honest degradation (rule 5):** if the instance is not licensed for project roles,
  or the API key lacks the `user:list` scope, or the membership fetch fails, the
  inferred owner is **"couldn't infer"** with a plain reason — **never a fabricated
  name**. Inference is a fact about n8n's *current* state; it is cached from the
  reconciliation sync and never audited, and it never overrides an assignment.

The inferred owner is coarser than "the person who actually maintains it" — it is
org-chart/membership-based and can be wrong. That is **why** it is advisory and why
explicit assignment is the authoritative override. (Post-connect audit-event actors —
who actually created/edited a workflow — are a **behavioral** signal gated on the
deferred Log Streaming receiver; out of scope here.)

**Explicit assignment lifecycle (audited).** Under shared-admin auth the operator (an
asserted identity) can **assign**, **reassign**, set/clear a **backup owner**, and
**remove** an owner. Each is a one-click mutation that writes an audit entry in the
same transaction with **who / when / before→after / reason**. The owner (and backup)
can be **picked from that instance's known n8n users** or **typed free-text** (to name
someone who is not an n8n user — a manager, an on-call rota). There is **no** code path
that changes ownership without recording it.

**"What has no owner."** A view surfaces the **unowned** workflows, each shown with its
**criticality** (from S2), critical-first — so the accountability gaps you most need to
close are at the top.

**Governance gaps.** Beyond unowned, Argus surfaces three accountability risks:
- **single-owner-critical** — one human is the **sole** owner of **multiple critical**
  workflows, **including the same email across both instances** (a fleet-wide single
  point of failure). Cross-instance means **exact-email** match only here (fuzzy
  cross-instance identity is **S8**).
- **personal-space-critical** — a **critical** workflow living in someone's **personal
  project** (business-critical automation parked in a personal space).
- **no-backup-owner** — an **assigned, critical** workflow with **no backup owner**.

Every gap item carries the workflow(s), the person, and the criticality + reason — never
a bare label (rule 5 discipline).

**Incident context (start of the incident view).** A **failing** workflow (S3) now shows
**its owner** alongside its health — the first assembly of "what broke + who is
accountable". (Full incident package — downstream blast radius, recent-change context —
is later.)

**The audit timeline — Argus's own self-audit.** Every Argus mutation (ownership
lifecycle, label corrections, connection changes) is append-only audit-logged with
actor, action, entity, before→after, reason, and timestamp. A **unified timeline** view
shows these entries, **filterable** (by action, entity, actor, date) and **exportable**
(CSV, secret-free). This is **Argus's own self-audit only** — ingested `n8n.audit.*`
events join when the deferred Log Streaming receiver lands.

## Non-goals

<!-- What this subsystem deliberately does NOT do. Stops scope creep mid-session. -->

- **No behavioral inference.** Post-connect audit-event actors (who actually
  created/edited/activated a workflow) come via `n8n.audit.workflow.*` through the
  deferred Log Streaming receiver — unavailable here. Inference is **membership/roles
  only**.
- **No ingested n8n audit events in the timeline.** The timeline is **Argus's own
  self-audit** in S4; n8n audit events join with the receiver.
- **No fuzzy cross-instance identity.** "Same person across instances" is **exact-email**
  only. Case/alias/name normalization is **S8**.
- **No per-user auth / self-service claim.** The verb is the operator's "assign owner X"
  (asserted shared-admin identity). "I claim this" arrives with per-user auth (track P).
- **No editing or deleting audit history.** `audit_log` is append-only (DB-guarded); the
  timeline reads it, never mutates it. There is no "undo" that erases an entry — a
  correction is itself a new audited mutation.
- **No writes to n8n.** Ownership is Argus's own accountability layer; Argus stays
  read-only against every instance. Assigning an owner does not change anything in n8n.

## Contracts consumed

<!-- Links into contracts/ for every n8n API/event shape relied on. Probe first if missing. -->

- [`contracts/n8n-19-project-members-shape.json`](../../contracts/n8n-19-project-members-shape.json)
  — real `GET /api/v1/projects/{projectId}/users`: the membership roster with per-member
  **project role** (`project:admin` / `project:editor` / `project:viewer`) that drives
  team-project inference. Requires the instance licensed for project roles and the API
  key to hold `user:list`; the contract also records the **degraded (4xx)** shape so
  inference degrades honestly. Captured by the rule-1 probe.
- [`contracts/n8n-03-projects-shape.json`](../../contracts/n8n-03-projects-shape.json)
  — `GET /api/v1/projects`: `type` (`personal`/`team`), `creatorId`, and the personal
  project `name` (`"First Last <email>"`) that resolves personal-space owners.
- [`contracts/n8n-04-users-shape.json`](../../contracts/n8n-04-users-shape.json)
  — `GET /api/v1/users?includeRole=true`: the user roster (id, email, name) used to
  resolve `creatorId` → person and to populate the **assign-owner picker**.
- [`contracts/n8n-05-workflow-shared-shape.json`](../../contracts/n8n-05-workflow-shared-shape.json)
  — the `shared` array (`role: workflow:owner` → `projectId`) already used to resolve a
  workflow's owning project.

## Acceptance criteria

<!-- Each is a concrete checkable behavior; each maps to a row in `pnpm verify`. -->

**Assignment lifecycle is audited.**
- [ ] Assigning an owner makes the workflow read **owned (`assigned`)** AND writes a
      matching `audit_log` entry with **who / when / before→after / reason**
      (`action: ownership.assign`).
- [ ] **Reassign**, **set/clear backup owner**, and **remove owner** each mutate the
      owner AND write their own audit entry (`ownership.reassign`,
      `ownership.backup.set`, `ownership.remove`) with before→after detail.
- [ ] **Guarantee (ii):** every ownership mutation goes through `withAudit` — the count
      of ownership audit entries equals the count of ownership mutations; there is no
      un-audited write path to `workflow_ownership`.

**Ownership survives resync.**
- [ ] **Guarantee (i):** assign an owner, run a **full inventory resync**
      (`replaceInstanceWorkflows`), and the assignment **survives** unchanged.

**What has no owner + inference.**
- [ ] **"What has no owner"** surfaces the unowned workflows, each with its S2
      **criticality**, critical-first.
- [ ] A workflow with no assignment shows an **`inferred`** advisory owner from project
      membership; the **personal-space** workflow infers **that person**, a **team**
      workflow infers the **most-privileged member** (`admin > editor > viewer`).
- [ ] Explicit assignment **overrides** inference (status flips `inferred → assigned`).
- [ ] **Honest degradation (rule 5):** when membership can't be read (no `user:list` /
      unlicensed / fetch error), the inferred owner reads **"couldn't infer"** with a
      reason — never a fabricated name; the catalog/inventory is otherwise unaffected.

**Governance gaps.**
- [ ] **single-owner-critical:** a person who solely owns **multiple critical**
      workflows surfaces as a gap, **including the same email across both instances**
      (exact-email; e.g. seeded `Sam Rivers` sole owner of Revenue Ops criticals in prod
      + staging).
- [ ] **personal-space-critical:** a **critical** workflow in a **personal** project
      surfaces (e.g. seeded `Personal Ops Hack` in Diana's personal space).
- [ ] **no-backup-owner:** an **assigned, critical** workflow with no backup owner
      surfaces.

**Incident + audit timeline.**
- [ ] A **failing** workflow (S3) shows **its owner** (the start of the incident view).
- [ ] The **audit timeline** shows Argus's **self-audit** entries, **filterable** (action
      / entity / actor / date) and **exportable to CSV** (secret-free; no payloads).

**UI presence (standing rule 11 — this chrome is guarded, not just built).**
Each element carries a stable `data-testid`, a fast component test asserting it renders
with its key text/state, and a `pnpm verify` row.
- [ ] A new top-nav **"Governance"** item routes to the **Governance view**
      (`governance-view`); existing chrome is unchanged (additive only, rule 11).
- [ ] The Governance view shows the **governance-gaps** panel (`governance-gaps`:
      unowned-critical, single-owner-critical, personal-space-critical, no-backup) with
      counts + criticality, and the **audit timeline** (`governance-audit-timeline`) with
      filter controls and an **export** control (`governance-audit-export`).
- [ ] The **catalog** shows an **owner badge** per workflow (`owner-badge`:
      assigned/inferred/unowned; the inferred state is visibly advisory).
- [ ] The **detail drawer** (shared by catalog + health) shows an **ownership section**
      (`ownership-section`) with the owner badge and an **assign/reassign** control that
      opens the **assign-owner dialog** (`assign-owner-dialog`) — a **picker** of known
      n8n users (`assign-owner-picker`) plus **free-text** fallback, backup owner, and
      reason; existing drawer chrome unchanged (additive, rule 11).
- [ ] When an **inferred** owner exists, the assign dialog **suggests it**
      (`assign-owner-suggestion`) with a one-click **Confirm owner**
      (`assign-owner-confirm-inferred`) that fills the owner fields + selects the picker —
      the advisory owner is never auto-applied; the human confirms it.
- [ ] The **failing/incident** surface shows the failing workflow's owner
      (`incident-owner`).

**Responsive (standing rule 10 — both themes AND both widths).** Each hero view is
rendered at 375px + desktop, in light AND dark, asserted to have no horizontal overflow.
- [ ] The **Governance view** (gaps + audit timeline) is usable at 375px with no
      overflow, in both themes.
- [ ] The **catalog with the owner badge/column** and the **assign-owner dialog** are
      usable at 375px with no overflow, in both themes.
