import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import type { AnalyzerDrift } from '@argus/shared';
import AnalyzerDriftNotice from './AnalyzerDriftNotice.vue';

const drift = (over: Partial<AnalyzerDrift>): AnalyzerDrift => ({
  manifestN8nVersion: '2.29.0',
  status: 'current',
  coreUnknown: { types: 0, workflows: 0 },
  communityUnknown: { types: 0, workflows: 0 },
  coreExamples: [],
  communityExamples: [],
  ...over,
});

const mountWith = (d: AnalyzerDrift | null) =>
  mount(AnalyzerDriftNotice, { props: { drift: d }, attrs: { 'data-testid': 'analyzer-drift' } });

describe('AnalyzerDriftNotice (UI-presence, rule 11)', () => {
  it('renders the core-drift notice with count, manifest version, and rebuild guidance', () => {
    const w = mountWith(drift({
      status: 'core-drift',
      coreUnknown: { types: 3, workflows: 2 },
      coreExamples: ['n8n-nodes-base.__futureNode', 'n8n-nodes-base.__another'],
    }));
    const el = w.find('[data-testid="analyzer-drift"]');
    expect(el.exists()).toBe(true);
    expect(el.attributes('data-drift-status')).toBe('core-drift');
    expect(w.text()).toContain('Coverage may have dropped');
    expect(w.text()).toContain('3 core node types');
    expect(w.text()).toContain('n8n 2.29.0');
    // The ACTUAL type names are listed (not "e.g."), with "+N more" for the un-listed rest.
    expect(w.text()).toContain('Unrecognized core types:');
    expect(w.text()).toContain('n8n-nodes-base.__futureNode');
    expect(w.text()).not.toContain('e.g.');
    expect(w.text()).toContain('+1 more'); // 3 total − 2 listed
    // The call-to-action is the ops rebuild path.
    expect(w.text()).toContain('How to rebuild the analyzer');
    expect(w.text()).toContain('gen:manifest');
  });

  it('renders the community-only variant with NO regenerate CTA', () => {
    const w = mountWith(drift({
      status: 'community-only',
      communityUnknown: { types: 2, workflows: 1 },
      communityExamples: ['n8n-nodes-acme.foo', 'n8n-nodes-acme.bar'],
    }));
    const el = w.find('[data-testid="analyzer-drift"]');
    expect(el.exists()).toBe(true);
    expect(el.attributes('data-drift-status')).toBe('community-only');
    expect(w.text()).toContain("can't be analyzed");
    expect(w.text()).toContain("won't add them");
    expect(w.text()).toContain('n8n-nodes-acme.foo');
    expect(w.text()).not.toContain('e.g.');
    // Never nudges a rebuild for community/custom nodes.
    expect(w.text()).not.toContain('How to rebuild the analyzer');
    expect(w.text()).not.toContain('Coverage may have dropped');
  });

  it('renders nothing for a current connection', () => {
    const w = mountWith(drift({ status: 'current' }));
    expect(w.find('[data-testid="analyzer-drift"]').exists()).toBe(false);
  });

  it('renders nothing when drift is null (never synced)', () => {
    const w = mountWith(null);
    expect(w.find('[data-testid="analyzer-drift"]').exists()).toBe(false);
  });
});
