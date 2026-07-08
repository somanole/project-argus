import type { LlmTool } from './types.js';

/**
 * The one place a tool call is dispatched, shared by both provider adapters so the
 * manual tool loop behaves identically regardless of provider. It validates the model's
 * raw arguments against the tool's Zod schema, runs the deterministic `execute`, and
 * NEVER throws: a bad tool name, invalid input, or a failing read all come back as a
 * structured `{ error }` fed to the model — so the model says "couldn't analyze" (rule
 * 5) rather than the loop crashing or a result being invented.
 */
export interface ToolInvocation {
  ok: boolean;
  /** The JSON handed back to the model as the tool result. */
  output: unknown;
  /** Short human phrasing for the chip. */
  summary: string;
}

export async function invokeTool(
  tools: LlmTool[],
  name: string,
  rawInput: unknown,
  signal?: AbortSignal,
): Promise<ToolInvocation> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return { ok: false, output: { error: `unknown tool: ${name}` }, summary: 'unknown tool' };
  }
  let input: unknown;
  try {
    input = tool.schema.parse(rawInput ?? {});
  } catch (err) {
    return { ok: false, output: { error: `invalid tool input: ${(err as Error).message}` }, summary: 'invalid input' };
  }
  try {
    const result = await tool.execute(input, signal);
    const summary = tool.summarize ? tool.summarize(result) : defaultSummary(result);
    return { ok: true, output: result, summary };
  } catch (err) {
    return { ok: false, output: { error: `tool failed: ${(err as Error).message}` }, summary: 'tool error' };
  }
}

/** A generic result label when a tool doesn't provide its own `summarize`. */
export function defaultSummary(result: unknown): string {
  if (Array.isArray(result)) return `${result.length} result${result.length === 1 ? '' : 's'}`;
  if (result && typeof result === 'object') {
    const keys = Object.keys(result as Record<string, unknown>);
    return keys.length ? `${keys.length} field${keys.length === 1 ? '' : 's'}` : 'ok';
  }
  return 'ok';
}
