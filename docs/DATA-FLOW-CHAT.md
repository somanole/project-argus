# Chat data-flow — what leaves Argus (owner sign-off)

<!--
The S7 egress surface (spec .agents/specs/chat.md). This one-pager is the owner's review
surface for EXACTLY what a chat turn sends to an LLM provider. It is grounded in the code
that builds the egress:
  - apps/server/src/chat/service.ts   (runChat — assembles the request)
  - apps/server/src/chat/prompt.ts    (the system prompt)
  - apps/server/src/chat/tools.ts     (every tool's returned shape = the estate egress)
  - packages/shared/src/facts.ts      (the raw facts object get_workflow_detail returns)
If any of those change, this page changes in the same session (standing rule 9).

Companion to docs/DATA-FLOW.md (enrichment). Read that first — this page is deliberately
contrasted against it, because chat's surface is WIDER and less-guarded, and the owner
must sign off on that difference knowingly.
-->

**One chat turn → a growing request → one provider.** Unlike enrichment (one workflow →
one small fixed payload), a chat turn is a **tool loop**: the model is sent the system
prompt + tool definitions + the conversation so far + your message; it calls tools; each
**tool result is appended and sent again** on the next iteration (up to 8 iterations).
The provider is the one **you** chose in Settings (OpenAI **or** Anthropic — the *same*
one enrichment uses); the payload is identical either way, only the destination host
differs. Chat is **read-only** against n8n and against Argus's own DB — it egresses data,
it never writes.

> ✅ **Headline (read this first).** After the S7 egress security review, chat's egress
> is hardened on four fronts (all enforced by `pnpm verify` —
> [`egress.test.ts`](../apps/server/src/chat/egress.test.ts) +
> [`service.test.ts`](../apps/server/src/chat/service.test.ts)):
> 1. **Redaction backstop on EVERY tool result.** Each tool's output is run through the
>    same secret scrubber enrichment uses ([`chat/redact.ts`](../apps/server/src/chat/redact.ts))
>    — a key/JWT/token/connection-string pasted into any free text becomes
>    `[REDACTED:<kind>]`. **Identifier fields** (`instanceId`, `id`, …) are exempt so
>    clickable references and follow-up tool calls keep working.
> 2. **`get_workflow_detail` facts are shaped to an allowlist** (Findings 2 + 4; DECISIONS
>    #26 + #28) — no raw request URLs, **no internal hostnames**, **no webhook paths**, and
>    **no raw n8n expression strings** or credential names leave. System identity comes from
>    the safe `systems` field; shape from counts.
> 3. **Owner/actor emails do NOT leave by default** (Finding 6; DECISION #29) — tool results
>    carry names only; emails require an explicit opt-in (`ARGUS_CHAT_EGRESS_EMAILS=true`).
> 4. **Conversation history is server-side** (Finding 1) — the client can't seed fabricated
>    prior turns; keyed by the authenticated actor, so no cross-user access.
>
> No credential *values*, API keys, raw URLs, hostnames, or execution payloads ever leave.
> The one remaining by-design item (per-turn volume) is in **Findings** below.

---

## 1. What leaves every turn, regardless of the estate (no data, just contracts)

| Egress | Content | Source |
|---|---|---|
| **System prompt** | The grounding + scripted-persona instructions. Static text; contains no estate data. | [`prompt.ts`](../apps/server/src/chat/prompt.ts) |
| **Tool definitions** | For each of the **10 tools**: its `name`, its one-line `description`, and its **input** JSON schema (field names + enum values like `critical/high/medium/low`, `failing/degraded/…`). Static contracts; no estate data. | [`tools.ts`](../apps/server/src/chat/tools.ts) |

## 2. What leaves every turn from the conversation (user-provided)

| Egress | Content | Notes |
|---|---|---|
| **Your message** | The exact free text you type. | Whatever you write leaves verbatim. |
| **Conversation history** | The prior turns (your earlier messages + the assistant's earlier answers), bounded to the **last 20 turns**. | Held **SERVER-SIDE**, in-memory, keyed by your authenticated identity + an opaque `conversationId` — the client sends only the new message, never prior turns (Finding 1). Only user messages and the model's own answers are stored (never raw tool results), so nothing that skipped the current turn's egress controls can be replayed. Not persisted; lost on restart. |

## 3. What leaves from tool results — the estate data surface

This is the substantive egress. Only tools the model actually calls contribute, but over a
conversation it can reach all of them. Below is **every field each tool returns**, then a
consolidated inventory with a plain risk read.

### Per-tool returned shape

| Tool | Returns (per row unless noted) |
|---|---|
| `search_catalog` / `system_map` | For up to ~40 workflows: `instanceId, id, name, instance` label, `active, archived`, `systems[]`, `mcpExposed`, `brokenRefs` count, enrichment `category/criticality/summary/riskFlags`, `health` status, `failureRate`, and **owner** `{status, name, email, backup{name,email}}`. `system_map` adds an `emailCapable` boolean. |
| `get_workflow_detail` | The compact workflow above **plus the raw `facts` object** — see §3.1 (this is the widest surface). |
| `impact_analysis` | `focus` (workflow name), `mode`, `affectedTotal`, `instancesSpanned`, `possibleExcluded`, and `affected[]` = `{instanceId, id, name, hops}`. |
| `ownership_query` | `person{name,email}`, `ownedTotal`, `criticalOwned`, `singlePointOfFailureCount`, and `workflows[]` = `{instanceId, id, name, criticality, active, hasBackup, singlePointOfFailure}`; or (unowned scope) up to 50 `{instanceId, id, name, criticality, hasInferredLead}`. |
| `governance_gaps` | Counts, plus workflow sets: unowned `{name, criticality}`, single-owner `{owner{email,name}, workflows[]}`, personal-space `{name, person{email,name}}`, no-backup `{name, owner{email,name}}`. |
| `mcp_exposure` | Per MCP-exposed workflow: `{instanceId, id, name}`, `owner` (compact, incl. email), `reachesSensitive`, `reachableSystems[]`, and `reachableWorkflows[]` names. |
| `fleet_stats` | `score`, five `pillars` `{key, label, score, scored, reason}` (reason is generic English), `unownedTotal`, `unownedByCriticality`, `failing`, `degraded`, `mcpExposed`, `reachingSensitive`. Aggregate numbers + labels only. |
| `audit_log` / `changelog` | Per entry: `ts`, **`actor` name + `actorEmail`**, `action`, `entity` (`type:id`), and (audit_log) `detail` — the **before→after ownership snapshot**, which contains owner emails/names and the free-text **`reason`** typed at assignment time. |

### 3.1 `get_workflow_detail` → the raw `facts` object (the widest surface)

`facts` is returned verbatim from the analyzer ([`facts.ts`](../packages/shared/src/facts.ts)).
It includes, beyond the safe derived fields (node types, trigger types, systems, counts,
coverage):

`get_workflow_detail` sends a **shaped allowlist** (`shapeFacts` in
[`tools.ts`](../apps/server/src/chat/tools.ts)) — like every other chat tool, an explicit
field set, never the raw analyzer object:

| Sent (allowlist) | Dropped entirely |
|---|---|
| `nodeCount`, `mcpExposed` | `httpCallsites[].rawUrl` (raw request URL) |
| `nodeTypes` (n8n type ids), `triggers` (type + display) | `httpCallsites[].host` (internal hostname:port) |
| `systems` (system + via + resolved — the identity) | `httpCallsites[].webhookPath`, `webhookEndpoints[].path` |
| `credentialTypes` (types only) | `directDeps[].rawValue`, `dataTableRefs[].rawValue` (raw expressions) |
| `dependencies` (kind, resolution, resolved/cached **name**) | `credentialRefs[].credentialName` / `.credentialId` |
| `counts` (webhooks / httpCalls / dataTables / credentials) | node names, and the whole raw `facts` object |
| `coverage` (understood, unknown types, unresolved, reasons) | |

**No node parameter values, no raw URLs/hosts/paths, no raw expression strings** reach the
model. What does leave is derived topology (types, systems, counts, resolved dependency
names) — and it still passes the redaction backstop on the way out.

### 3.2 Consolidated field inventory + risk read

| Class | Fields | Risk |
|---|---|---|
| **Identifiers** | instanceId, workflow id, instance label, credential id | Low — opaque ids / labels. |
| **Free-text (scrubbed)** | workflow names, credential names, instance labels, audit `reason`, enrichment `summary` | Low — user-authored text runs through the **redaction backstop**; a pasted key/token/connection-string becomes `[REDACTED]`. (`summary` was already generated from redacted input.) |
| **PII** | owner / backup / actor **names** (emails only under opt-in) | Low by default — emails are removed unless `ARGUS_CHAT_EGRESS_EMAILS=true` (DECISION #29); names still answer "who owns X / who assigned this". |
| **Topology** (`get_workflow_detail` only) | node/trigger/credential **types**, resolved dependency **names**, counts | Low — no raw hosts, webhook paths, URLs, or expression strings leave (shaped allowlist). |
| **Derived / aggregate (safe)** | systems, category, criticality (+reason), health status, failure rate, counts, node/trigger types, pillar scores/reasons | Low — computed from types and counts, no raw values. |

## What NEVER leaves — by construction

- **Credential values, API keys, tokens, passwords** — only credential *types*, *names*,
  and *ids* ever appear; never a secret value.
- **The n8n API key and Argus's session/encryption keys** — encrypted at rest, never read
  into any tool output or log.
- **Execution run payloads and pinned data** — no chat tool returns them. Health is a
  *status + counts + failure rate* only; there is no execution-debug tool in chat (that
  stays in n8n, where chat deflects out-of-scope questions).
- **Node parameter values** — not in `facts`; the one parameter-derived string that used to
  reach the model (`rawUrl`) is dropped by the shaped allowlist (§3.1).
- **Raw hostnames, webhook paths, and n8n expression strings** — dropped by `shapeFacts`.
- **Owner/actor email addresses** — removed by default (opt-in only).
- **Anything to n8n** — chat is read-only; the only outbound call is to the LLM provider.

## The guarantees that hold

1. **Redaction backstop on EVERY tool result.** Each tool's output is scrubbed
   ([`chat/redact.ts`](../apps/server/src/chat/redact.ts)) before it reaches the model —
   keys, JWTs, tokens, connection strings, and high-entropy blobs in any free-text field
   become `[REDACTED:<kind>]`. Applied uniformly in `buildChatTools`, so a future tool is
   covered by construction; identifier keys are exempt so references keep working.
2. **Shaped facts allowlist.** `get_workflow_detail` sends `shapeFacts(...)` — an explicit
   field set; raw URLs, hostnames, webhook paths, expression strings, and credential names
   are dropped (Findings 2 + 4; DECISIONS #26 + #28).
3. **Names-only PII by default.** Owner/actor emails are removed unless
   `ARGUS_CHAT_EGRESS_EMAILS=true` (DECISION #29); resolution still uses email server-side.
4. **Server-side history.** History is keyed by the authenticated actor + `conversationId`,
   held in memory; the client cannot supply prior turns (Finding 1), so it cannot seed
   fabricated context and cannot read another user's conversation.
5. **Read-only blast radius.** All tools are reads; the LLM cannot mutate anything. This —
   not the system prompt — is the real bound on what chat can do.
6. **Your key is encrypted at rest** (AES-256-GCM) and never returned by any API or logged.
7. **Kill switch.** No provider configured in Settings → chat answers honestly that it is
   unavailable and makes **zero** calls; the rest of Argus is unaffected.
8. **Prompt-injection: best-effort mitigation, not a guarantee.** The system prompt *asks*
   the model to treat tool text as data and ignore embedded instructions, and the injection
   case is in the eval — but a prompt instruction is not enforceable. The enforceable bound
   is #5 (read-only tools) + the egress controls above: even if the model were fully
   derailed, it can only read, and only the scrubbed/allowlisted fields ever leave.
9. **Not persisted, not audited.** Conversation history is in-memory per session; reads are
   telemetry at most, never audit — a governance tool must not become a surveillance tool.
10. **Enforced by `pnpm verify`.** [`egress.test.ts`](../apps/server/src/chat/egress.test.ts)
    runs every tool through the wrapper (asserting no raw secret leaks), asserts the shaped
    facts drop raw host/paths/URLs/expressions, and that emails are absent by default; and
    [`service.test.ts`](../apps/server/src/chat/service.test.ts) asserts history is
    server-side and client history is dropped at the wire.

## Remaining item (knowingly accepted)

1. **Volume.** Up to 8 tool calls × up to ~40–50 rows per turn — materially more than
   enrichment's one-workflow payload. Not a leak, but relevant to the data-processing scope
   agreed with the provider.

## Destinations

- **OpenAI** — `POST https://api.openai.com/v1/chat/completions` (when OpenAI is active).
- **Anthropic** — `POST https://api.anthropic.com/v1/messages` (when Anthropic is active).

One is active at a time — the same provider/key/model Argus uses for enrichment.

---

**Sign-off:** using chat sends, per turn, the system prompt + tool contracts + your
conversation (server-held) + the tool-result fields inventoried above to the active
provider. Every tool result is secret-scrubbed, `get_workflow_detail` facts are shaped to
an allowlist, and owner/actor emails are removed by default (all enforced by `pnpm verify`);
the faithfulness gate (`pnpm eval:chat`) is green. The estate data that leaves by design is
workflow/owner **names** + governance metadata — no credential values, keys, raw URLs,
hostnames, webhook paths, emails (by default), or execution payloads.
