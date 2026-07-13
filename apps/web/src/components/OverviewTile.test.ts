import { describe, it, expect } from 'vitest';
import { mount, RouterLinkStub } from '@vue/test-utils';
import OverviewTile, { type OverviewTileData } from './OverviewTile.vue';

const tile = (over: Partial<OverviewTileData>): OverviewTileData => ({
  key: 'k', testid: 'overview-x', label: 'Stale analysis', count: 0, tone: 'warn',
  context: 'analysis has drifted', info: '', to: '/estate', dest: 'Estate', ...over,
});
const num = (t: OverviewTileData) =>
  mount(OverviewTile, { props: { tile: t }, global: { stubs: { 'router-link': RouterLinkStub } } }).find('.tile-num');

describe('OverviewTile — a clean zero of a problem metric reads GREEN, not grey', () => {
  it('problem tile (warn/danger) with a NON-zero count keeps its severity colour', () => {
    expect(num(tile({ count: 5, tone: 'warn' })).classes()).toContain('t-warn');
    expect(num(tile({ count: 3, tone: 'danger' })).classes()).toContain('t-danger');
  });

  it('problem tile (warn/danger) at ZERO reads green (0 problems is a positive signal)', () => {
    expect(num(tile({ count: 0, tone: 'warn' })).classes()).toContain('t-ok');
    expect(num(tile({ count: 0, tone: 'danger' })).classes()).toContain('t-ok');
    // Not grey any more.
    expect(num(tile({ count: 0, tone: 'danger' })).classes()).not.toContain('t-muted');
  });

  it('a non-problem tone (ok/muted) at zero stays muted (0 of a good thing isn’t itself good)', () => {
    expect(num(tile({ count: 0, tone: 'ok' })).classes()).toContain('t-muted');
    expect(num(tile({ count: 0, tone: 'muted' })).classes()).toContain('t-muted');
  });
});
