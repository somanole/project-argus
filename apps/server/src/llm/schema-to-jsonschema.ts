import { z, type ZodTypeAny } from 'zod';

/**
 * Convert one Zod schema to the STRICT JSON Schema both providers' structured-output
 * modes want: `additionalProperties: false` and EVERY property in `required` (OpenAI
 * strict mode's rule; Anthropic's forced tool_use accepts the same shape). This is the
 * single source of truth — the Zod schema — so the wire schema can't drift from what we
 * validate against (proven identical to contracts/llm-openai-structured.json by a test).
 *
 * It handles only the flat constructs our enrichment schema uses (object / string /
 * enum / array-of-enum / number / boolean) and THROWS on anything else, so adding a
 * nullable/union/record field to an LLM schema fails loudly instead of silently
 * emitting a schema the provider will reject or misinterpret (standing rule 5).
 */
export type JsonSchema = Record<string, unknown>;

export function zodToStrictJsonSchema(schema: ZodTypeAny): JsonSchema {
  return convert(schema);
}

function convert(s: ZodTypeAny): JsonSchema {
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = convert(val);
      required.push(key); // strict mode: every property is required
    }
    return { type: 'object', additionalProperties: false, properties, required };
  }
  if (s instanceof z.ZodString) return { type: 'string' };
  if (s instanceof z.ZodNumber) return { type: 'number' };
  if (s instanceof z.ZodBoolean) return { type: 'boolean' };
  if (s instanceof z.ZodEnum) return { type: 'string', enum: [...(s.options as string[])] };
  if (s instanceof z.ZodArray) return { type: 'array', items: convert(s.element as ZodTypeAny) };

  const typeName = (s?._def as { typeName?: string } | undefined)?.typeName ?? 'unknown';
  throw new Error(
    `zodToStrictJsonSchema: unsupported Zod type '${typeName}'. LLM schemas must stay ` +
      `flat (object/string/enum/array-of-enum/number/boolean). Add support deliberately.`,
  );
}
