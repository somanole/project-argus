// Shared n8n client for probe + seed + verify (standing rule 1: one source of
// truth for how we talk to a real running n8n, so probe and seed can never drift).
//
// Covers the E2E-unlock dance (reset → feature/quota patch → login → mint API key)
// and thin wrappers over the public API. Everything returns the raw
// { status, ok, json, text, setCookies } so callers decide how to handle partial
// data — we never pretend a call succeeded (rule 5).

// Known E2E test credentials (from n8n's own playwright harness — not secrets).
// n8n's setupUserManagement always creates owner + admin + chat, so all three
// must be objects; passing null crashes the reset with a 500 (DISCOVERY.md).
export const E2E_OWNER = {
  email: 'nathan@n8n.io',
  password: 'PlaywrightTest123',
  firstName: 'Nathan',
  lastName: 'Owner',
};
export const E2E_ADMIN = { email: 'admin@n8n.io', password: 'PlaywrightTest123', firstName: 'Admin', lastName: 'User' };
export const E2E_CHAT = { email: 'chat@n8n.io', password: 'PlaywrightTest123', firstName: 'Chat', lastName: 'User' };

// The license flags the estate needs (sharing, folders, project roles, log
// streaming, insights). Re-applied after every reset — reset wipes them.
export const FEATURE_FLAGS = [
  'feat:sharing',
  'feat:folders',
  'feat:advancedPermissions',
  'feat:projectRole:admin',
  'feat:projectRole:editor',
  'feat:projectRole:viewer',
  'feat:logStreaming',
  'feat:variables',
  'feat:insights:viewDashboard',
];

export const QUOTAS = [{ feature: 'quota:maxTeamProjects', value: -1 }];

// Broad scope set the seeder needs (superset of the M0 probe's).
export const SEEDER_API_KEY_SCOPES = [
  'user:read', 'user:list', 'user:create', 'user:delete',
  'workflow:create', 'workflow:read', 'workflow:update', 'workflow:delete',
  'workflow:list', 'workflow:move', 'workflow:activate', 'workflow:deactivate',
  'execution:read', 'execution:list', 'execution:delete',
  'credential:create', 'credential:read', 'credential:list', 'credential:update', 'credential:delete', 'credential:move',
  'tag:create', 'tag:read', 'tag:list', 'tag:update',
  'workflowTags:list', 'workflowTags:update',
  'project:create', 'project:update', 'project:delete', 'project:list',
  'folder:create', 'folder:list', 'folder:read',
];

export function redactBody(body) {
  if (!body || typeof body !== 'object') return body;
  const clone = structuredClone(body);
  for (const k of ['password', 'rawApiKey', 'apiKey', 'data']) if (k in clone) clone[k] = '«redacted»';
  return clone;
}

/**
 * Create a stateful client bound to one n8n base URL. It remembers the session
 * cookie (from login) and the minted API key so callers don't have to thread them.
 * @param {string} baseUrl e.g. 'http://localhost:5678'
 */
export function createN8nClient(baseUrl) {
  let cookie = '';
  let apiKey = '';

  /** Low-level fetch. Pass { key: false } to force no API-key header. */
  async function http(method, path, { headers = {}, body, cookie: cookieOverride, key } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    const useCookie = cookieOverride ?? (key === undefined ? cookie : '');
    if (useCookie) h.cookie = useCookie;
    if (key !== false && apiKey && !('X-N8N-API-KEY' in h)) h['X-N8N-API-KEY'] = apiKey;
    const res = await fetch(baseUrl + path, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
    return { status: res.status, ok: res.ok, json, text, setCookies: res.headers.getSetCookie?.() ?? [] };
  }

  /** GET /healthz → true if 200. */
  async function healthy() {
    try {
      const r = await http('GET', '/healthz', { key: false });
      return r.status === 200;
    } catch { return false; }
  }

  /** True if the E2E control endpoints are live (E2E_TESTS=true). */
  async function e2eActive() {
    try {
      const r = await http('PATCH', '/rest/e2e/feature', { key: false, body: { feature: 'feat:sharing', enabled: true } });
      return r.status >= 200 && r.status < 300;
    } catch { return false; }
  }

  /** POST /rest/e2e/reset — truncates everything, recreates owner/admin/chat/members. */
  async function reset({ owner = E2E_OWNER, admin = E2E_ADMIN, chat = E2E_CHAT, members = [] } = {}) {
    return http('POST', '/rest/e2e/reset', { key: false, body: { owner, members, admin, chat } });
  }

  /** Apply the license feature flags + quotas (idempotent; re-run after any reset). */
  async function unlock(features = FEATURE_FLAGS, quotas = QUOTAS) {
    for (const feature of features) {
      await http('PATCH', '/rest/e2e/feature', { key: false, body: { feature, enabled: true } });
    }
    for (const q of quotas) {
      await http('PATCH', '/rest/e2e/quota', { key: false, body: q });
    }
  }

  /** POST /rest/login — stores the session cookie on the client. Returns the response. */
  async function login(email = E2E_OWNER.email, password = E2E_OWNER.password) {
    const r = await http('POST', '/rest/login', { key: false, body: { emailOrLdapLoginId: email, password } });
    cookie = r.setCookies.map((c) => c.split(';')[0]).join('; ');
    return r;
  }

  /** POST /rest/api-keys — mints and stores an API key (needs a cookie from login). */
  async function mintApiKey(label = 'argus-seed', scopes = SEEDER_API_KEY_SCOPES) {
    const r = await http('POST', '/rest/api-keys', { body: { label, scopes, expiresAt: null } });
    apiKey = r.json?.data?.rawApiKey ?? r.json?.rawApiKey ?? '';
    return r;
  }

  /** Public API helper: method + path under /api/v1, uses the stored API key. */
  function api(method, path, body) {
    return http(method, `/api/v1${path}`, { body });
  }

  return {
    baseUrl,
    http,
    healthy,
    e2eActive,
    reset,
    unlock,
    login,
    mintApiKey,
    api,
    get cookie() { return cookie; },
    get apiKey() { return apiKey; },
    setApiKey(k) { apiKey = k; },
  };
}
