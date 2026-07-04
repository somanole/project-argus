import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { HealthResponse } from '@argus/shared';
import App from './App.vue';

const healthy: HealthResponse = {
  status: 'ok',
  service: 'argus-server',
  version: '0.0.0',
  db: 'ok',
  time: new Date().toISOString(),
};

describe('App (M0 placeholder)', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-theme');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Argus wordmark and, once the server answers, its health fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => healthy }),
    );

    const wrapper = mount(App, { global: { plugins: [createPinia()] } });
    expect(wrapper.text()).toContain('Argus');

    await flushPromises();
    expect(wrapper.text()).toContain('argus-server');
    expect(wrapper.text().toLowerCase()).toContain('ok');
  });

  it('shows an honest error (not a fabricated status) when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const wrapper = mount(App, { global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Couldn’t reach the Argus server');
  });
});
