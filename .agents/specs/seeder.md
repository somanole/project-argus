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
- **Dummy credentials** — the curated five (Slack, Postgres, Stripe, Salesforce,
  Email; the Postgres/Stripe pair forms a "sensitive cluster") plus a handful more
  for the background fleet (Notion, HubSpot, Airtable, Telegram, Mattermost,
  MongoDB, MySQL, Google Sheets, Intercom) — placed in the projects that use them.
- **~100 workflows** created in dependency order (a workflow that calls another is
  created after its callee, so the reference points at a real id), then tagged and
  (where they have a production trigger) activated. This is **two layers**:
  - a **curated planted-problem core** (~29) — the demo story below, whose exact
    numbers the verify report pins;
  - a **procedural background fleet** (~71) — generated so the estate reads like a
    real, messy enterprise (see "The procedural background" below).
- **Real execution history, including deliberate failures** (on the curated core).

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
- **Green-but-swallowing (S6.3)**: "Inventory Sync" — every webhook run is **run-level
  success**, but its "Push to Warehouse" HTTP node hits a dead host on every run and the
  error is **swallowed** (`onError: continueRegularOutput`). n8n shows it green; Argus must
  read it as **silently failing** (offending node + error class) and flag it can-mask.
- **Mask-prone but healthy (S6.3)**: "Resilient Notifier" — same swallow config on a node
  that **never throws**, so it carries the **can-mask-failures** advisory flag but has **no**
  silent failure. (Requires `buildWorkflow` to pass a node's `onError` through to n8n.)
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

**The procedural background** (generated, `scripts/seed/procedural.mjs`) fills the
estate out to ~100 workflows per instance so the fleet — and especially the later
graph slice — looks like a real company, not a dozen tidy demo flows:
- **Diverse** — the background spans ~20 external systems (Notion, HubSpot,
  Airtable, MongoDB, MySQL, Zendesk, Asana, Linear, GitLab, Google Sheets/Calendar,
  Microsoft Teams, Telegram, Mattermost, Mailchimp, Trello, Intercom, Freshdesk,
  ClickUp, …) and every trigger kind (schedule, webhook, manual, form, chat,
  called-by-another-workflow), across all four team projects and the personal spaces.
- **Real dependency structure, not islands** — shared utility sub-workflows with
  high fan-in (one hub is called by ~12+ workflows), multi-hop sub-workflow chains,
  AI agent→tool links, and cross-project calls, so the fleet forms genuine clusters.
- **Never dilutes the planted story** — the generator references only its own
  workflows (adds **zero** broken refs and never perturbs the Slack-hub fan-in of 5),
  never touches Salesforce, and is never MCP-exposed (so those stay exactly one /
  exactly two per instance). Every node type it emits is analyzer-known, so the
  estate stays **100% understood**.
- **Deterministic** — shape is a pure function of each workflow's key, so re-seeding
  lands the identical fleet (idempotent) with identical verify numbers.
- **Factored for reuse** — `generateProceduralFleet(opts)` takes tier sizes, so the
  future scale-stress task (`seed:large`) reuses it with a bigger `scale`.

**The estate-level (cross-instance) scenarios**, wired after both instances exist:
- A **cross-instance webhook edge**: a **staging** workflow's HTTP Request calls a
  **prod** webhook URL — the scary "prod depended on by staging" finding.
- A **shared-identity single point of failure**: **one person with the same email
  in both instances**, solely owning critical workflows in each.
- A **shared external system**: a **Salesforce** credential present in both
  instances, referenced by at least one workflow in each.

**Refreshing a running Argus.** A reseed runs n8n's reset, which **wipes every n8n
API key** — so any key a running Argus had stored for a connection is now dead, and
its catalog would silently show the OLD estate until re-pointed. As its **final
step**, `pnpm seed` therefore re-points a locally-running Argus: it mints fresh
read-only keys and re-registers each connection **through Argus's own API** (so the
change is audited, rule 6). It is **best-effort** — if no Argus is running on
`ARGUS_BASE` (default `http://127.0.0.1:3000`), or its admin password isn't
`ARGUS_ADMIN_PASSWORD` (default `argus`), it logs why and skips; it never fails the
seed.

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
- [ ] **Workflow count per instance in range** — ~100 workflows each (curated core +
      procedural background). → ~100.
- [ ] **Estate is diverse** — the fleet spans ≥15 external systems and ≥5 trigger
      kinds per instance (not a repetitive handful). → 15+ / 5+.
- [ ] **Real dependency clusters** — beyond the curated Slack hub (fan-in 5), the
      background forms at least one shared sub-workflow with fan-in ≥8. → 8+.
- [ ] **Sub-workflow chain depth 3** — Order Intake → Enrich → Billing linked by
      real ids. → 3.
- [ ] **"Send Slack Alert" fan-in = 5** — exactly 5 workflows call it. → 5.
- [ ] **Exactly one broken reference** — one executeWorkflow id resolves to 404. → 1.
- [ ] **Exactly one orphan** — "Old CSV Import", inactive, zero inbound calls. → 1.
- [ ] **Deliberate failures present** — Stripe Reconciliation has error-only history;
      Zendesk Sync and Data Quality Sentinel each have both success and error. → 1 + 2.
- [ ] **Green-but-swallowing present (S6.3)** — Inventory Sync's runs are all `success`
      while its "Push to Warehouse" node swallows an error every run; Resilient Notifier
      carries the swallow config but never errors. → detected silently-failing = 1.
- [ ] **Single-owner-critical** — one person solely owns 5 critical workflows. → 5.
- [ ] **Archived-but-called** — one archived workflow is still called by a live
      (non-archived) workflow. → 1.
- [ ] **Cross-instance webhook edge** — a staging HTTP node's URL host+path matches
      a prod webhook. → 1.
- [ ] **Shared-identity SPOF** — the same email is a user in both instances. → 2.
- [ ] **Shared Salesforce** — a Salesforce credential exists and is referenced in
      both instances. → 2.
- [ ] **Two MCP-exposed workflows** — one benign, one sensitive. → 2.
