import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ChatView from './ChatView.vue';
import { useChatStore, type ChatMessage } from '../stores/chat';

/**
 * S7 chat UI-presence (standing rule 11): the view, composer, tool chips, and
 * clickable workflow references render with their stable data-testids. We drive the
 * store directly (no network) so the presence checks are fast and deterministic.
 */
const stubs = { WorkflowDetailDrawer: true };

describe('ChatView', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('renders the view, composer, and canonical-question examples when empty', () => {
    const w = mount(ChatView, { global: { stubs } });
    expect(w.find('[data-testid="chat-view"]').exists()).toBe(true);
    expect(w.find('[data-testid="chat-input"]').exists()).toBe(true);
    expect(w.find('[data-testid="chat-send"]').exists()).toBe(true);
    expect(w.findAll('[data-testid="chat-example"]').length).toBeGreaterThan(0);
  });

  it('renders messages, tool chips, and a clickable workflow reference from surfaced refs', async () => {
    const w = mount(ChatView, { global: { stubs } });
    const store = useChatStore();
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      text: 'Daily Stripe Reconciliation is failing, owned by Sarah.',
      tools: [{ id: 't1', name: 'search_catalog', arg: 'health = failing', ok: true, summary: '1 workflow' }],
      refs: [{ instanceId: 'prod', id: 'a', name: 'Daily Stripe Reconciliation' }],
      streaming: false,
      error: null,
    };
    store.messages.push({ id: 'u1', role: 'user', text: "what's failing?", tools: [], refs: [], streaming: false, error: null }, assistant);
    await w.vm.$nextTick();

    expect(w.findAll('[data-testid="chat-message"]').length).toBe(2);
    expect(w.find('[data-testid="chat-tool-chip"]').exists()).toBe(true);
    const refs = w.findAll('[data-testid="chat-workflow-ref"]');
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((r) => r.text().includes('Daily Stripe Reconciliation'))).toBe(true);
  });

  it('renders two same-named workflows on different instances as TWO distinct clickable refs', async () => {
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

    const refs = w.findAll('[data-testid="chat-workflow-ref"]');
    // Two distinct references (not collapsed to one), labeled by instance.
    expect(refs.length).toBe(2);
    const labels = refs.map((r) => r.text());
    expect(labels.some((t) => t.includes('(prod)'))).toBe(true);
    expect(labels.some((t) => t.includes('(staging)'))).toBe(true);
  });

  it('shows the streaming indicator while an answer is in flight', async () => {
    const w = mount(ChatView, { global: { stubs } });
    const store = useChatStore();
    store.messages.push({ id: 'a2', role: 'assistant', text: '', tools: [], refs: [], streaming: true, error: null });
    await w.vm.$nextTick();
    expect(w.find('[data-testid="chat-streaming"]').exists()).toBe(true);
  });
});
