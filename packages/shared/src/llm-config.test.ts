import { describe, expect, it } from 'vitest';
import { checkBaseUrl, chatSupported, llmConfigInputSchema } from './llm-config.js';

/**
 * The base URL is an SSRF-adjacent surface: the API key is sent to whatever host is
 * configured (DECISION #30). These tests pin the guard — scheme allowlist, no embedded
 * credentials — AND pin what we deliberately ALLOW: private/loopback hosts, because an
 * in-VPC endpoint is the entire point of this provider.
 */
describe('checkBaseUrl', () => {
  it('accepts a loopback http endpoint and flags it as insecure transport', () => {
    const c = checkBaseUrl('http://127.0.0.1:11434/v1');
    expect(c.ok).toBe(true);
    expect(c.normalized).toBe('http://127.0.0.1:11434/v1');
    // Allowed, but never silently: the UI + docs must say metadata travels unencrypted.
    expect(c.insecure).toBe(true);
  });

  it('accepts private-network and https endpoints (in-VPC is the point, not a threat)', () => {
    expect(checkBaseUrl('http://10.4.2.9:8000/v1').ok).toBe(true);
    expect(checkBaseUrl('https://vllm.internal.acme.example/v1').insecure).toBe(false);
  });

  it('strips trailing slashes so the endpoint is built exactly once', () => {
    expect(checkBaseUrl('https://gw.acme.example/v1///').normalized).toBe('https://gw.acme.example/v1');
  });

  it('rejects non-http(s) schemes', () => {
    for (const raw of ['file:///etc/passwd', 'ftp://h/v1', 'gopher://h', 'javascript:alert(1)']) {
      expect(checkBaseUrl(raw).ok, raw).toBe(false);
    }
  });

  it('rejects credentials embedded in the URL (they would be logged and leak)', () => {
    const c = checkBaseUrl('https://user:secret@gw.acme.example/v1');
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/username or password/i);
  });

  it('rejects a query string or fragment, and blank input', () => {
    expect(checkBaseUrl('https://h/v1?key=leak').ok).toBe(false);
    expect(checkBaseUrl('https://h/v1#frag').ok).toBe(false);
    expect(checkBaseUrl('   ').ok).toBe(false);
    expect(checkBaseUrl('not-a-url').ok).toBe(false);
  });
});

describe('llmConfigInputSchema', () => {
  it('accepts a KEYLESS custom endpoint (self-hosted endpoints often need no key)', () => {
    const parsed = llmConfigInputSchema.parse({
      provider: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:11434/v1/',
      model: 'llama3.1:8b',
    });
    expect(parsed).toEqual({ provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1:8b' });
  });

  it('still requires a key for the hosted providers', () => {
    expect(llmConfigInputSchema.safeParse({ provider: 'openai' }).success).toBe(false);
    expect(llmConfigInputSchema.safeParse({ provider: 'anthropic', apiKey: '' }).success).toBe(false);
  });

  it('requires a base URL and a model for a custom endpoint — we never invent a model', () => {
    expect(llmConfigInputSchema.safeParse({ provider: 'openai_compatible', model: 'm' }).success).toBe(false);
    expect(llmConfigInputSchema.safeParse({ provider: 'openai_compatible', baseUrl: 'https://h/v1' }).success).toBe(false);
    expect(llmConfigInputSchema.safeParse({ provider: 'openai_compatible', baseUrl: 'ftp://h', model: 'm' }).success).toBe(false);
  });
});

describe('chatSupported', () => {
  it('is true for the hosted providers (both seams contract-tested)', () => {
    expect(chatSupported({ provider: 'openai', capabilities: null })).toBe(true);
    expect(chatSupported({ provider: 'anthropic', capabilities: null })).toBe(true);
  });

  it('for a custom endpoint, follows the PROBE — never an assumption', () => {
    const caps = (streamingToolCalls: boolean) => ({ structuredOutput: true, streamingToolCalls, probedAt: 'now', note: null });
    expect(chatSupported({ provider: 'openai_compatible', capabilities: caps(true) })).toBe(true);
    expect(chatSupported({ provider: 'openai_compatible', capabilities: caps(false) })).toBe(false);
    // Unprobed ⇒ not supported. Absence of evidence is never evidence of capability (rule 5).
    expect(chatSupported({ provider: 'openai_compatible', capabilities: null })).toBe(false);
  });

  it('is false when nothing is configured', () => {
    expect(chatSupported({ provider: null, capabilities: null })).toBe(false);
  });
});
