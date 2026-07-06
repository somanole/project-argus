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

  it('streamToolLoop is not implemented until S7', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const client = createLlmClient({ provider: 'openai', apiKey: 'k', model: 'gpt-5-mini' });
    await expect(async () => {
      for await (const _ of client.streamToolLoop({ system: '', messages: [], tools: [], maxIterations: 1 })) void _;
    }).rejects.toMatchObject({ kind: 'not_implemented' });
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
