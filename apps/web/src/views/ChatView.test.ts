import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { LlmConfig } from '@argus/shared';
import ChatView from './ChatView.vue';
import { useChatStore, type ChatMessage } from '../stores/chat';
import { useSettingsStore } from '../stores/settings';

/**
 * S7 chat UI-presence (standing rule 11): the view, composer, tool chips, and
 * clickable workflow references render with their stable data-testids. We drive the
 * store directly (no network) so the presence checks are fast and deterministic.
 */
const stubs = { WorkflowDetailDrawer: true, RouterLink: true };

/** A ready-to-tweak safe LLM config (the shape Settings serves to the client). */
function llmConfig(over: Partial<LlmConfig> = {}): LlmConfig {
  return { provider: 'openai', model: 'gpt-5-mini', baseUrl: null, capabilities: null, configured: true, enabled: true, envLocked: false, ...over };
}

describe('ChatView', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('renders the view, composer, and canonical-question examples when empty', () => {
    const w = mount(ChatView, { global: { stubs } });
    expect(w.find('[data-testid="chat-view"]').exists()).toBe(true);
    expect(w.find('[data-testid="chat-input"]').exists()).toBe(true);
    expect(w.find('[data-testid="chat-send"]').exists()).toBe(true);
    expect(w.findAll('[data-testid="chat-example"]').length).toBeGreaterThan(0);
  });

  it('renders messages, tool chips, and a Referenced row with the named workflow', async () => {
    const w = mount(ChatView, { global: { stubs } });
    const store = useChatStore();
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      text: 'Daily Stripe Reconciliation is failing, owned by Sarah.',
      tools: [{ id: 't1', name: 'search_catalog', arg: 'health = failing', ok: true, summary: '1 workflow' }],
      refs: [{ instanceId: 'prod-uuid', id: 'a', name: 'Daily Stripe Reconciliation', instance: 'prod' }],
      streaming: false,
      error: null,
    };
    store.messages.push({ id: 'u1', role: 'user', text: "what's failing?", tools: [], refs: [], streaming: false, error: null }, assistant);
    await w.vm.$nextTick();

    expect(w.findAll('[data-testid="chat-message"]').length).toBe(2);
    expect(w.find('[data-testid="chat-tool-chip"]').exists()).toBe(true);
    // The answer prose stays clean; the clickable reference lives in the Referenced row,
    // labeled with the workflow name (and its instance).
    expect(w.find('[data-testid="chat-refs"]').exists()).toBe(true);
    const refs = w.findAll('[data-testid="chat-workflow-ref"]');
    expect(refs.length).toBe(1);
    expect(refs[0]!.text()).toContain('Daily Stripe Reconciliation');
    expect(refs[0]!.text()).toContain('prod');
  });

  it('lists a same-named workflow on two instances as two distinct Referenced pills', async () => {
    const w = mount(ChatView, { global: { stubs } });
    const store = useChatStore();
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      text: 'I found multiple workflows named "Send Slack Alert". Which one do you mean?',
      tools: [],
      refs: [
        { instanceId: 'prod-uuid', id: 'ss-prod', name: 'Send Slack Alert', instance: 'prod' },
        { instanceId: 'staging-uuid', id: 'ss-stg', name: 'Send Slack Alert', instance: 'staging' },
      ],
      streaming: false,
      error: null,
    };
    store.messages.push(assistant);
    await w.vm.$nextTick();

    // Two distinct references (not collapsed to one), labeled by instance so the reader
    // can tell prod from staging and open the right one.
    const refs = w.findAll('[data-testid="chat-workflow-ref"]');
    expect(refs.length).toBe(2);
    const labels = refs.map((r) => r.text());
    expect(labels.some((t) => t.includes('(prod)'))).toBe(true);
    expect(labels.some((t) => t.includes('(staging)'))).toBe(true);
  });

  it('lists each distinct workflow once even when the answer names it multiple times', async () => {
    const w = mount(ChatView, { global: { stubs } });
    const store = useChatStore();
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      // The prose names the same workflow twice — once per instance. The Referenced row
      // must dedupe: two pills (prod + staging), never four.
      text: 'KB Lookup is published on both instances. KB Lookup reaches no sensitive systems.',
      tools: [],
      refs: [
        { instanceId: 'prod-uuid', id: 'kb-prod', name: 'KB Lookup', instance: 'prod' },
        { instanceId: 'staging-uuid', id: 'kb-stg', name: 'KB Lookup', instance: 'staging' },
      ],
      streaming: false,
      error: null,
    };
    store.messages.push(assistant);
    await w.vm.$nextTick();

    const refs = w.findAll('[data-testid="chat-workflow-ref"]');
    expect(refs.length).toBe(2);
    expect(refs.map((r) => r.text()).some((t) => t.includes('(prod)'))).toBe(true);
    expect(refs.map((r) => r.text()).some((t) => t.includes('(staging)'))).toBe(true);
  });

  it('shows the streaming indicator while an answer is in flight', async () => {
    const w = mount(ChatView, { global: { stubs } });
    const store = useChatStore();
    store.messages.push({ id: 'a2', role: 'assistant', text: '', tools: [], refs: [], streaming: true, error: null });
    await w.vm.$nextTick();
    expect(w.find('[data-testid="chat-streaming"]').exists()).toBe(true);
  });

  it('shows a disabled panel and hides the composer when smart features are off', async () => {
    const w = mount(ChatView, { global: { stubs } });
    useSettingsStore().config = llmConfig({ enabled: false });
    await w.vm.$nextTick();
    expect(w.find('[data-testid="chat-disabled"]').exists()).toBe(true);
    expect(w.find('[data-testid="chat-open-settings"]').exists()).toBe(true);
    expect(w.find('[data-testid="chat-disabled"]').text()).toContain('Chat is off');
    // No dead input while it's off.
    expect(w.find('[data-testid="chat-input"]').exists()).toBe(false);
  });

  it('distinguishes the "no provider configured" reason from "off"', async () => {
    const w = mount(ChatView, { global: { stubs } });
    useSettingsStore().config = llmConfig({ enabled: true, configured: false, provider: null });
    await w.vm.$nextTick();
    expect(w.find('[data-testid="chat-disabled"]').text()).toContain('needs an AI provider');
  });

  it('shows the composer when smart features are on and the provider supports chat', async () => {
    const w = mount(ChatView, { global: { stubs } });
    useSettingsStore().config = llmConfig({ enabled: true, configured: true });
    await w.vm.$nextTick();
    expect(w.find('[data-testid="chat-disabled"]').exists()).toBe(false);
    expect(w.find('[data-testid="chat-input"]').exists()).toBe(true);
  });

  it('places the Referenced row above the answer text (under the tool chips)', async () => {
    const w = mount(ChatView, { global: { stubs } });
    const store = useChatStore();
    store.messages.push({
      id: 'a1',
      role: 'assistant',
      text: 'Order Intake is healthy.',
      tools: [{ id: 't1', name: 'search_catalog', arg: '', ok: true, summary: '1 workflow' }],
      refs: [{ instanceId: 'prod-uuid', id: 'oi', name: 'Order Intake', instance: 'prod' }],
      streaming: false,
      error: null,
    });
    await w.vm.$nextTick();

    const bubble = w.find('[data-testid="chat-message"] .bubble').element;
    const kids = Array.from(bubble.children);
    const refsIdx = kids.findIndex((el) => el.matches('[data-testid="chat-refs"]'));
    const textIdx = kids.findIndex((el) => el.classList.contains('text'));
    expect(refsIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    // The Referenced row comes before the answer prose in the DOM order.
    expect(refsIdx).toBeLessThan(textIdx);
  });
});
