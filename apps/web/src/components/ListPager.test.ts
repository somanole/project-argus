import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ListPager from './ListPager.vue';

/** The one pager used by every list — Previous/Next + "X–Y of N", hidden on a single page. */
describe('ListPager', () => {
  const tid = (w: ReturnType<typeof mount>, id: string) => w.find(`[data-testid="${id}"]`);

  it('renders nothing when everything fits on one page', () => {
    const w = mount(ListPager, { props: { page: 0, pageSize: 50, total: 30 } });
    expect(tid(w, 'pager').exists()).toBe(false);
  });

  it('shows the page window and gates Previous on the first page', () => {
    const w = mount(ListPager, { props: { page: 0, pageSize: 50, total: 320 } });
    expect(tid(w, 'pager').exists()).toBe(true);
    expect(tid(w, 'pager-range').text()).toBe('1–50 of 320');
    expect(tid(w, 'pager-prev').attributes('disabled')).toBeDefined();
    expect(tid(w, 'pager-next').attributes('disabled')).toBeUndefined();
  });

  it('shows the tail window and gates Next on the last page', () => {
    const w = mount(ListPager, { props: { page: 6, pageSize: 50, total: 320 } }); // last page (0-based 6)
    expect(tid(w, 'pager-range').text()).toBe('301–320 of 320');
    expect(tid(w, 'pager-next').attributes('disabled')).toBeDefined();
    expect(tid(w, 'pager-prev').attributes('disabled')).toBeUndefined();
  });

  it('emits go(page±1) clamped to range', async () => {
    const w = mount(ListPager, { props: { page: 1, pageSize: 50, total: 320 } });
    await tid(w, 'pager-next').trigger('click');
    await tid(w, 'pager-prev').trigger('click');
    expect(w.emitted('go')).toEqual([[2], [0]]);
  });
});
