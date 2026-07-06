// Best-effort: after a reseed, refresh a locally-running Argus's connections with
// fresh read-only API keys.
//
// Why this exists: `pnpm seed` runs n8n's `/rest/e2e/reset`, which wipes every n8n
// API key. Any key a running Argus already stored for a connection is now dead, so
// its background poll gets 401'd and the catalog silently shows the OLD estate until
// the connection is re-pointed. This closes that loop automatically.
//
// It is strictly a convenience and NEVER fails the seed: if no Argus is running (or
// its admin password isn't the one we try), it logs why and returns. Connections are
// mutated only through Argus's own API (delete + re-register), so every change is
// audited (standing rule 6) — this never touches Argus's DB directly.

import { createN8nClient } from './n8n-client.mjs';

/**
 * @param instances  the INSTANCES map from launch.mjs ({ prod, staging })
 * @param opts.argusBase  where the local Argus API is (default http://127.0.0.1:3000)
 * @param opts.password   Argus admin password (default 'argus', the dev default)
 * @returns { skipped, refreshed?, reason? }
 */
export async function reconnectLocalArgus(instances, opts = {}) {
  const argusBase = opts.argusBase ?? process.env.ARGUS_BASE ?? 'http://127.0.0.1:3000';
  const password = opts.password ?? process.env.ARGUS_ADMIN_PASSWORD ?? 'argus';

  // 1. Is a local Argus even up? (No Argus running is the common, fine case.)
  let up = false;
  try { up = (await fetch(`${argusBase}/api/health`)).ok; } catch { /* not running */ }
  if (!up) { console.log(`  no local Argus on ${argusBase} — skipping connection refresh`); return { skipped: true, reason: 'no-argus' }; }

  let cookie = '';
  const argus = async (path, o = {}) => {
    const headers = { accept: 'application/json' };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(argusBase + path, { method: o.method ?? 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    let json; try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, json, setCookies: res.headers.getSetCookie?.() ?? [] };
  };

  // 2. Login (dev default password unless ARGUS_ADMIN_PASSWORD is set).
  const li = await argus('/api/auth/login', { method: 'POST', body: { password, name: 'Seeder', email: 'seeder@argus.local' } });
  if (li.status !== 200) {
    console.log(`  Argus login failed (${li.status}) — set ARGUS_ADMIN_PASSWORD to match your dev server; skipping`);
    return { skipped: true, reason: 'login-failed' };
  }
  cookie = li.setCookies.map((c) => c.split(';')[0]).join('; ');

  // 3. For each seeded instance: mint a fresh read-only key, replace its connection.
  const existing = (await argus('/api/connections')).json?.connections ?? [];
  let refreshed = 0;
  for (const inst of Object.values(instances)) {
    const c = createN8nClient(inst.baseUrl);
    await c.login();
    await c.mintApiKey(`argus-reconnect-${inst.name}-${Date.now()}`);
    if (!c.apiKey) { console.log(`  could not mint a key for ${inst.name} — skipping it`); continue; }
    // Remove any existing connection(s) for this instance (audited API delete), then re-register.
    for (const ex of existing.filter((e) => e.baseUrl === inst.baseUrl)) await argus(`/api/connections/${ex.id}`, { method: 'DELETE' });
    const r = await argus('/api/connections', { method: 'POST', body: { label: inst.name, baseUrl: inst.baseUrl, apiKey: c.apiKey } });
    if (r.status === 201) refreshed++;
    else console.log(`  re-register ${inst.name} → ${r.status} ${JSON.stringify(r.json ?? '').slice(0, 120)}`);
  }
  return { skipped: false, refreshed };
}
