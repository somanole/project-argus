import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';

/**
 * Client-side pagination of an already-fetched list — the health/ownership "problem"
 * groups (bounded subsets we hold in full). The catalog paginates SERVER-side instead
 * (it's the unbounded whole-estate list). Returns the current page slice plus the state
 * a <Pager> needs; clamps the page back into range when the list shrinks (e.g. a filter
 * change) so you never get stuck on an empty page.
 */
export function usePaged<T>(
  items: Ref<T[]> | ComputedRef<T[]>,
  pageSize: number,
): { page: Ref<number>; paged: ComputedRef<T[]>; total: ComputedRef<number>; go: (p: number) => void } {
  const page = ref(0);
  const total = computed(() => items.value.length);
  const lastPage = computed(() => Math.max(Math.ceil(total.value / pageSize) - 1, 0));
  const paged = computed(() => items.value.slice(page.value * pageSize, (page.value + 1) * pageSize));

  function go(p: number): void {
    page.value = Math.min(Math.max(p, 0), lastPage.value);
  }
  // If the list shrinks under the current page, pull back into range.
  watch(total, () => {
    if (page.value > lastPage.value) page.value = lastPage.value;
  });

  return { page, paged, total, go };
}
