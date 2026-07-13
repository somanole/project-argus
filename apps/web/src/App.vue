<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

// The chrome (sidebar) is only shown once signed in; the login page is bare.
const showShell = computed(() => auth.actor !== null && route.name !== 'login');
// Desktop rail collapse (icons only) + mobile off-canvas drawer.
const collapsed = ref(false);
const drawerOpen = ref(false);
// Any navigation closes the mobile drawer.
watch(() => route.fullPath, () => { drawerOpen.value = false; });

// Responsive rail: below this width the expanded sidebar squeezes wide content (notably
// the Estate table) enough to force its card reflow. Collapsing to the icon rail first
// hands that content ~11rem, so it stays a table on smaller laptops before ever reflowing
// to cards. The manual Collapse button still overrides within a band.
const railQuery = window.matchMedia('(max-width: 77rem)');
collapsed.value = railQuery.matches;
const applyRail = (e: MediaQueryListEvent): void => { collapsed.value = e.matches; };
railQuery.addEventListener('change', applyRail);
onUnmounted(() => railQuery.removeEventListener('change', applyRail));

const initial = computed(() => (auth.actor?.name ?? auth.actor?.email ?? '?').trim().charAt(0).toUpperCase());

// Estate home (Explore, list) and the Graph representation both resolve to the `estate`
// route — they differ only by ?view=graph, which router-link's active matching ignores —
// so we compute those two active states by hand.
const isEstateHome = computed(() => route.name === 'estate' && route.query.view !== 'graph');
const isGraphView = computed(() => route.name === 'estate' && route.query.view === 'graph');

