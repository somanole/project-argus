# LLM providers — spec

<!--
One file per subsystem, kept in sync with code (standing rule 9).
Plain-English behavior contract — the product owner's review surface, not code.
Covers the ONE provider-abstracting LLM wrapper (standing rule 6) and the three
providers behind it. Its two consumers have their own specs: enrichment.md (seam 1)
and chat.md (seam 2). Written at S8 from DECISION #30.
-->

Argus talks to exactly one LLM at a time, through **one wrapper** with **two seams**:

1. **Structured output** — a Zod-validated object. This is what **enrichment** uses.
2. **Streaming tool loop** — the model calls Argus's read-only tools. This is what **chat** uses.

No caller ever sees provider specifics. There are three providers.

| Provider | You supply | Model | Endpoint |
|---|---|---|---|
| `openai` | API key | `gpt-5-mini` (pinned by Argus) | `api.openai.com` |
| `anthropic` | API key | `claude-haiku-4-5` (pinned by Argus) | `api.anthropic.com` |
| `openai_compatible` | Base URL + model id, **key optional** | **yours** | **yours** |

## Behavior

**The deployment mode is the point.** `openai_compatible` is the OpenAI wire format
pointed at a base URL you choose — vLLM, TGI, Ollama, LM Studio, or a corporate LLM
gateway. Pointed at an endpoint inside your own network, **no estate metadata leaves
that network**: not workflow names, not owner names, not governance metadata. Every
request Argus makes goes to the configured base URL and nowhere else.

**Its API key is optional.** Self-hosted endpoints are commonly keyless. With no key,
Argus sends no `Authorization` header at all. "Configured with no key" and "not
configured" are different states and are never confused.

**Its model is yours, so Argus pins nothing.** The hosted providers get a model chosen
by us; a custom endpoint gets the model id you type, exactly as the endpoint names it.
Argus never invents a default model for an endpoint it doesn't own (rule 5).

**Seam support is probed, never assumed.** When you save a custom endpoint, Argus asks
it two questions by actually running both seams against it:

- *Can it return schema-valid JSON?* → enrichment works.
- *Will it emit a real tool call?* → chat works.

The second question is the fragile one: it depends on the **model** and on the **server**.
A model can accept a `tools` array, ignore it entirely, and reply with fluent prose — which
for a governance tool means a confident answer assembled from nothing. So when the probe
sees no tool call, **chat is switched off for that provider and says so out loud**
("chat unavailable on this provider"), enrichment keeps working, and the reason is shown
in Settings. Argus never guesses (Principle 7, standing rule 5).

Saving distinguishes two failures honestly:

- **Unreachable / wrong model / rejected key** → the save is refused with a plain-English
  reason. Nothing is stored.
- **Reachable but seam-limited** → the config is saved, and the limitation is recorded and
  displayed. A partly-capable endpoint is a usable endpoint.

**A base URL is a destination for your data.** The API key — and every payload — goes to
whatever host is configured, so the scheme is validated (`http`/`https` only) and
credentials embedded in the URL are refused. Private and loopback addresses are
deliberately **allowed**: reaching an in-VPC endpoint is the entire purpose. A plain
`http://` endpoint is allowed too, but it means estate metadata travels **unencrypted on
your internal network** — Settings flags it and the data-flow docs state it, rather than
letting it pass silently. **Every provider or base-URL change is an audit-logged config
mutation** (Principle 9), recording who changed it, to what endpoint, whether it is
keyless, whether transport is insecure, and what the probe found. The key itself is
encrypted at rest and never appears in the audit log, any API response, or any log line.

**Changing the endpoint re-enriches.** Two different endpoints can serve the same model
id, so the endpoint is part of enrichment's freshness key. Repointing the base URL
re-enriches the estate rather than silently keeping summaries a different model wrote.

**Quality is a property of the model you choose.** Our quality bar (H1 for enrichment,
H4 for chat faithfulness) is pre-registered against the reference provider. A
customer-chosen open-weight model is measured against **that same bar** and reported per
provider — never pre-certified, never given its own easier target. `pnpm eval --provider
openai_compatible` prints the score and states plainly that it certifies *that* model on
*that* endpoint and nothing more. Small models can score far below the bar and are more
susceptible to prompt injection; the harness reports both rather than hiding them.

## Non-goals

- **No Ollama-specific adapter.** Ollama already exposes an OpenAI-compatible `/v1`.
  One configurable base URL covers vLLM, TGI, Ollama, LM Studio, gateways, and the
  open-weight cloud hosts. A second wire format would be maintenance debt for nothing.
- **No native Bedrock / Azure SDK adapters.** Different wire formats. Azure is largely
  OpenAI-compatible and Bedrock can sit behind a gateway. Deferred until a customer asks.
- **No per-call provider routing** and **no per-provider prompt forks.** One active
  provider, one prompt. If two providers diverge on the same prompt, that is a finding to
  surface, not a reason to fork.
