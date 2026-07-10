import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { createLlmClient } from './client.js';
import { probeCapabilities, EndpointUnreachableError } from './probe.js';

/**
 * The `openai_compatible` provider (DECISION #30). Every wire assertion here is pinned to
 * a REAL endpoint capture in contracts/llm-openai-compatible.json (standing rule 1) —
 * Ollama 0.16.3's OpenAI-compatible /v1, which is what an owner points at for local dev.
 */

const LOCAL = 'http://127.0.0.1:11434/v1';
const schema = z.object({ category: z.enum(['a', 'b']), note: z.string() });
const args = { system: 'sys', user: 'usr', schema, schemaName: 'result', maxTokens: 256 };

function res(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}
function completionOk(obj: unknown) {
  return res(200, { choices: [{ message: { content: JSON.stringify(obj), refusal: null } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
}
/** A model that emits a real tool call (llama3.2:3b behaviour). */
function toolCallOk(name = 'get_probe_token') {
  return res(200, {
    choices: [{ message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 20, completion_tokens: 4 },
  });
}
/** A model that IGNORES the tools array and answers in prose (phi4-mini behaviour). */
function prosePretendingToAnswer() {
  return res(200, {
    choices: [{ message: { content: 'There are 4 failing workflows.', tool_calls: undefined }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  });
}
const bodyOf = (m: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> => JSON.parse(String(m.mock.calls[call]?.[1]?.body));
const urlOf = (m: ReturnType<typeof vi.fn>, call = 0): string => String(m.mock.calls[call]?.[0]);
const headersOf = (m: ReturnType<typeof vi.fn>, call = 0): Record<string, string> => m.mock.calls[call]?.[1]?.headers ?? {};

afterEach(() => vi.unstubAllGlobals());

describe('openai_compatible — nothing leaves the configured network', () => {
  it('sends the structured-output call ONLY to the configured base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionOk({ category: 'a', note: 'hi' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient({ provider: 'openai_compatible', apiKey: '', model: 'llama3.1:8b', baseUrl: LOCAL });
    await client.structuredOutput(args);

    expect(urlOf(fetchMock)).toBe(`${LOCAL}/chat/completions`);
    // The acceptance criterion, asserted literally: no external host is contacted.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toMatch(/api\.openai\.com|api\.anthropic\.com/);
      expect(new URL(String(call[0])).hostname).toBe('127.0.0.1');
    }
  });

  it('sends the tool-loop call ONLY to the configured base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, { choices: [{ message: { content: 'done' } }], usage: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient({ provider: 'openai_compatible', apiKey: '', model: 'm', baseUrl: LOCAL });
    for await (const _ of client.streamToolLoop({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [], maxIterations: 2 })) {
      /* drain */
    }
    expect(urlOf(fetchMock)).toBe(`${LOCAL}/chat/completions`);
  });

  it('never double-slashes the endpoint when the base URL has a trailing slash', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionOk({ category: 'a', note: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    await createLlmClient({ provider: 'openai_compatible', apiKey: '', model: 'm', baseUrl: `${LOCAL}/` }).structuredOutput(args);
    expect(urlOf(fetchMock)).toBe(`${LOCAL}/chat/completions`);
  });
});

describe('openai_compatible — the wire body matches the captured contract', () => {
  it('omits reasoning_effort (an OpenAI-only field; Ollama 400s on "minimal")', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionOk({ category: 'a', note: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    // Enrichment's factory passes reasoningEffort for every provider — it must not escape.
    await createLlmClient({ provider: 'openai_compatible', apiKey: '', model: 'm', baseUrl: LOCAL, reasoningEffort: 'minimal' }).structuredOutput(args);
    expect(bodyOf(fetchMock)).not.toHaveProperty('reasoning_effort');
  });

  it('caps output with max_tokens, NOT max_completion_tokens (which Ollama silently ignores)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionOk({ category: 'a', note: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    await createLlmClient({ provider: 'openai_compatible', apiKey: '', model: 'm', baseUrl: LOCAL }).structuredOutput(args);
    const body = bodyOf(fetchMock);
    // A silently-ignored cap means unbounded generation and an unbounded spend meter.
    expect(body).toHaveProperty('max_tokens', 256);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('omits the Authorization header entirely when the endpoint is keyless', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionOk({ category: 'a', note: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    await createLlmClient({ provider: 'openai_compatible', apiKey: '', model: 'm', baseUrl: LOCAL }).structuredOutput(args);
    expect(headersOf(fetchMock)).not.toHaveProperty('authorization');
  });

  it('sends a Bearer token when a key IS supplied (gateways require one)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionOk({ category: 'a', note: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    await createLlmClient({ provider: 'openai_compatible', apiKey: 'sk-gw', model: 'm', baseUrl: LOCAL }).structuredOutput(args);
    expect(headersOf(fetchMock).authorization).toBe('Bearer sk-gw');
  });
});

describe('hosted openai — unchanged by the third provider', () => {
  it('still posts to api.openai.com with reasoning_effort + max_completion_tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionOk({ category: 'a', note: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    await createLlmClient({ provider: 'openai', apiKey: 'sk', model: 'gpt-5-mini' }).structuredOutput(args);
    expect(urlOf(fetchMock)).toBe('https://api.openai.com/v1/chat/completions');
    const body = bodyOf(fetchMock);
    expect(body).toHaveProperty('reasoning_effort', 'minimal');
    expect(body).toHaveProperty('max_completion_tokens', 256);
    expect(body).not.toHaveProperty('max_tokens');
    expect(headersOf(fetchMock).authorization).toBe('Bearer sk');
  });
});

describe('capability probe — seam support is measured, never assumed', () => {
  const cfg = { provider: 'openai_compatible' as const, apiKey: '', model: 'llama3.1:8b', baseUrl: LOCAL };

  it('reports BOTH seams supported for a tool-calling model', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, { choices: [{ message: { content: 'pong' } }] })) // reachability
      .mockResolvedValue(completionOk({ ok: true })); // seam 1
    // Seam 2 runs concurrently with seam 1 — resolve tool calls for any later call.
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
      if (body.tools) return toolCallOk();
      return res(200, { choices: [{ message: { content: '{"ok":true}' } }], usage: {} });
    });
    vi.stubGlobal('fetch', fetchMock);

    const caps = await probeCapabilities(cfg);
    expect(caps).toMatchObject({ structuredOutput: true, streamingToolCalls: true, note: null });
  });

  it('detects a model that IGNORES tools and answers in prose — the silent-wrongness case', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
      if (body.tools) return prosePretendingToAnswer();
      return res(200, { choices: [{ message: { content: '{"ok":true}' } }], usage: {} });
    });
    vi.stubGlobal('fetch', fetchMock);

    const caps = await probeCapabilities({ ...cfg, model: 'phi4-mini:3.8b' });
    expect(caps.structuredOutput).toBe(true); // enrichment still works…
    expect(caps.streamingToolCalls).toBe(false); // …but chat must NOT run on this model.
    expect(caps.note).toMatch(/chat is unavailable/i);
  });

  it('records seam-1 failure without throwing — the config is still saveable and honest', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { tools?: unknown[]; response_format?: unknown };
      if (body.tools) return toolCallOk();
      if (body.response_format) return res(200, { choices: [{ message: { content: 'I am not JSON.' } }] });
      return res(200, { choices: [{ message: { content: 'pong' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const caps = await probeCapabilities(cfg);
    expect(caps.structuredOutput).toBe(false);
    expect(caps.streamingToolCalls).toBe(true);
    expect(caps.note).toMatch(/enrichment will record labelled stubs/i);
  });

  it('throws EndpointUnreachableError on a 404 (wrong model or wrong base URL)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(404, { error: { message: "model 'nope' not found" } })));
    await expect(probeCapabilities({ ...cfg, model: 'nope' })).rejects.toBeInstanceOf(EndpointUnreachableError);
  });

  it('throws EndpointUnreachableError when the key is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(401, { error: 'bad key' })));
    await expect(probeCapabilities({ ...cfg, apiKey: 'wrong' })).rejects.toThrow(/rejected the API key/i);
  });

  it('throws EndpointUnreachableError when the URL answers but is not an OpenAI-shaped API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(200, { message: 'Ollama is running' })));
    await expect(probeCapabilities(cfg)).rejects.toThrow(/not with an OpenAI-shaped response/i);
  });

  it('probes with tool_choice "auto" — the production shape ("required" degrades real models)', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
      if (body.tools) return toolCallOk();
      return res(200, { choices: [{ message: { content: '{"ok":true}' } }], usage: {} });
    });
    vi.stubGlobal('fetch', fetchMock);
    await probeCapabilities(cfg);

    const toolCall = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body))).find((b) => b.tools);
    expect(toolCall.tool_choice).toBe('auto');
  });
});