async function logout(): Promise<void> {
  await auth.logout();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <div class="app" :class="{ authed: showShell }">
    <template v-if="showShell">
      <!-- Mobile-only top bar: opens the drawer. -->
      <header class="mobilebar">
        <button class="icon-btn" aria-label="Open menu" @click="drawerOpen = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <div class="wordmark"><span class="eye" aria-hidden="true" /><span class="name">Argus</span></div>
      </header>

      <div v-if="drawerOpen" class="backdrop" @click="drawerOpen = false" />

      <!-- Sidebar / drawer -->
      <aside class="sidebar" :class="{ collapsed, open: drawerOpen }">
        <div class="side-top">
          <div class="wordmark"><span class="eye" aria-hidden="true" /><span class="name lbl">Argus</span></div>
          <button class="icon-btn side-close" aria-label="Close menu" @click="drawerOpen = false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <nav class="nav" aria-label="Primary">
          <router-link class="nav-item" to="/overview" :title="collapsed ? 'Overview' : undefined">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9.5h13V10" /></svg><span class="lbl">Overview</span>
          </router-link>
          <router-link class="nav-item" :class="{ 'is-active': isEstateHome }" active-class="" exact-active-class="" to="/estate" :title="collapsed ? 'Estate' : undefined">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4.5" width="18" height="4" rx="1" /><rect x="3" y="10" width="18" height="4" rx="1" /><rect x="3" y="15.5" width="18" height="4" rx="1" /></svg><span class="lbl">Estate</span>
          </router-link>
          <div class="nav-children">
            <router-link class="nav-item nav-child" to="/estate/health" :title="collapsed ? 'Health' : undefined">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-7 4 14 2.5-7H21" /></svg><span class="lbl">Health</span>
            </router-link>
            <router-link class="nav-item nav-child" to="/estate/ownership" :title="collapsed ? 'Ownership' : undefined">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.6-3 7.6-7 9-4-1.4-7-4.4-7-9V6z" /></svg><span class="lbl">Ownership</span>
            </router-link>
            <router-link class="nav-item nav-child" :class="{ 'is-active': isGraphView }" active-class="" exact-active-class="" :to="{ path: '/estate', query: { view: 'graph' } }" :title="collapsed ? 'Graph' : undefined">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="6" cy="7" r="2.2" /><circle cx="18" cy="9" r="2.2" /><circle cx="9" cy="18" r="2.2" /><path d="M8 7.7l8 1M8.6 9 8.4 15.8" /></svg><span class="lbl">Graph</span>
            </router-link>
          </div>
          <router-link class="nav-item" to="/chat" :title="collapsed ? 'Chat' : undefined">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" /></svg><span class="lbl">Chat</span>
          </router-link>
          <router-link class="nav-item" to="/activity" :title="collapsed ? 'Activity' : undefined">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg><span class="lbl">Activity</span>
          </router-link>

          <div class="nav-sec lbl">Setup</div>
          <router-link class="nav-item" to="/connections" :title="collapsed ? 'Connections' : undefined">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9.5 14.5 14.5 9.5" /><path d="M14 7l1.2-1.2a3.5 3.5 0 0 1 5 5L19 12" /><path d="M10 17l-1.2 1.2a3.5 3.5 0 0 1-5-5L5 12" /></svg><span class="lbl">Connections</span>
          </router-link>
          <router-link class="nav-item" to="/settings" :title="collapsed ? 'Settings' : undefined">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 12c0-.4 0-.8-.1-1.2l1.9-1.4-2-3.4-2.2 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.5 2.6a7 7 0 0 0-2 1.2l-2.2-1-2 3.4L4.7 10.8c-.1.4-.1.8-.1 1.2s0 .8.1 1.2l-1.9 1.4 2 3.4 2.2-1a7 7 0 0 0 2 1.2L9.5 21h5l.5-2.6a7 7 0 0 0 2-1.2l2.2 1 2-3.4-1.9-1.4c.1-.4.1-.8.1-1.2z" /></svg><span class="lbl">Settings</span>
          </router-link>
        </nav>

        <div class="side-foot">
          <div v-if="auth.actor" class="who">
            <span class="avatar" aria-hidden="true">{{ initial }}</span>
            <span class="who-meta lbl">
              <span class="who-name">{{ auth.actor.name }}</span>
              <span class="who-email" :title="auth.actor.email">{{ auth.actor.email }}</span>
            </span>
            <button class="icon-btn signout" title="Sign out" aria-label="Sign out" @click="logout">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></svg>
            </button>
          </div>
          <button class="collapse-btn" :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'" @click="collapsed = !collapsed">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ flip: collapsed }"><path d="M15 6l-6 6 6 6" /></svg>
            <span class="lbl">Collapse</span>
          </button>
        </div>
      </aside>
    </template>

    <main :class="showShell ? 'content' : 'bare'">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app { min-height: 100vh; }
.app.authed { display: flex; align-items: stretch; }

/* ---------- wordmark ---------- */
.wordmark { display: inline-flex; align-items: center; gap: var(--spacing--3xs); min-width: 0; }
.eye {
  width: var(--spacing--sm); height: var(--spacing--sm); flex: none;
  border-radius: var(--radius--full);
  background: radial-gradient(circle at center, var(--color--neutral-white) 0 22%, var(--background--brand) 30% 100%);
  box-shadow: 0 0 0 2px var(--background--brand);
}
.name { font-size: var(--font-size--lg); font-weight: var(--font-weight--bold); letter-spacing: -0.01em; }

/* ---------- sidebar ---------- */
.sidebar {
  flex: none; width: 15rem;
  display: flex; flex-direction: column;
  background: var(--background--surface);
  border-right: 1px solid var(--border-color--subtle);
  padding: var(--spacing--sm) var(--spacing--2xs);
  position: sticky; top: 0; height: 100vh;
  transition: width var(--duration--snappy, 0.15s) var(--easing--ease-out, ease);
}
.sidebar.collapsed { width: 3.75rem; }
.side-top { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing--2xs); padding: var(--spacing--3xs) var(--spacing--3xs) var(--spacing--sm); }
.icon-btn.side-close { display: none; }

.nav { display: flex; flex-direction: column; gap: 1px; }
.nav-item {
  display: flex; align-items: center; gap: var(--spacing--2xs);
  padding: var(--spacing--2xs) var(--spacing--3xs);
  border-radius: var(--radius--md); text-decoration: none;
  color: var(--color--text--shade-1); opacity: 0.78;
  font-size: var(--font-size--sm); font-weight: var(--font-weight--medium); white-space: nowrap;
}
.nav-item svg { width: 1.1rem; height: 1.1rem; flex: none; }
.nav-item:hover { background: var(--background--subtle); opacity: 1; }
/* Exact-active so the parent "Estate" link doesn't stay lit on its lens sub-routes —
   only the leaf (the current lens) highlights. `.is-active` is the hand-computed variant
   for the Estate-home vs Graph links, which share a route and differ only by ?view. */
.nav-item.router-link-exact-active,
.nav-item.is-active { color: var(--background--brand); background: var(--background--subtle); opacity: 1; }

/* Estate's lens shortcuts, grouped + indented beneath it so the relationship reads. */
.nav-children { display: flex; flex-direction: column; gap: 1px; margin: 1px 0 1px var(--spacing--md); border-left: 1px solid var(--border-color--subtle); padding-left: var(--spacing--3xs); }
.nav-child { font-size: var(--font-size--2xs); padding-top: var(--spacing--3xs); padding-bottom: var(--spacing--3xs); }
.nav-child svg { width: 0.95rem; height: 0.95rem; }
.nav-sec {
  font-size: var(--font-size--3xs); font-weight: var(--font-weight--bold);
  text-transform: uppercase; letter-spacing: var(--letter-spacing--wide);
  color: var(--color--text--shade-1); opacity: 0.5;
  padding: var(--spacing--sm) var(--spacing--3xs) var(--spacing--4xs);
}

