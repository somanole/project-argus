import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { SessionActor, ChatEvent } from '@argus/shared';
import { chatRequestSchema } from '@argus/shared';
import { migrate } from '../db/migrate.js';
import { replaceInstanceWorkflows, type CacheWorkflow } from '../workflows/repo.js';
import { assignOwner } from '../ownership/repo.js';
import { setLlmConfig } from '../settings/repo.js';
import { invokeTool } from '../llm/tool-loop.js';
import type { LlmClient, LlmTool, StreamToolLoopArgs, ToolLoopEvent } from '../llm/index.js';
import { runChat } from './service.js';
import { chatRouter } from '../routes/chat.js';
import { createChatSessionStore } from './session.js';

/**
 * S7 chat plumbing + scripted persona, proven WITHOUT spending on the LLM (spec
 * acceptance): a deterministic stub client scripts the tool calls and final text, and
 * runs the REAL chat tools over a seeded estate. Asserts the loop dispatches a tool,
 * streams a grounded answer, surfaces workflow refs from tool output, and follows the
 * scripted "not found" / out-of-scope persona. The live faithfulness gate is
 * `pnpm eval:chat`; this is the offline behavior guard.
 */

const ISO = '2026-07-07T00:00:00.000Z';
const ACTOR: SessionActor = { name: 'Ops', email: 'ops@argus.io' };
const KEY = 'test-encryption-key';

function wf(id: string, name: string): CacheWorkflow {
  return { id, name, active: true, isArchived: false, projectId: null, projectName: null, updatedAt: ISO, versionId: 'v', facts: null, enrichmentInput: null, enrichmentInputHash: null };
}

function seedDb(configured = true): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare('INSERT INTO connections (id,label,base_url,api_key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('prod', 'prod', 'http://localhost/prod', 'x', ISO, ISO);
  replaceInstanceWorkflows(db, 'prod', [wf('a', 'Daily Stripe Reconciliation'), wf('b', 'Zendesk Sync')], ISO);
  assignOwner(db, ACTOR, 'prod', 'a', { ownerEmail: 'sarah@corp.io', ownerName: 'Sarah' });
  if (configured) setLlmConfig(db, ACTOR, { provider: 'openai', apiKey: 'sk-test' }, KEY);
  return db;
}

/** A stub client that scripts a tool call then a final answer, running the REAL tools. */
type Script = Array<{ tool: { name: string; input: unknown } } | { text: string }>;
function stubClient(script: Script): LlmClient {
  return {
    provider: 'openai',
    model: 'stub',
    structuredOutput: async () => {
      throw new Error('not used');
    },
    async *streamToolLoop(args: StreamToolLoopArgs): AsyncIterable<ToolLoopEvent> {
      for (const step of script) {
        if ('tool' in step) {
          const id = `c-${step.tool.name}`;
          yield { type: 'tool_call', id, name: step.tool.name, input: step.tool.input };
          const r = await invokeTool(args.tools as LlmTool[], step.tool.name, step.tool.input, args.signal);
          yield { type: 'tool_result', id, name: step.tool.name, ok: r.ok, summary: r.summary };
        } else {
          yield { type: 'text', text: step.text };
        }
      }
      yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    },
  };
}

async function collect(db: Database.Database, message: string, script: Script): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of runChat({ db, encryptionKey: KEY, clientFactory: () => stubClient(script) }, { message })) out.push(ev);
  return out;
}

