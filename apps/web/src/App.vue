<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';
import { useThemeStore, type ThemePreference } from './stores/theme';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const theme = useThemeStore();

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

// The chrome (top bar) is only shown once signed in; the login page is bare.
const showShell = computed(() => auth.actor !== null && route.name !== 'login');

async function logout(): Promise<void> {
  await auth.logout();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <div class="app">
    <header v-if="showShell" class="topbar">
      <div class="left">
        <div class="wordmark">
          <span class="eye" aria-hidden="true" />
          <span class="name">Argus</span>
        </div>
        <nav class="nav">
          <router-link to="/overview">Overview</router-link>
          <router-link to="/workflows">Catalog</router-link>
          <router-link to="/health">Health</router-link>
          <router-link to="/graph">Graph</router-link>
          <router-link to="/governance">Governance</router-link>
          <router-link to="/chat">Chat</router-link>
          <router-link to="/connections">Connections</router-link>
          <router-link to="/settings">Settings</router-link>
        </nav>
      </div>
      <div class="right">
        <div class="theme-control" role="group" aria-label="Theme">
          <button
            v-for="opt in themeOptions"
            :key="opt.value"
            type="button"
            class="theme-button"
            :class="{ 'is-active': theme.preference === opt.value }"
            :aria-pressed="theme.preference === opt.value"
            @click="theme.apply(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <span v-if="auth.actor" class="actor" :title="auth.actor.email">{{ auth.actor.name }}</span>
        <button class="btn btn--ghost btn--sm" @click="logout">Sign out</button>
      </div>
    </header>

    <main :class="showShell ? 'content' : 'bare'">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing--md);
  padding: var(--spacing--2xs) var(--spacing--lg);
  border-bottom: 1px solid var(--border-color--subtle);
  background: var(--background--surface);
  position: sticky;
  top: 0;
  z-index: 10;
  flex-wrap: wrap;
}
.left { display: flex; align-items: center; gap: var(--spacing--lg); flex-wrap: wrap; min-width: 0; }
.wordmark { display: inline-flex; align-items: center; gap: var(--spacing--3xs); }
.eye {
  width: var(--spacing--sm);
  height: var(--spacing--sm);
  border-radius: var(--radius--full);
  background: radial-gradient(circle at center, var(--color--neutral-white) 0 22%, var(--background--brand) 30% 100%);
  box-shadow: 0 0 0 2px var(--background--brand);
}
.name { font-size: var(--font-size--lg); font-weight: var(--font-weight--bold); letter-spacing: -0.01em; }

.nav { display: flex; gap: var(--spacing--2xs); flex-wrap: wrap; }
.nav a {
  text-decoration: none;
  color: var(--color--text--shade-1);
  font-size: var(--font-size--sm);
  font-weight: var(--font-weight--medium);
  padding: var(--spacing--4xs) var(--spacing--2xs);
  border-radius: var(--radius--md);
  opacity: 0.75;
}
.nav a:hover { background: var(--background--subtle); opacity: 1; }
.nav a.router-link-active { color: var(--background--brand); opacity: 1; background: var(--background--subtle); }

.right { display: flex; align-items: center; gap: var(--spacing--sm); flex-wrap: wrap; }
.actor { font-size: var(--font-size--2xs); font-weight: var(--font-weight--medium); }

.theme-control { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--radius--md); overflow: hidden; }
.theme-button {
  appearance: none;
  border: 0;
  background: var(--background--surface);
  color: var(--color--text--shade-1);
  font: inherit;
  font-size: var(--font-size--3xs);
  padding: var(--spacing--4xs) var(--spacing--2xs);
  cursor: pointer;
}
.theme-button + .theme-button { border-left: 1px solid var(--border-color); }
.theme-button:hover { background: var(--background--subtle); }
.theme-button.is-active { background: var(--background--brand); color: var(--color--neutral-white); }

.content { max-width: 72rem; margin: 0 auto; padding: var(--spacing--lg) var(--spacing--lg) var(--spacing--3xl); }
.bare { display: block; }

/* Mobile: the wrapped 8-item nav used to stack into ~4 sticky rows (≈¼ of the
   viewport). Keep it to two: wordmark + a single horizontally-scrollable nav row,
   with the theme/actor/sign-out controls on their own row. Additive — no DOM change. */
@media (max-width: 40rem) {
  .topbar { padding: var(--spacing--2xs) var(--spacing--sm); gap: var(--spacing--2xs); }
  .left { width: 100%; flex-wrap: nowrap; min-width: 0; gap: var(--spacing--sm); }
  .nav {
    flex: 1;
    min-width: 0;
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .nav::-webkit-scrollbar { display: none; }
  .nav a { white-space: nowrap; }
  .right { width: 100%; justify-content: space-between; }
}
</style>