.side-foot { margin-top: auto; display: flex; flex-direction: column; gap: var(--spacing--2xs); padding-top: var(--spacing--sm); }

.who { display: flex; align-items: center; gap: var(--spacing--2xs); padding: var(--spacing--3xs); }
.avatar {
  width: 1.6rem; height: 1.6rem; flex: none; border-radius: var(--radius--full);
  background: var(--background--brand); color: var(--color--neutral-white);
  display: grid; place-items: center; font-size: var(--font-size--2xs); font-weight: var(--font-weight--bold);
}
.who-meta { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.who-name { font-size: var(--font-size--2xs); font-weight: var(--font-weight--medium); }
.who-email { font-size: var(--font-size--3xs); color: var(--color--text--shade-1); opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.icon-btn {
  appearance: none; border: 0; background: none; color: var(--color--text--shade-1);
  cursor: pointer; display: inline-grid; place-items: center; padding: var(--spacing--4xs);
  border-radius: var(--radius--md); flex: none;
}
.icon-btn:hover { background: var(--background--subtle); }
.icon-btn svg { width: 1.15rem; height: 1.15rem; }
.signout { margin-left: auto; opacity: 0.7; }
.signout:hover { opacity: 1; }

.collapse-btn {
  appearance: none; border: 0; background: none; color: var(--color--text--shade-1); opacity: 0.6;
  cursor: pointer; display: flex; align-items: center; gap: var(--spacing--2xs);
  padding: var(--spacing--2xs) var(--spacing--3xs); border-radius: var(--radius--md);
  font: inherit; font-size: var(--font-size--2xs);
}
.collapse-btn:hover { background: var(--background--subtle); opacity: 1; }
.collapse-btn svg { width: 1rem; height: 1rem; flex: none; transition: transform var(--duration--snappy, 0.15s) var(--easing--ease-out, ease); }
.collapse-btn svg.flip { transform: rotate(180deg); }

/* collapsed rail — icons only */
.sidebar.collapsed .lbl,
.sidebar.collapsed .nav-sec,
.sidebar.collapsed .who-meta,
.sidebar.collapsed .signout { display: none; }
.sidebar.collapsed .nav-item,
.sidebar.collapsed .side-top,
.sidebar.collapsed .who,
.sidebar.collapsed .collapse-btn { justify-content: center; }
.sidebar.collapsed .who { padding-left: 0; padding-right: 0; }
/* Collapsed: the lens shortcuts flatten to plain icons in the rail (no indent/rule). */
.sidebar.collapsed .nav-children { margin-left: 0; border-left: 0; padding-left: 0; }

/* mobile top bar hidden on desktop */
.mobilebar { display: none; }
.backdrop { display: none; }

/* ---------- content ---------- */
.content { flex: 1 1 auto; min-width: 0; padding: var(--spacing--lg) var(--spacing--lg) var(--spacing--3xl); }
.bare { display: block; }

/* ---------- mobile: off-canvas drawer ---------- */
@media (max-width: 48rem) {
  .app.authed { display: block; }
  .mobilebar {
    display: flex; align-items: center; gap: var(--spacing--2xs);
    padding: var(--spacing--2xs) var(--spacing--sm);
    background: var(--background--surface); border-bottom: 1px solid var(--border-color--subtle);
    position: sticky; top: 0; z-index: 30;
  }
  .backdrop {
    display: block; position: fixed; inset: 0; z-index: 40;
    background: var(--color--black-alpha-300, rgba(0, 0, 0, 0.3));
  }
  .sidebar {
    position: fixed; top: 0; left: 0; bottom: 0; height: auto; width: 16rem; z-index: 50;
    transform: translateX(-100%); transition: transform var(--duration--regular, 0.2s) var(--easing--ease-out, ease);
    box-shadow: var(--shadow);
  }
  .sidebar.open { transform: translateX(0); }
  .sidebar.collapsed { width: 16rem; }               /* collapse is desktop-only */
  .sidebar.collapsed .lbl, .sidebar.collapsed .nav-sec,
  .sidebar.collapsed .who-meta,
  .sidebar.collapsed .signout { display: revert; }
  .icon-btn.side-close { display: inline-grid; }
  .collapse-btn { display: none; }
  .content { padding: var(--spacing--md) var(--spacing--sm) var(--spacing--2xl); }
}
</style>
