import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from './stores/auth';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/overview' },
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/overview', name: 'overview', component: () => import('./views/OverviewView.vue') },
  // The Estate — one surface, switchable lenses (Explore / Health / Ownership). Each
  // lens is a real route so links + the back button work; the lens views render inside
  // the shared EstateLayout (which owns the lens tab bar).
  {
    path: '/estate',
    component: () => import('./views/EstateLayout.vue'),
    children: [
      { path: '', name: 'estate', component: () => import('./views/WorkflowsView.vue') },
      { path: 'health', name: 'estate-health', component: () => import('./views/HealthView.vue') },
      { path: 'ownership', name: 'estate-ownership', component: () => import('./views/GovernanceView.vue') },
    ],
  },
  { path: '/chat', name: 'chat', component: () => import('./views/ChatView.vue') },
  { path: '/activity', name: 'activity', component: () => import('./views/ActivityView.vue') },
  { path: '/connections', name: 'connections', component: () => import('./views/ConnectionsView.vue') },
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
  // Back-compat: the old top-level pages now live as Estate lenses / the graph view.
  { path: '/workflows', redirect: '/estate' },
  { path: '/health', redirect: '/estate/health' },
  { path: '/governance', redirect: '/estate/ownership' },
  { path: '/graph', redirect: { path: '/estate', query: { view: 'graph' } } },
  { path: '/:pathMatch(.*)*', redirect: '/overview' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

/**
 * Auth guard: everything except the login page requires a session. We resolve
 * the session from the server once, then redirect unauthenticated users to
 * login and bounce logged-in users away from it.
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.ensureLoaded();
  const authed = auth.actor !== null;
  if (!to.meta.public && !authed) return { name: 'login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} };
  if (to.name === 'login' && authed) return { name: 'overview' };
  return true;
});

/**
 * Self-heal a stale bundle. A deploy replaces the hashed chunk files; a browser still
 * running an older index.html then 404s when it lazy-loads a route it hadn't visited yet
 * (e.g. Chat) — and vue-router silently aborts, so the page looks stuck. Detect that
 * chunk-load failure and hard-reload once to the target URL, which fetches the current
 * build. Keyed by path so a genuinely broken chunk can't loop (sessionStorage survives the
 * reload); every successful navigation clears the guard.
 */
router.onError((error, to) => {
  const message = error instanceof Error ? error.message : String(error);
  const isChunkLoadError = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(message);
  if (isChunkLoadError && to?.fullPath && sessionStorage.getItem('argus:reloaded-for') !== to.fullPath) {
    sessionStorage.setItem('argus:reloaded-for', to.fullPath);
    window.location.assign(to.fullPath);
  }
});
router.afterEach(() => sessionStorage.removeItem('argus:reloaded-for'));
