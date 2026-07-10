import { postJson } from '../http.js';
import { zodToStrictJsonSchema } from '../schema-to-jsonschema.js';
import { invokeTool } from '../tool-loop.js';
import {
  LlmError,
  type LlmClient,
  type LlmClientConfig,
  type StructuredOutputArgs,
  type StructuredResult,
  type StreamToolLoopArgs,
  type ToolLoopEvent,
  type TokenUsage,
} from '../types.js';

/**
 * The OpenAI-wire adapter — serves BOTH the hosted `openai` provider and the
 * `openai_compatible` provider (vLLM / TGI / Ollama / LM Studio / a corporate gateway),
 * which is the same wire format against a configurable base URL (DECISION #30). There is
 * deliberately no Ollama adapter: Ollama already speaks this format on `/v1`.
 *
 * Seam 1 (structured output) via `response_format: json_schema` (strict), coded to the
 * wire shape captured in contracts/llm-openai-structured.json (standing rule 1).
 * Enrichment pins reasoning_effort='minimal' on hosted OpenAI (probe-tuned: 3x faster /
 * ~2.6x cheaper than default, identical category/criticality).
 *
 * Three things differ for `openai_compatible`, each captured from a REAL endpoint in
 * contracts/llm-openai-compatible.json rather than assumed:
 *   1. `reasoning_effort` is an OpenAI-only field — Ollama returns HTTP 400 on
 *      'minimal'. We never send it off-OpenAI.
 *   2. `max_completion_tokens` is SILENTLY IGNORED by Ollama (a cap of 5 produced 152
 *      tokens, finish_reason 'stop'); the legacy `max_tokens` IS honored. Sending the
 *      OpenAI field would leave generation — and the spend cap — unbounded, which is
 *      exactly the kind of silent wrongness rule 5 forbids. So compat sends `max_tokens`.
 *   3. The API key is OPTIONAL; with none we omit the Authorization header entirely.
 */

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/** The single place a request URL is chosen — nothing else in the adapter knows a host. */
function endpointOf(config: LlmClientConfig): string {
  if (config.provider !== 'openai_compatible') return OPENAI_ENDPOINT;
  if (!config.baseUrl) throw new LlmError('unknown', 'openai_compatible requires a base URL', false);
  return `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function authOf(config: LlmClientConfig): Record<string, string> {
  // Keyless self-hosted endpoints: send no Authorization header at all.
  return config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
}

/**
 * The output-token ceiling + tuning knobs, per the captured contract. Hosted OpenAI keeps
 * its exact previous body; a compatible endpoint gets the field it actually honors.
 */
function tuningOf(config: LlmClientConfig, maxTokens: number): Record<string, unknown> {
  if (config.provider === 'openai_compatible') return { max_tokens: maxTokens };
  return { reasoning_effort: config.reasoningEffort ?? 'minimal', max_completion_tokens: maxTokens };
}

export function createOpenAiAdapter(config: LlmClientConfig): LlmClient {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const endpoint = endpointOf(config);
  const headers = authOf(config);
  // The label used in error messages / http mapping — names the destination honestly.
  const label = config.provider;

  return {
    provider: config.provider,
    model: config.model,

    async structuredOutput<T>(args: StructuredOutputArgs<T>): Promise<StructuredResult<T>> {
      const jsonSchema = zodToStrictJsonSchema(args.schema);
      const body = {
        model: config.model,
        ...tuningOf(config, args.maxTokens),
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: args.schemaName, strict: true, schema: jsonSchema } },
      };
      const { json } = await postJson(endpoint, headers, body, {
        timeoutMs,
        signal: args.signal,
        provider: label,
      });

      const j = json as {
        choices?: Array<{ message?: { content?: string; refusal?: string | null }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const choice = j.choices?.[0];
      if (choice?.message?.refusal) {
        throw new LlmError('schema_parse', `${label} refused: ${choice.message.refusal}`, false);
      }
      const content = choice?.message?.content;
      if (!content) throw new LlmError('schema_parse', `${label} returned no content`, false);

      let value: T;
      try {
        value = args.schema.parse(JSON.parse(content));
      } catch (err) {
        throw new LlmError('schema_parse', `${label} output failed schema validation: ${(err as Error).message}`, false);
      }
      const u = j.usage ?? {};
      return {
        value,
        usage: {
          inputTokens: u.prompt_tokens ?? 0,
          outputTokens: u.completion_tokens ?? 0,
          totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
        },
      };
    },

    /**
     * The streaming tool loop (S7 chat) — a manual model↔tool loop over Chat
     * Completions with `tools` + `tool_choice: auto`. Non-streaming per model call
     * (reuses the shared http path + error mapping); each ITERATION yields the chips
     * and, once the model stops calling tools, the answer text. Tool dispatch goes
     * through `invokeTool` (validate → execute → structured error), identical to
     * Anthropic.
     *
     * On `openai_compatible` the caller only reaches here when the capability probe saw
     * a real tool call (see probe.ts) — an endpoint that ignores `tools` would otherwise
     * answer from nothing, confidently and wrongly.
     */
    async *streamToolLoop(args: StreamToolLoopArgs): AsyncIterable<ToolLoopEvent> {
      const tools = args.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, strict: true, parameters: zodToStrictJsonSchema(t.schema) },
      }));
      // Provider-native message accumulator (system + the neutral history).
      const messages: unknown[] = [
        { role: 'system', content: args.system },
        ...args.messages.map((m) => ({ role: m.role, content: m.content })),
      ];
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      for (let iter = 0; iter < args.maxIterations; iter++) {
        const body = {
          model: config.model,
          ...tuningOf(config, args.maxTokens ?? 1500),
          messages,
          tools,
          tool_choice: 'auto',
        };
        const { json } = await postJson(endpoint, headers, body, {
          timeoutMs,
          signal: args.signal,
          provider: label,
        });
        const j = json as {
          choices?: Array<{
            message?: {
              content?: string | null;
              tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
            };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        usage.inputTokens += j.usage?.prompt_tokens ?? 0;
        usage.outputTokens += j.usage?.completion_tokens ?? 0;
        usage.totalTokens = usage.inputTokens + usage.outputTokens;

        const message = j.choices?.[0]?.message;
        const toolCalls = message?.tool_calls ?? [];

        if (toolCalls.length === 0) {
          const text = message?.content ?? '';
          if (text) yield { type: 'text', text };
          yield { type: 'done', usage };
          return;
        }

        // Record the assistant's turn (with its tool_calls) so tool messages refer to it.
        messages.push({ role: 'assistant', content: message?.content ?? null, tool_calls: message?.tool_calls });
        for (const tc of toolCalls) {
          const id = tc.id ?? '';
          const name = tc.function?.name ?? '';
          let parsedInput: unknown = {};
          try {
            parsedInput = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            parsedInput = { __unparseable: tc.function?.arguments };
          }
          yield { type: 'tool_call', id, name, input: parsedInput };
          const r = await invokeTool(args.tools, name, parsedInput, args.signal);
          yield { type: 'tool_result', id, name, ok: r.ok, summary: r.summary };
          messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(r.output) });
        }
      }
      // Hit the iteration cap without a final answer (rule 5: say so, don't invent one).
      yield { type: 'text', text: 'I reached my tool-call limit before I could finish that. Try narrowing the question.' };
      yield { type: 'done', usage };
    },
  };
}
