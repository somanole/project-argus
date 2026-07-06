import { describe, it, expect } from 'vitest';
import type { RawRef } from './refs.js';
import { resolveRef, resolveRefs } from './resolve.js';

const idSet = new Set(['sub1', 'sub2', 'szF9uw2j9YjIVLCR']);
const nameById = new Map([
  ['sub1', 'Billing Service'],
  ['sub2', 'Enrich Customer'],
  ['szF9uw2j9YjIVLCR', 'Enrich Customer'],
]);

const raw = (over: Partial<RawRef>): RawRef => ({
  kind: 'subWorkflow',
  nodeId: 'n1',
  nodeName: 'Call X',
  mode: 'list',
  rawValue: 'sub1',
  cachedName: null,
  isExpression: false,
  dynamicSource: false,
  ...over,
});

describe('resolveRef — the zero-false-broken truth table', () => {
  it('resolves a present id (mode=id) with its name', () => {
    const d = resolveRef(raw({ mode: 'id', rawValue: 'sub1' }), idSet, true, nameById);
    expect(d.resolution).toBe('resolved');
    expect(d.resolvedId).toBe('sub1');
    expect(d.resolvedName).toBe('Billing Service');
  });

  it('resolves a present id in list mode (n8n stores the id in `value`)', () => {
    const d = resolveRef(raw({ mode: 'list', rawValue: 'szF9uw2j9YjIVLCR' }), idSet, true, nameById);
    expect(d.resolution).toBe('resolved');
  });

  it('marks an absent literal id as BROKEN — only when the id set is complete', () => {
    const d = resolveRef(raw({ mode: 'list', rawValue: '00000000-0000-4000-8000-000000000000', cachedName: 'Scoring Model (deleted)' }), idSet, true, nameById);
    expect(d.resolution).toBe('broken');
    expect(d.resolvedId).toBeNull();
    expect(d.resolvedName).toBeNull();
  });

  it('NEVER says broken when the id set is incomplete (partial sync)', () => {
    const d = resolveRef(raw({ mode: 'id', rawValue: 'does-not-exist' }), idSet, false, nameById);
    expect(d.resolution).toBe('unresolved');
  });

  it('degrades an expression-valued id to dynamic (never broken)', () => {
    const d = resolveRef(raw({ mode: 'id', rawValue: '={{ $json.wfId }}', isExpression: true }), idSet, true, nameById);
    expect(d.resolution).toBe('dynamic');
  });

  it('degrades a dynamic source (inline/url) to dynamic', () => {
    const d = resolveRef(raw({ mode: 'unknown', rawValue: null, dynamicSource: true }), idSet, true, nameById);
    expect(d.resolution).toBe('dynamic');
  });

  it('degrades a by-name resource locator to unresolved (a name is not an id)', () => {
    const d = resolveRef(raw({ mode: 'name', rawValue: 'Billing Service' }), idSet, true, nameById);
    // Even though "Billing Service" IS a known name, we refuse to match by name.
    expect(d.resolution).toBe('unresolved');
  });

  it('degrades url / unknown modes to dynamic / unresolved (never broken)', () => {
    expect(resolveRef(raw({ mode: 'url', rawValue: 'http://x' }), idSet, true, nameById).resolution).toBe('dynamic');
    expect(resolveRef(raw({ mode: 'unknown', rawValue: 'weird' }), idSet, true, nameById).resolution).toBe('unresolved');
  });

  it('treats an empty value as dynamic, not broken', () => {
    const d = resolveRef(raw({ mode: 'id', rawValue: '' }), idSet, true, nameById);
    expect(d.resolution).toBe('dynamic');
  });

  it('preserves cachedName as a display hint but never uses it to resolve', () => {
    const d = resolveRef(raw({ mode: 'list', rawValue: 'absent', cachedName: 'Looks Real' }), idSet, true, nameById);
    expect(d.resolution).toBe('broken');
    expect(d.cachedName).toBe('Looks Real');
    expect(d.resolvedName).toBeNull();
  });
});

describe('resolveRefs — the guarantee holds across a batch', () => {
  it('emits broken ONLY for absent literal ids under a complete set', () => {
    const refs: RawRef[] = [
      raw({ mode: 'id', rawValue: 'sub1' }), // resolved
      raw({ mode: 'list', rawValue: 'ghost' }), // broken
      raw({ mode: 'name', rawValue: 'sub1' }), // unresolved (name)
      raw({ mode: 'id', rawValue: '={{x}}', isExpression: true }), // dynamic
      raw({ mode: 'unknown', rawValue: null, dynamicSource: true }), // dynamic
    ];
    const out = resolveRefs(refs, idSet, true, nameById);
    const broken = out.filter((d) => d.resolution === 'broken');
    expect(broken).toHaveLength(1);
    expect(broken[0]!.rawValue).toBe('ghost');
    // No broken among the degraded shapes.
    expect(out.filter((d) => d.resolution === 'broken' && (d.mode === 'name' || d.mode === 'expression')).length).toBe(0);
  });
});
