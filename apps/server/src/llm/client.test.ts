import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { createLlmClient } from './client.js';
import { LlmError } from './types.js';

const schema = z.object({ category: z.enum(['a', 'b']), note: z.string() });
const args = { system: 'sys', user: 'usr', schema, schemaName: 'result', maxTokens: 256 };

function res(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}
function openAiOk(obj: unknown) {
  return res(200, { choices: [{ message: { content: JSON.stringify(obj), refusal: null } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
}

afterEach(() => vi.unstubAllGlobals());

describe('createLlmClient (OpenAI seam)', () => {
  it('parses a valid structured response and reports usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(openAiOk({ category: 'a', note: 'hi' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient({ provider: 'openai', apiKey: 'k', model: 'gpt-5-mini' });
    const out = await client.structuredOutput(args);
    expect(out.value).toEqual({ category: 'a', note: 'hi' });
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries exactly once on a 429, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(429, { error: 'slow down' }))
      .mockResolvedValueOnce(openAiOk({ category: 'b', note: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient({ provider: 'openai', apiKey: 'k', model: 'gpt-5-mini' });
    const out = await client.structuredOutput(args);
    expect(out.value.category).toBe('b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on a 401 auth error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(401, { error: 'bad key' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient({ provider: 'openai', apiKey: 'k', model: 'gpt-5-mini' });
    await expect(client.structuredOutput(args)).rejects.toMatchObject({ kind: 'auth' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('raises schema_parse when the model output violates the schema', async () => {
    const fetchMock = vi.fn().mockResolvedValue(openAiOk({ category: 'z', note: 'bad enum' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient({ provider: 'openai', apiKey: 'k', model: 'gpt-5-mini' });
    await expect(client.structuredOutput(args)).rejects.toBeInstanceOf(LlmError);
    await expect(client.structuredOutput(args)).rejects.toMatchObject({ kind: 'schema_parse' });
  });

});

// --- Seam 2: the streaming tool loop (S7 chat). ---

const echoTool = {
  name: 'echo',
  description: 'echo the query back',
  schema: z.object({ q: z.string() }),
  execute: vi.fn(async (input: unknown) => ({ echoed: (input as { q: string }).q })),
  summarize: () => '1 echo',
};

function openAiToolCall(id: string, name: string, argsObj: unknown) {
  return res(200, {
    choices: [{ message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(argsObj) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}
function openAiText(text: string) {
  return res(200, { choices: [{ message: { content: text, tool_calls: [] }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3 } });
}
function anthropicToolUse(id: string, name: string, input: unknown) {
  return res(200, { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 8, output_tokens: 4 } });
}
function anthropicText(text: string) {
  return res(200, { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 6, output_tokens: 2 } });
}

async function collect(iter: AsyncIterable<{ type: string }>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const e of iter) out.push(e as Record<string, unknown>);
  return out;
}

describe('streamToolLoop — OpenAI', () => {
  afterEach(() => echoTool.execute.mockClear());

  it('calls a tool, feeds the result back, then streams the final answer', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(openAiToolCall('c1', 'echo', { q: 'hi' })).mockResolvedValueOnce(openAiText('the answer'));
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient({ provider: 'openai', apiKey: 'k', model: 'gpt-5-mini' });
    const events = await collect(client.streamToolLoop({ system: 'sys', messages: [{ role: 'user', content: 'q' }], tools: [echoTool], maxIterations: 8 }));

    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'text', 'done']);
    expect(events[0]).toMatchObject({ type: 'tool_call', name: 'echo', input: { q: 'hi' } });
    expect(events[1]).toMatchObject({ type: 'tool_result', name: 'echo', ok: true, summary: '1 echo' });
    expect(events[2]).toMatchObject({ type: 'text', text: 'the answer' });
    expect(echoTool.execute).toHaveBeenCalledWith({ q: 'hi' }, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces an invalid tool input as a structured error (no crash, no invented result)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(openAiToolCall('c1', 'echo', { wrong: 'shape' })).mockResolvedValueOnce(openAiText('handled'));
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient({ provider: 'openai', apiKey: 'k', model: 'gpt-5-mini' });
    const events = await collect(client.streamToolLoop({ system: 'sys', messages: [{ role: 'user', content: 'q' }], tools: [echoTool], maxIterations: 8 }));
    expect(events[1]).toMatchObject({ type: 'tool_result', ok: false });
    expect(echoTool.execute).not.toHaveBeenCalled();
  });
});

describe('streamToolLoop — Anthropic', () => {
  afterEach(() => echoTool.execute.mockClear());

  it('calls a tool, feeds the result back, then streams the final answer', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(anthropicToolUse('t1', 'echo', { q: 'hi' })).mockResolvedValueOnce(anthropicText('the answer'));
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient({ provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5' });
    const events = await collect(client.streamToolLoop({ system: 'sys', messages: [{ role: 'user', content: 'q' }], tools: [echoTool], maxIterations: 8 }));

    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'text', 'done']);
    expect(events[0]).toMatchObject({ type: 'tool_call', name: 'echo', input: { q: 'hi' } });
    expect(events[2]).toMatchObject({ type: 'text', text: 'the answer' });
    expect(events[3]).toMatchObject({ type: 'done', usage: { totalTokens: 20 } });
    expect(echoTool.execute).toHaveBeenCalledWith({ q: 'hi' }, undefined);
  });

  it('stops at the iteration cap with an honest message, never an invented answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicToolUse('t1', 'echo', { q: 'loop' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient({ provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5' });
    const events = await collect(client.streamToolLoop({ system: 'sys', messages: [{ role: 'user', content: 'q' }], tools: [echoTool], maxIterations: 2 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.at(-2)).toMatchObject({ type: 'text', text: expect.stringContaining('tool-call limit') });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });
});

describe('createLlmClient (Anthropic seam)', () => {
  it('parses a forced tool_use response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      res(200, { content: [{ type: 'tool_use', input: { category: 'a', note: 'via tool' } }], stop_reason: 'tool_use', usage: { input_tokens: 8, output_tokens: 4 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient({ provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5' });
    const out = await client.structuredOutput(args);
    expect(out.value).toEqual({ category: 'a', note: 'via tool' });
    expect(out.usage.totalTokens).toBe(12);
  });
});
