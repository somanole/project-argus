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
 * Anthropic adapter — the structured-output seam via a single FORCED tool_use (the tool
 * input_schema is our strict JSON schema; tool_choice forces it), coded to the shape in
 * contracts/llm-anthropic-structured.json. NOTE: that contract is PENDING a real probe
 * (no key at capture time) — this must be re-verified against the live API before
 * Anthropic H1 numbers are reported (standing rule 1). One prompt, both providers
 * (DECISION #25): the same system/user strings the OpenAI adapter receives.
 */
export function createAnthropicAdapter(config: LlmClientConfig): LlmClient {
  const timeoutMs = config.timeoutMs ?? 30_000;
  return {
    provider: 'anthropic',
    model: config.model,

    async structuredOutput<T>(args: StructuredOutputArgs<T>): Promise<StructuredResult<T>> {
      const inputSchema = zodToStrictJsonSchema(args.schema);
      const body = {
        model: config.model,
        max_tokens: args.maxTokens,
        system: args.system,
        tools: [{ name: args.schemaName, description: 'Emit the structured result.', input_schema: inputSchema }],
        tool_choice: { type: 'tool', name: args.schemaName },
        messages: [{ role: 'user', content: args.user }],
      };
      const { json } = await postJson('https://api.anthropic.com/v1/messages', { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }, body, {
        timeoutMs,
        signal: args.signal,
        provider: 'anthropic',
      });

      const j = json as {
        content?: Array<{ type: string; input?: unknown }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const toolUse = j.content?.find((b) => b.type === 'tool_use');
      if (!toolUse || toolUse.input === undefined) {
        throw new LlmError('schema_parse', `anthropic returned no tool_use block (stop_reason=${j.stop_reason})`, false);
      }
      let value: T;
      try {
        value = args.schema.parse(toolUse.input);
      } catch (err) {
        throw new LlmError('schema_parse', `anthropic output failed schema validation: ${(err as Error).message}`, false);
      }
      const u = j.usage ?? {};
      return {
        value,
        usage: {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        },
      };
    },

    /**
     * The streaming tool loop (S7 chat) — a manual model↔tool loop over the Messages
     * API, coded to the tool_use/tool_result shape. Non-streaming per model call
     * (reuses the shared http path + error mapping); each ITERATION yields the chips
     * and, once the model stops calling tools, the answer text. Tool dispatch goes
     * through `invokeTool` (validate → execute → structured error), identical to OpenAI.
     */
    async *streamToolLoop(args: StreamToolLoopArgs): AsyncIterable<ToolLoopEvent> {
      const tools = args.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: zodToStrictJsonSchema(t.schema),
      }));
      // Provider-native message accumulator (content is a string or a block array).
      const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = args.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      for (let iter = 0; iter < args.maxIterations; iter++) {
        const body = {
          model: config.model,
          max_tokens: args.maxTokens ?? 1500,
          system: args.system,
          tools,
          messages,
        };
        const { json } = await postJson(
          'https://api.anthropic.com/v1/messages',
          { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
          body,
          { timeoutMs, signal: args.signal, provider: 'anthropic' },
        );
        const j = json as {
          content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
          stop_reason?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        usage.inputTokens += j.usage?.input_tokens ?? 0;
        usage.outputTokens += j.usage?.output_tokens ?? 0;
        usage.totalTokens = usage.inputTokens + usage.outputTokens;

        const blocks = j.content ?? [];
        const toolUses = blocks.filter((b) => b.type === 'tool_use');

        if (toolUses.length === 0) {
          const text = blocks
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text)
            .join('');
          if (text) yield { type: 'text', text };
          yield { type: 'done', usage };
          return;
        }

        // Record the assistant's turn (verbatim blocks) so the tool_result refers to it.
        messages.push({ role: 'assistant', content: blocks });
        const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
        for (const tu of toolUses) {
          const id = tu.id ?? '';
          const name = tu.name ?? '';
          yield { type: 'tool_call', id, name, input: tu.input };
          const r = await invokeTool(args.tools, name, tu.input, args.signal);
          yield { type: 'tool_result', id, name, ok: r.ok, summary: r.summary };
          toolResults.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(r.output) });
        }
        messages.push({ role: 'user', content: toolResults });
      }
      // Hit the iteration cap without a final answer (rule 5: say so, don't invent one).
      yield { type: 'text', text: 'I reached my tool-call limit before I could finish that. Try narrowing the question.' };
      yield { type: 'done', usage };
    },
  };
}
