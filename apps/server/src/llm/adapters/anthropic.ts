import { postJson } from '../http.js';
import { zodToStrictJsonSchema } from '../schema-to-jsonschema.js';
import { LlmError, type LlmClient, type LlmClientConfig, type StructuredOutputArgs, type StructuredResult } from '../types.js';

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

    // eslint-disable-next-line require-yield
    async *streamToolLoop() {
      throw new LlmError('not_implemented', 'anthropic streaming tool loop lands in S7 (chat)', false);
    },
  };
}
