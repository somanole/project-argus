# seeder — spec

<!--
One file per subsystem, kept in sync with code (standing rule 9).
Plain-English behavior contract — the product owner's review surface, not code.
PLAN.md is the master spec; this is its decomposition; verify report is the
executable form of the Acceptance criteria below.
-->

## Behavior

The seeder is **one command, `pnpm seed`**, that stands up **two believable n8n
instances — prod and staging — that together look like one real company's n8n
estate**, with specific governance problems deliberately planted so later
milestones (analyzer, health, graph) have real things to find. It is a **data
operation**: it can be re-run at any time and always lands the same estate.

**One command.** `pnpm seed` ensures both instances are running (launching them
itself if they aren't, and waiting until each answers healthy), then seeds prod,
then staging, then wires the cross-instance ("estate-level") scenarios. When it
finishes, the owner can open each instance in a browser, log in, and see something
that reads like a real company's n8n.

**Two isolated instances.**
- **prod** on `http://localhost:5678`, **staging** on `http://localhost:5679`.
- Each has its own database and settings (isolated by a private data folder), so
  wiping or reseeding one never touches the other. The reference n8n checkout
  (`../n8n`) is never modified — it is only run.
- Both run in E2E mode so the estate can be reset and re-seeded deterministically.

**Per instance, the seeder plants:**
- **4 team projects** — Revenue Ops, Customer Support, Data Platform, Marketing —
  with people assigned to them.
- **People** — an owner plus several members, so ownership is real and varied.
- **5 dummy credentials** — Slack, Postgres, Stripe, Salesforce, Email — placed in
  the projects that use them (the Postgres/Stripe pair forms a "sensitive cluster").
- **~25–30 workflows** created in dependency order (a workflow that calls another
  is created after its callee, so the reference points at a real id), then tagged
  and (where they have a production trigger) activated.
- **Real execution history, including deliberate failures.**

**The planted problems** (this is the "messy in the ways that matter"):
- A **3-level sub-workflow chain**: Order Intake → Enrich → Billing.
- A **shared utility "Send Slack Alert" called by 5 workflows** (fan-in of 5).
- **AI-agent workflows** (chat trigger + model + memory + a tool sub-workflow),
  including one agent callee shared across projects.
- An **implicit webhook→HTTP edge** (one workflow's HTTP Request calls another's
  webhook by URL, not via a sub-workflow node).
- **Exactly one broken reference**: a workflow that calls a sub-workflow id that
  does not exist.
- **Exactly one orphan**: "Old CSV Import" — inactive, called by nobody.
- **Deliberate failures with real history**: an always-failing critical "Daily
  Stripe Reconciliation", a flaky "Zendesk Sync" (mix of success and error), and
  an alternating "Data Quality Sentinel".
- A **single-owner-critical** person: one individual solely owns 5 workflows
  tagged critical, with no backup owner.
- A **personal-space-critical** workflow: a critical workflow living in a person's
  personal space instead of a team project.
- An **archived workflow still called by a live workflow** (n8n 2.29 blocks
  *publishing* a workflow that references an archived callee, so the caller is
  live-but-unpublished — see `contracts/DISCOVERY.md`).
- **Analyzer edge cases**: a plain-string executeWorkflow reference, an inline
  (`source: parameter`) sub-workflow, an expression-valued HTTP URL, an
  expression-valued webhook path, and an `agentTool` orchestration node.
- **Two MCP-exposed workflows** (`availableInMCP`): one benign (read-only lookup),
  one sensitive (reaches the Postgres/Stripe cluster).
- One **rename-only edit** artifact (a workflow renamed after creation) — its
  behavioral effect is an M2 concern; M1 only leaves the artifact.

**The estate-level (cross-instance) scenarios**, wired after both instances exist:
- A **cross-instance webhook edge**: a **staging** workflow's HTTP Request calls a
  **prod** webhook URL — the scary "prod depended on by staging" finding.
- A **shared-identity single point of failure**: **one person with the same email
  in both instances**, solely owning critical workflows in each.
- A **shared external system**: a **Salesforce** credential present in both
  instances, referenced by at least one workflow in each.

**Companion commands.**
- `pnpm seed:unlock` re-applies the E2E license/quota flags to both instances
  (they live in memory and are lost on an n8n restart or reset) without touching
  the seeded data — a fast fix when the estate is intact but the flags dropped.
- `pnpm n8n:up` just launches the two instances (what `pnpm seed` calls internally
  to guarantee they're running).

## Non-goals

- **No ingestion, sync, or analysis.** M1 only *creates* the estate; reading it
  back into Argus is M2+. The verify checks read n8n's own APIs, not Argus.
- **No Log Streaming destination.** PLAN's seeder step 9 points log streaming at
  the Argus receiver — which does not exist until M2. Deliberately deferred.
- **No large synthetic fleet** (`seed:large`, ~1–2k workflows) — that is M5.5.
- **No data tables** this milestone.
- **No `../n8n` modification** — the reference checkout is run, never edited.
- The **rename-only re-enrichment behavior** is out of scope (M2); only the
  renamed-workflow artifact is planted.

## Contracts consumed

Every n8n shape the seeder relies on is captured live in `contracts/` (rule 1):

- `n8n-01-e2e-feature-patch.json` — E2E license unlock (`PATCH /rest/e2e/feature`,
  `/rest/e2e/quota`); re-applied after every reset.
- Reset with members, login, API-key mint — encoded in `scripts/lib/n8n-client.mjs`
  and exercised by every probe run.
- `n8n-10-project-create.json` — create a team project.
- `n8n-11-project-add-users.json` — add a member (`relations:[{userId, role}]`).
- `n8n-12-credential-create.json` — create a credential inside a project.
- `n8n-13-workflow-create-in-project.json` — create a workflow inside a project
  (the `shared[]` → project link).
- `n8n-14-workflow-activate.json` — activate a workflow.
- `n8n-08-workflow-run.json` — manual run → an execution (deterministic failure).
- `n8n-09-webhook-exec.json` — production webhook hit → an execution.
- `n8n-05-workflow-shared-shape.json` — ownership-inference input (used by verify).
- Ports: see `DISCOVERY.md` — `:5679` is n8n's task-runner broker by default; the
  seeder moves each instance's broker off the main port.

## Acceptance criteria

<!-- Each maps to a row in `pnpm verify`; the number is the owner's sanity-check. -->

- [ ] **Two isolated E2E instances up** — prod :5678 and staging :5679 both answer
      `/healthz` and accept an E2E patch. → 2/2.
- [ ] **4 team projects per instance** — the four named projects exist on each. → 4.
- [ ] **Workflow count per instance in range** — 25–30 workflows each. → ~27.
- [ ] **Sub-workflow chain depth 3** — Order Intake → Enrich → Billing linked by
      real ids. → 3.
- [ ] **"Send Slack Alert" fan-in = 5** — exactly 5 workflows call it. → 5.
- [ ] **Exactly one broken reference** — one executeWorkflow id resolves to 404. → 1.
- [ ] **Exactly one orphan** — "Old CSV Import", inactive, zero inbound calls. → 1.
- [ ] **Deliberate failures present** — Stripe Reconciliation has error-only history;
      Zendesk Sync and Data Quality Sentinel each have both success and error. → 1 + 2.
- [ ] **Single-owner-critical** — one person solely owns 5 critical workflows. → 5.
- [ ] **Archived-but-called** — one archived workflow is still called by a live
      (non-archived) workflow. → 1.
- [ ] **Cross-instance webhook edge** — a staging HTTP node's URL host+path matches
      a prod webhook. → 1.
- [ ] **Shared-identity SPOF** — the same email is a user in both instances. → 2.
- [ ] **Shared Salesforce** — a Salesforce credential exists and is referenced in
      both instances. → 2.
- [ ] **Two MCP-exposed workflows** — one benign, one sensitive. → 2.
