import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LoginView from './LoginView.vue';
import { useAuthStore } from '../stores/auth';

// LoginView uses the router in submit(); stub it so the component mounts.
vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useRoute: () => ({ query: {} }),
}));

describe('LoginView keyboard flow', () => {
  it('Enter in any field signs in with the entered credentials', async () => {
    setActivePinia(createPinia());
    // attachTo the document so focus() actually reflects the active element.
    const w = mount(LoginView, { attachTo: document.body });

    const auth = useAuthStore();
    const login = vi.spyOn(auth, 'login').mockResolvedValue(undefined);

    await w.find('#pw').setValue('argus');
    await w.find('#nm').setValue('Sorin');
    await w.find('#em').setValue('sorin@test.com');

    const creds = { password: 'argus', name: 'Sorin', email: 'sorin@test.com' };

    // Enter from the FIRST field must sign in — the whole point of the request.
    // It must not just advance focus (the old behavior) or rely on the browser's
    // fragile implicit submission (which was silently failing).
    await w.find('#pw').trigger('keydown.enter');
    expect(login).toHaveBeenCalledWith(creds);

    // Enter from a middle field signs in too.
    login.mockClear();
    await w.find('#nm').trigger('keydown.enter');
    expect(login).toHaveBeenCalledWith(creds);

    // And from the last field.
    login.mockClear();
    await w.find('#em').trigger('keydown.enter');
    expect(login).toHaveBeenCalledWith(creds);

    w.unmount();
  });

  it('clicking Sign in also submits', async () => {
    setActivePinia(createPinia());
    const w = mount(LoginView, { attachTo: document.body });

    const auth = useAuthStore();
    const login = vi.spyOn(auth, 'login').mockResolvedValue(undefined);

    await w.find('#pw').setValue('argus');
    await w.find('#nm').setValue('Sorin');
    await w.find('#em').setValue('sorin@test.com');
    await w.find('form').trigger('submit');

    expect(login).toHaveBeenCalledWith({
      password: 'argus',
      name: 'Sorin',
      email: 'sorin@test.com',
    });

    w.unmount();
  });
});