- **Argus does not certify your model.** It measures it and tells you the truth.
- **The probe does not measure answer quality.** "Can emit a tool call" is a capability
  claim, not a quality claim — a small model can call tools and still ignore the result.
  Quality is the eval's job.

## Contracts consumed

Captured from a **real** OpenAI-compatible endpoint (Ollama 0.16.3 `/v1`, standing rule 1),
not from memory of the OpenAI API. Three findings materially changed the implementation:

- [`contracts/llm-openai-compatible.json`](../../contracts/llm-openai-compatible.json)
  - `reasoning_effort` is an **OpenAI-only** field — the endpoint returns **HTTP 400** on
    `"minimal"`. It is never sent off hosted OpenAI.
  - `max_completion_tokens` is **silently ignored** (a cap of 5 produced 152 tokens,
    `finish_reason: "stop"`); the legacy `max_tokens` **is** honored. The compat path sends
    `max_tokens`, or the output-token ceiling — and the spend cap resting on it — would be
    a lie.
  - `tool_choice: "required"` is **not honored**, and made even a tool-*capable* model
    degrade to emitting a fake call as plain text. The capability probe therefore uses
    `tool_choice: "auto"` — the exact shape production uses. Probing a different shape
    answers a different question.
- [`contracts/llm-openai-structured.json`](../../contracts/llm-openai-structured.json) — the
  hosted OpenAI shape, unchanged by this slice.

## Acceptance criteria

<!-- Each is a concrete checkable behavior; each maps to a row in `pnpm verify`. -->

**The deployment mode (the reason this exists).**
- [x] With a self-hosted endpoint configured, **no request goes to any external host** —
      every request the wrapper makes targets the configured base URL.
- [x] README and **both** data-flow one-pagers state "with a self-hosted endpoint, nothing
      leaves your network", name the configured endpoint under **Destinations**, and state
      that plain `http://` means estate metadata travels **unencrypted**.

**Configuration.**
- [x] Base URL + model (+ **optional** API key) is configurable in Settings, and enrichment
      then runs against it; switching between OpenAI / Anthropic / the custom endpoint all
      work.
- [x] A **keyless** endpoint is a configured endpoint: no `Authorization` header is sent,
      and it is never treated as "unconfigured".
- [x] The base URL is validated — scheme must be `http`/`https`, embedded credentials are
      refused — while **private and loopback hosts are allowed** (the in-VPC case).
- [x] A base-URL change is an **audit-logged config mutation**, recording endpoint, keyless,
      insecure transport, and probed capabilities — **never the key**.
- [x] An unreachable endpoint, wrong model, or rejected key **refuses the save** with a
      plain-English reason; a reachable-but-limited endpoint **saves** with its limitation
      recorded.
- [x] Repointing the base URL **re-enriches** the estate (the endpoint is part of the
      freshness key), rather than keeping another model's summaries.

**Capability probing — never a silently wrong answer.**
- [x] Both seams are **probed on configuration**, using the same request shape production
      uses (`tool_choice: "auto"`).
- [x] A model that ignores `tools` and answers in prose is detected: chat degrades to
      **"chat unavailable on this provider"**, no model call is made for chat at all, and
      **enrichment keeps working**.
- [x] Settings shows the probe verdict per seam, with a plain-English remedy.
- [x] The wire body matches the captured contract: `reasoning_effort` is never sent to a
      custom endpoint, and the token ceiling uses the field the endpoint actually honors.

**Eval (DECISION #25, extended by #30).**
- [x] The harness is provider-parameterized: `pnpm eval --provider openai_compatible` and
      `pnpm eval:chat --provider openai_compatible` run against your endpoint.
- [x] The scorecard states plainly that **H1/H4 depend on the chosen model** and certify
      only that model on that endpoint.
- [x] `pnpm eval:chat` **refuses to score** an endpoint that cannot emit tool calls, rather
      than grading ungrounded prose.

### Measured, not promised — reference open-weight results

Run on 2026-07-10 against local Ollama 0.16.3 (`http://127.0.0.1:11434/v1`), the same
prompt and harness the hosted providers use:

| Model | schema-parse | category acc. | crit. within-1 | risk P / R | injection held | Verdict |
|---|---|---|---|---|---|---|
| `llama3.2:3b` | 100% | 72.2% | 83.3% | 12.5% / 11.1% | **1/3** | **BELOW H1** |

Read this as the spec intends: **the wrapper works, the model doesn't.** Seam 1 is fully
supported (100% schema-parse — every response was valid against the Zod schema), so the
integration is sound; the *judgment* is weak, and on a 3B model the injection defense
largely fails (it obeyed an injected label and echoed a marker). This is exactly why H1
is reported per-model and never pre-certified, and why the README tells operators to
measure their own model. A larger open-weight model (Llama 3.1 8B+, Qwen 14B+) is the
realistic floor for enrichment quality; `phi4-mini:3.8b` additionally cannot do chat at
all (no tool calls).
