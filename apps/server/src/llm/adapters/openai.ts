import { postJson } from '../http.js';
import { zodToStrictJsonSchema } from '../schema-to-jsonschema.js';
import { LlmError, type LlmClient, type LlmClientConfig, type StructuredOutputArgs, type StructuredResult } from '../types.js';

/**
 * OpenAI adapter — the structured-output seam via `response_format: json_schema`
 * (strict), coded to the wire shape captured in contracts/llm-openai-structured.json
 * (standing rule 1). Enrichment pins reasoning_effort='minimal' (probe-tuned: 3x faster
 * / ~2.6x cheaper than default, identical category/criticality).
 */
export function createOpenAiAdapter(config: LlmClientConfig): LlmClient {
  const timeoutMs = config.timeoutMs ?? 30_000;
  return {
    provider: 'openai',
    model: config.model,

    async structuredOutput<T>(args: StructuredOutputArgs<T>): Promise<StructuredResult<T>> {
      const jsonSchema = zodToStrictJsonSchema(args.schema);
      const body = {
        model: config.model,
        reasoning_effort: config.reasoningEffort ?? 'minimal',
        max_completion_tokens: args.maxTokens,
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: args.schemaName, strict: true, schema: jsonSchema } },
      };
      const { json } = await postJson('https://api.openai.com/v1/chat/completions', { authorization: `Bearer ${config.apiKey}` }, body, {
        timeoutMs,
        signal: args.signal,
        provider: 'openai',
      });

      const j = json as {
        choices?: Array<{ message?: { content?: string; refusal?: string | null }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const choice = j.choices?.[0];
      if (choice?.message?.refusal) {
        throw new LlmError('schema_parse', `openai refused: ${choice.message.refusal}`, false);
      }
      const content = choice?.message?.content;
      if (!content) throw new LlmError('schema_parse', 'openai returned no content', false);

      let value: T;
      try {
        value = args.schema.parse(JSON.parse(content));
      } catch (err) {
        throw new LlmError('schema_parse', `openai output failed schema validation: ${(err as Error).message}`, false);
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

    // eslint-disable-next-line require-yield
    async *streamToolLoop() {
      throw new LlmError('not_implemented', 'openai streaming tool loop lands in S7 (chat)', false);
    },
  };
}