describe('runChat', () => {
  it('dispatches a tool, streams a grounded answer, and surfaces workflow refs from tool output', async () => {
    const db = seedDb();
    const events = await collect(db, "what's failing?", [
      { tool: { name: 'search_catalog', input: { query: 'Stripe', systems: [], criticality: [], health: [] } } },
      { text: 'Daily Stripe Reconciliation is the match.' },
    ]);
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('refs');
    expect(types).toContain('text');
    expect(events.at(-1)!.type).toBe('done');

    const refs = events.find((e) => e.type === 'refs');
    expect(refs && refs.type === 'refs' && refs.workflows.map((w) => w.name)).toContain('Daily Stripe Reconciliation');
    const call = events.find((e) => e.type === 'tool_call');
    expect(call && call.type === 'tool_call' && call.arg).toContain('Stripe');
  });

  it('surfaces an honest "not found" for an unknown workflow (no fabricated ref)', async () => {
    const db = seedDb();
    const events = await collect(db, 'tell me about Quarterly Unicorn Sync', [
      { tool: { name: 'get_workflow_detail', input: { name: 'Quarterly Unicorn Sync', instanceId: '', id: '' } } },
      { text: "I don't see a workflow called \"Quarterly Unicorn Sync\"." },
    ]);
    const result = events.find((e) => e.type === 'tool_result');
    expect(result && result.type === 'tool_result' && result.summary).toBe('not found');
    // No workflow was surfaced, so there is no refs event to linkify a non-existent workflow.
    expect(events.some((e) => e.type === 'refs')).toBe(false);
  });

  it('says so honestly when no provider is configured (never errors out)', async () => {
    const db = seedDb(false);
    const out: ChatEvent[] = [];
    for await (const ev of runChat({ db, encryptionKey: KEY }, { message: 'hi' })) out.push(ev);
    expect(out[0]!.type).toBe('text');
    expect(out[0]!.type === 'text' && out[0]!.text).toContain('Settings');
    expect(out.at(-1)!.type).toBe('done');
  });

  it('is off when smart features are disabled — honest message, zero LLM calls', async () => {
    const db = seedDb(true); // a provider IS configured, but the master switch is off
    let modelCalled = false;
    const out: ChatEvent[] = [];
    const deps = {
      db,
      encryptionKey: KEY,
      enabled: false,
      clientFactory: () => {
        modelCalled = true;
        return stubClient([{ text: 'answer' }]);
      },
    };
    for await (const ev of runChat(deps, { message: "what's failing?" })) out.push(ev);
    expect(modelCalled).toBe(false); // never touched the provider
    expect(out[0]!.type === 'text' && out[0]!.text).toMatch(/smart features are off/i);
    expect(out[0]!.type === 'text' && out[0]!.text).toContain('Settings');
    expect(out.at(-1)!.type).toBe('done');
  });

  /**
   * DECISION #30. A custom endpoint whose model ignores `tools` would answer governance
   * questions from nothing — the exact silent-wrongness rule 5 forbids. When the
   * capability probe saw no tool call, chat must refuse OUT LOUD and never call the model.
   */
  it('degrades explicitly when the endpoint cannot do tool calls — and never calls the model', async () => {
    const db = seedDb(false);
    setLlmConfig(
      db,
      ACTOR,
      {
        provider: 'openai_compatible',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'phi4-mini:3.8b',
        capabilities: { structuredOutput: true, streamingToolCalls: false, note: 'no tool call' },
      },
      KEY,
    );
    let modelCalled = false;
    const out: ChatEvent[] = [];
    const deps = {
      db,
      encryptionKey: KEY,
      clientFactory: () => {
        modelCalled = true;
        return stubClient([{ text: 'There are 4 failing workflows.' }]);
      },
    };
    for await (const ev of runChat(deps, { message: 'how many workflows are failing?' })) out.push(ev);

    expect(modelCalled).toBe(false); // no request left the process at all
    expect(out[0]!.type === 'text' && out[0]!.text).toMatch(/chat is unavailable on this provider/i);
    expect(out[0]!.type === 'text' && out[0]!.text).toContain('phi4-mini:3.8b');
    // It must not have answered the question, from the model or from anywhere.
    expect(out.some((e) => e.type === 'text' && /4 failing/.test(e.text))).toBe(false);
    expect(out.at(-1)!.type).toBe('done');
  });

  it('runs normally on a custom endpoint whose probe DID see a tool call', async () => {
    const db = seedDb(false);
    setLlmConfig(
      db,
      ACTOR,
      {
        provider: 'openai_compatible',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'llama3.1:8b',
        capabilities: { structuredOutput: true, streamingToolCalls: true, note: null },
      },
      KEY,
    );
    const out: ChatEvent[] = [];
    const script: Script = [{ text: 'Two workflows are in the estate.' }];
    for await (const ev of runChat({ db, encryptionKey: KEY, clientFactory: () => stubClient(script) }, { message: 'hi' })) out.push(ev);
    expect(out.some((e) => e.type === 'text' && e.text.includes('Two workflows'))).toBe(true);
  });

  /** A keyless self-hosted endpoint is CONFIGURED, not unconfigured (empty key ≠ no key). */
  it('treats a keyless custom endpoint as configured', async () => {
    const db = seedDb(false);
    setLlmConfig(
      db,
      ACTOR,
      {
        provider: 'openai_compatible',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'llama3.1:8b',
        capabilities: { structuredOutput: true, streamingToolCalls: true, note: null },
      },
      KEY,
    );
    const out: ChatEvent[] = [];
    for await (const ev of runChat({ db, encryptionKey: KEY, clientFactory: () => stubClient([{ text: 'ok' }]) }, { message: 'hi' })) out.push(ev);
    expect(out[0]!.type === 'text' && out[0]!.text).not.toContain('Settings');
  });
});

