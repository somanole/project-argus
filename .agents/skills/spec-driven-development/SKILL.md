---
name: spec-driven-development
description: Keeps Project Argus implementation and specs in sync. Use when starting a milestone, when working on a subsystem that has a spec in .agents/specs/, when the user says /spec, or when asked to verify implementation against a spec. Adapted for Argus's intent-driven, verify-report-gated workflow.
---

# Spec-Driven Development (Project Argus)

Specs live in `.agents/specs/`, **one file per subsystem** (`analyzer.md`,
`sync.md`, `enrichment.md`, `health-ownership.md`, `chat.md`, `frontend.md`,
`self-audit.md`, `n8n-clients.md`…). They are the plain-English behavior
contract — the product owner's review surface, **not** code. `PLAN.md` is the
fleet-level master spec; these are its per-subsystem decomposition; the verify
report is the same acceptance criteria made executable.

The product owner builds by intent and does not read code. So: **you write and
maintain the spec from their intent** — never ask them to prompt "per the spec".

## Spec file shape

Keep it to ~1–2 pages:

```markdown
# <subsystem> — spec

## Behavior
Inputs → outputs, as assertions. State it as things that must be true.

## Non-goals
What this subsystem deliberately does NOT do (stops scope creep mid-session).

## Contracts consumed
Links into `contracts/` for every n8n API/event shape this relies on.

## Acceptance criteria
- [ ] Each criterion is a concrete, checkable behavior.
- [ ] Each one maps to a row in the `pnpm verify` report.
```

## Cadence — just-in-time, never all upfront

Milestones are learning-first; each teaches the next. Do NOT pre-write specs
for future milestones — they'd be speculation that gets rewritten. Author or
update a subsystem's spec **at the start of the milestone that touches it**,
derived from `PLAN.md` + what prior milestones learned + a fresh contract probe.

## Core loop

```
Write/refresh spec from intent → confirm acceptance criteria with the owner
  → implement → each criterion becomes a verify-report check → keep spec and code in sync
```

## Before building

1. `ls .agents/specs/` — find or create the subsystem spec.
2. Read `PLAN.md` for the relevant section; read the `contracts/` it depends on
   (probe first if missing — that's a standing rule).
3. Draft/refresh the spec from the owner's intent. Surface the acceptance
   criteria to the owner in plain English before writing code.

## During implementation

- Reference spec decisions — don't re-decide what the spec settled.
- When you diverge (better approach, owner change, constraint discovered),
  **update the spec in the same session**. Never leave spec and code out of sync.
- Tick `- [ ]` → `- [x]` as acceptance criteria land in the verify report.
- Strike-through + annotate deliberately dropped items with a one-line reason.

## After completing work / on `/spec`

Run a verify-against-spec pass and report in plain English:

- **Aligned** — spec and code match, and the acceptance criterion has a live
  verify check.
- **Drift** — they diverge (fix immediately: update spec or code).
- **Gaps** — spec promises something not yet built (note as future work; a
  missing verify check is a gap).

Fix drift, update specs, report gaps + the aligned/drift/gaps summary to the
owner. Never weaken a verify check to make a spec look "aligned" — that is the
test-integrity rule, applied to specs.
