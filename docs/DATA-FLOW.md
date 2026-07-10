# Enrichment data-flow — what leaves Argus (owner sign-off)

<!--
The S2 security gate (spec .agents/specs/enrichment.md — "the deliberate slow-down").
This one-pager is the owner's review surface for EXACTLY what egresses to an LLM
provider before any live call is enabled. It is grounded in the code that builds the
payload: apps/server/src/enrichment/allowlist.ts (buildEnrichmentInput). If that code
changes, this page changes in the same session (standing rule 9).
-->

**One workflow → one small JSON payload → one provider.** Enrichment sends the LLM a
strict, built-by-inclusion allowlist. The provider is the one **you** chose (OpenAI,
Anthropic, **or any OpenAI-compatible endpoint you run**); the **payload is identical
either way** — only the destination host differs. Argus is read-only against n8n and
never sends anything to n8n.

> ### With a self-hosted endpoint, nothing leaves your network.
> Point Argus at an in-VPC vLLM / TGI / Ollama / LM Studio instance, or at your own
> OpenAI-compatible gateway, and the payload below travels **only to that host**. No
> estate metadata reaches OpenAI, Anthropic, or any other third party. This is the
> complete answer to *"you send our workflow metadata to an AI vendor?"* (DECISION #30).

## What leaves the building — the complete list

For each workflow, and **nothing else**:

| Field | Example | Why it's safe |
|---|---|---|
| Workflow **name** | `"Stripe Failed Payment Dunning"` | Free-text → scrubbed by the redaction backstop |
| **Project** name | `"Revenue Ops"` | A team label, not a secret |
| **Tags** | `["billing","production"]` | Free-text → scrubbed |
| **Trigger types** | `["n8n-nodes-base.stripeTrigger"]` | n8n type identifiers, public |
| **Node names + types** | `{name:"Send dunning email", type:"…​emailSend"}` | Names are free-text → scrubbed; **no parameters** |
| **Topology summary** | `"3 nodes, 1 trigger(s), 2 connection(s), linear"` | Counts only — no names, no URLs |
| **Credential *types*** | `["stripeApi","postgres","smtp"]` | The *type*, never a credential value or name |
| **Systems** | `["Stripe","Postgres","Email"]` | Derived from credential/node **types** — never from a URL |
| **Failure stats** | `{last30dRuns:240, failures:12}` | Aggregate counts (null until S3 health) |
| **Safe facts** | `{nodeCount, mcpExposed, brokenRefCount, understood}` | Deterministic S1b counts/booleans |

## What NEVER leaves — by construction

- **Raw parameter values** of any node (the field that carries most secrets). They are
  never copied into the payload — the allowlist takes node *names + types* only.
- **Any URL, hostname, or domain** (DECISION #26). URLs are the most secret-dense field
  (query-string tokens, `user:pass@`) and internal hostnames are themselves sensitive.
  System identity comes from credential types instead — no extractor to trust.
- **Credential values or names**, API keys, tokens — the credential *type* is all that leaves.
- **Pinned data** (`excludePinnedData` on every fetch) and **execution data**.

## The guarantees behind this

1. **Inclusion, not subtraction.** The payload is assembled field-by-field
   ([allowlist.ts](../apps/server/src/enrichment/allowlist.ts)); there is no code path
   that starts from the full workflow JSON and strips secrets out.
2. **Redaction backstop.** The free-text that does leave (name, tags, node names) is run
   through a secret scrubber (keys, JWTs, tokens, connection strings, high-entropy
   blobs) before storage and before any call. Hits become `[REDACTED:kind]`.
3. **Proven by a test that runs before any live call.** The planted-secrets gate
   ([planted-secrets.test.ts](../apps/server/src/enrichment/planted-secrets.test.ts))
   plants secrets in parameters, a URL (`user:pass@` + query token), a node name, and a
   tag, then **captures the exact egress payload** and asserts every planted secret is
   absent. Provider-agnostic — one capture covers OpenAI and Anthropic.
4. **Your key is encrypted at rest** (AES-256-GCM, like n8n keys) and never returned by
   any API or written to any log.
5. **Kill switch.** `ENRICHMENT_ENABLED=false` (or no provider configured) → **zero**
   calls, and a fully usable deterministic Argus.
6. **Prompt-injection posture.** Workflow text is delimited as data; the model is
   instructed never to follow instructions found inside it (injection cases are in the
   eval set).

## Destinations

- **OpenAI** — `POST https://api.openai.com/v1/chat/completions` (when OpenAI is active).
- **Anthropic** — `POST https://api.anthropic.com/v1/messages` (when Anthropic is active).
- **Your own endpoint** — `POST <your base URL>/chat/completions` (when a custom
  OpenAI-compatible endpoint is active). The base URL is whatever you configured in
  Settings — e.g. `http://vllm.internal.acme:8000/v1` — and it is **the only host
  contacted**. It is shown in Settings and recorded in the audit log on every change.

One is active at a time. Same payload, same redaction, same allowlist either way.

**`http://` means unencrypted.** A self-hosted endpoint may legitimately be plain
`http://` on a private network, and Argus allows it — but the workflow metadata above
then travels **unencrypted across your internal network**. That is a deliberate,
stated trade-off, not an oversight: Settings flags it, and the audit entry for the
config change records `insecureTransport`. Use `https://` if the traffic leaves a
trusted segment.

**A user-supplied base URL is a destination change.** Argus validates the scheme
(`http`/`https` only) and rejects credentials embedded in the URL. It deliberately does
**not** block private or loopback addresses — reaching an in-VPC endpoint is the point.
Because the configured API key is sent to whatever host is configured, **every base-URL
change is an audit-logged config mutation** (actor, timestamp, endpoint, whether the
endpoint is keyless, whether transport is insecure, and the probed seam support).

---

**Sign-off:** enabling live enrichment sends the payload above to the active provider.
The gate test is green. With a self-hosted endpoint the active provider is a host you
operate, and nothing in this payload leaves your network.
