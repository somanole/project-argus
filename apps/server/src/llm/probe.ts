import { z } from 'zod';
import { postJson } from './http.js';
import { createOpenAiAdapter } from './adapters/openai.js';
import { LlmError, type CapabilityProbeResult, type LlmClientConfig } from './types.js';

/**
 * Capability-probing an OpenAI-compatible endpoint (DECISION #30, Principle 7, rule 5).
 *
 * We PROBE the two wrapper seams instead of assuming them, because on a customer-chosen
 * endpoint + model neither is guaranteed. Captured against real servers in
 * contracts/llm-openai-compatible.json:
 *
 *   - Seam 1 (structured output) is broadly supported.
 *   - Seam 2 (tool calls) is the fragile one. `phi4-mini` accepts a `tools` array, ignores
 *     it, and returns confident prose with finish_reason 'stop'. An unprobed chat on that
 *     model would answer governance questions from nothing. That is the failure this
 *     probe exists to prevent — hence "chat unavailable on this provider", never a guess.
 *
 * Two rules learned from the real endpoint, both counter-intuitive:
 *   1. The probe must use `tool_choice: 'auto'` — i.e. run the ACTUAL seam. With
 *      `tool_choice: 'required'` even the tool-CAPABLE llama3.2 degraded to emitting a
 *      fake call as plain text. Probing a different shape than production answers a
 *      different question.
 *   2. "Emits a tool call" is a CAPABILITY claim, not a quality one. A small model can
 *      call tools and still ignore the result. Answer quality is the eval's job (H1/H4),
 *      not the probe's — see EXPERIMENT.md.
 */

/** Thrown when the endpoint isn't a reachable OpenAI-compatible API at all — a config error. */
export class EndpointUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointUnreachableError';
  }
}

const PROBE_TIMEOUT_MS = 20_000;

/** Seam-1 shape: trivial, cheap, and unambiguous. */
const probeSchema = z.object({ ok: z.boolean() });

/**
 * Step 0 — is this an OpenAI-compatible chat endpoint that answers at all? Distinguishes
 * "your URL/model/key is wrong" (a config error the user must fix, surfaced as 400) from
 * "this endpoint works but can't do seam X" (recorded as a capability, config saved).
 */
async function probeReachable(config: LlmClientConfig, signal?: AbortSignal): Promise<void> {
  const url = `${(config.baseUrl ?? '').replace(/\/+$/, '')}/chat/completions`;
  const headers = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
  try {
    const { json } = await postJson(
      url,
      headers,
      { model: config.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
      { timeoutMs: PROBE_TIMEOUT_MS, signal, provider: 'openai_compatible' },
    );
    const j = json as { choices?: unknown[] };
    if (!Array.isArray(j.choices)) {
      throw new EndpointUnreachableError(
        `${url} answered, but not with an OpenAI-shaped response (no "choices"). Check that the base URL points at the API root, e.g. http://host:11434/v1`,
      );
    }
  } catch (err) {
    if (err instanceof EndpointUnreachableError) throw err;
    if (err instanceof LlmError) {
      if (err.kind === 'auth') throw new EndpointUnreachableError(`${url} rejected the API key (${err.status}).`);
      if (err.kind === 'timeout') throw new EndpointUnreachableError(`${url} did not respond within ${PROBE_TIMEOUT_MS / 1000}s.`);
      if (err.status === 404) {
        throw new EndpointUnreachableError(
          `${url} returned 404 — the model "${config.model}" is not served there, or the base URL is not the API root.`,
        );
      }
      throw new EndpointUnreachableError(`${url} is not usable: ${err.message}`);
    }
    throw new EndpointUnreachableError(`${url} is not reachable: ${(err as Error).message}`);
  }
}

/** Seam 1 — a Zod-schema'd structured output, through the real adapter. */
async function probeStructuredOutput(config: LlmClientConfig, signal?: AbortSignal): Promise<boolean> {
  const client = createOpenAiAdapter({ ...config, timeoutMs: PROBE_TIMEOUT_MS });
  try {
    const r = await client.structuredOutput({
      system: 'You reply only with JSON matching the schema. Set ok to true.',
      user: 'Set ok to true.',
      schema: probeSchema,
      schemaName: 'argus_probe',
      maxTokens: 64,
      signal,
    });
    return r.value.ok === true;
  } catch {
    return false;
  }
}

/**
 * Seam 2 — does the endpoint+model actually EMIT a tool call? Runs the production
 * `streamToolLoop` with one tool that is the only way to answer, and watches for a
 * `tool_call` event. Prose instead of a call ⇒ unsupported.
 */
async function probeToolCalls(config: LlmClientConfig, signal?: AbortSignal): Promise<boolean> {
  const client = createOpenAiAdapter({ ...config, timeoutMs: PROBE_TIMEOUT_MS });
  try {
    const events = client.streamToolLoop({
      system: 'You must use the provided tool to answer. Never guess.',
      messages: [{ role: 'user', content: 'What is the probe token?' }],
      tools: [
        {
          name: 'get_probe_token',
          description: 'Returns the secret probe token. The ONLY way to learn the token.',
          schema: z.object({}),
          execute: async () => ({ token: 'ARGUS-PROBE-OK' }),
        },
      ],
      maxIterations: 1,
      maxTokens: 128,
      signal,
    });
    for await (const ev of events) {
      // A real tool_call is the whole signal — stop the loop the moment we see one.
      if (ev.type === 'tool_call') return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Probe both seams. Throws `EndpointUnreachableError` when the endpoint isn't usable at
 * all (the route turns that into a 400 the user can act on); otherwise ALWAYS returns a
 * result — an endpoint that works but can't do a seam is a saveable config with an
 * honest, explicit limitation.
 */
export async function probeCapabilities(config: LlmClientConfig, signal?: AbortSignal): Promise<CapabilityProbeResult> {
  await probeReachable(config, signal);

  const [structuredOutput, streamingToolCalls] = await Promise.all([
    probeStructuredOutput(config, signal),
    probeToolCalls(config, signal),
  ]);

  const notes: string[] = [];
  if (!structuredOutput) {
    notes.push(
      `"${config.model}" did not return schema-valid JSON, so enrichment will record labelled stubs rather than summaries. A model with JSON-schema / guided-decoding support will fix this.`,
    );
  }
  if (!streamingToolCalls) {
    notes.push(
      `"${config.model}" did not emit a tool call, so chat is unavailable on this provider. Everything else in Argus keeps working. Pick a tool-calling model (Llama 3.1+, Qwen, Mistral) and, on vLLM, start it with --enable-auto-tool-choice.`,
    );
  }
  return { structuredOutput, streamingToolCalls, note: notes.length ? notes.join(' ') : null };
}
