import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from './stores/auth';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/overview' },
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/overview', name: 'overview', component: () => import('./views/OverviewView.vue') },
  { path: '/workflows', name: 'workflows', component: () => import('./views/WorkflowsView.vue') },
  { path: '/health', name: 'health', component: () => import('./views/HealthView.vue') },
  { path: '/graph', name: 'graph', component: () => import('./views/GraphView.vue') },
  { path: '/governance', name: 'governance', component: () => import('./views/GovernanceView.vue') },
  { path: '/chat', name: 'chat', component: () => import('./views/ChatView.vue') },
  { path: '/connections', name: 'connections', component: () => import('./views/ConnectionsView.vue') },
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
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