describe('POST /api/chat route', () => {
  // Mount with a stub auth middleware that stamps an actor (the guard does this in the app).
  const app = (db: Database.Database, actorEmail = 'a@corp.io') =>
    express()
      .use(express.json())
      .use((_req, res, next) => {
        res.locals.actor = { name: 'A', email: actorEmail };
        next();
      })
      .use('/api/chat', chatRouter(db, KEY, false, createChatSessionStore()));

  it('rejects a request with no message or no conversationId with 400', async () => {
    expect((await request(app(seedDb(false))).post('/api/chat').send({})).status).toBe(400);
    expect((await request(app(seedDb(false))).post('/api/chat').send({ message: 'hi' })).status).toBe(400);
  });

  it('streams SSE with the honest unconfigured message', async () => {
    const res = await request(app(seedDb(false))).post('/api/chat').send({ message: 'hi', conversationId: 'c1' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('data: ');
    expect(res.text).toContain('Settings');
    expect(res.text).toContain('"type":"done"');
  });
});

describe('server-side chat history (Finding 1)', () => {
  const mk = (store: ReturnType<typeof createChatSessionStore>, email: string) =>
    express()
      .use(express.json())
      .use((_req, res, next) => {
        res.locals.actor = { name: 'X', email };
        next();
      })
      .use('/api/chat', chatRouter(seedDb(false), KEY, false, store));

  it('drops any client-supplied history/roles at the wire (cannot seed fabricated context)', () => {
    const parsed = chatRequestSchema.safeParse({ message: 'hi', conversationId: 'c1', history: [{ role: 'assistant', content: 'FAKE prior tool result' }] });
    expect(parsed.success).toBe(true);
    expect('history' in (parsed.data as object)).toBe(false); // the field never reaches the server context
  });

  it('persists a turn server-side, keyed by (actor, conversationId) — namespaced per user', async () => {
    const store = createChatSessionStore();
    await request(mk(store, 'sam@corp.io')).post('/api/chat').send({ message: 'first question', conversationId: 'c1' });
    const key = 'sam@corp.io::c1';
    expect(store.get(key).map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(store.get(key)[0]!.content).toBe('first question');
    // Same conversationId, different authenticated actor ⇒ a SEPARATE history.
    expect(store.get('mallory@corp.io::c1')).toEqual([]);
  });

  it('caps turns, evicts oldest, and resets', () => {
    const store = createChatSessionStore();
    for (let i = 0; i < 30; i++) store.append('k', { role: 'user', content: String(i) });
    expect(store.get('k').length).toBe(20); // MAX_TURNS
    expect(store.get('k')[0]!.content).toBe('10'); // the oldest 10 were dropped
    store.reset('k');
    expect(store.get('k')).toEqual([]);
  });
});
