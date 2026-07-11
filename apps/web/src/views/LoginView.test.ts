import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LoginView from './LoginView.vue';

// LoginView uses the router in submit(); stub it so the component mounts.
vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useRoute: () => ({ query: {} }),
}));

describe('LoginView keyboard flow', () => {
  it('Enter advances to the next field; Enter on the last (email) field submits, not refocuses', async () => {
    setActivePinia(createPinia());
    // attachTo the document so focus() actually moves the active element.
    const w = mount(LoginView, { attachTo: document.body });

    const pw = w.find('#pw');
    const nm = w.find('#nm');
    const em = w.find('#em');

    (pw.element as HTMLInputElement).focus();
    await pw.trigger('keydown.enter');
    expect(document.activeElement).toBe(nm.element); // password → name

    await nm.trigger('keydown.enter');
    expect(document.activeElement).toBe(em.element); // name → email

    // Enter on the email field does NOT move focus — it lets the form submit.
    await em.trigger('keydown.enter');
    expect(document.activeElement).toBe(em.element);

    w.unmount();
  });
});
