// Read-only helpers for inspecting a seeded estate from n8n's own APIs.
// Used by `pnpm verify` to confirm the planted problems are really there — no
// Argus analyzer involved (that's a later milestone).

import { createN8nClient } from './n8n-client.mjs';

export const OWNER_EMAIL = 'nathan@n8n.io';

/** Connect + authenticate (login + mint a read key) to one instance.
 * API-key labels must be unique per user, so make each mint distinct — verify
 * can then run repeatedly without a reset. */
let keySeq = 0;
export async function connect(baseUrl) {
  const c = createN8nClient(baseUrl);
  await c.login();
  await c.mintApiKey(`argus-verify-${Date.now()}-${keySeq++}`);
  return c;
}

/** All workflows (paginated), each including nodes + tags + shared. */
export async function allWorkflows(c) {
  const out = [];
  let cursor;
  do {
    const q = cursor ? `?limit=250&cursor=${encodeURIComponent(cursor)}` : '?limit=250';
    const r = await c.api('GET', `/workflows${q}`);
    out.push(...(r.json?.data ?? []));
    cursor = r.json?.nextCursor;
  } while (cursor);
  return out;
}

/** executeWorkflow sub-workflow reference ids (database source), string or resource-locator. */
export function subRefs(w) {
  const refs = [];
  for (const n of w.nodes ?? []) {
    if (n.type !== 'n8n-nodes-base.executeWorkflow') continue;
    if (n.parameters?.source && n.parameters.source !== 'database') continue;
    const wid = n.parameters?.workflowId;
    const val = typeof wid === 'string' ? wid : wid?.value;
    if (val) refs.push(String(val));
  }
  return refs;
}

export const tagsOf = (w) => (w.tags ?? []).map((t) => t.name);
export const ownerProjectId = (w) => (w.shared ?? []).find((s) => s.role === 'workflow:owner')?.projectId;

/** Credential types referenced by a workflow's nodes. */
export function credTypesOf(w) {
  const types = new Set();
  for (const n of w.nodes ?? []) for (const t of Object.keys(n.credentials ?? {})) types.add(t);
  return [...types];
}

export async function teamProjects(c) {
  const r = await c.api('GET', '/projects');
  return (r.json?.data ?? []).filter((p) => p.type === 'team');
}

export async function projectMembers(c, projectId) {
  const r = await c.api('GET', `/projects/${projectId}/users`);
  const rows = r.json?.data ?? r.json ?? [];
  return Array.isArray(rows) ? rows.map((u) => u.email ?? u.userId).filter(Boolean) : [];
}

export async function execCount(c, workflowId, status) {
  const r = await c.api('GET', `/executions?workflowId=${workflowId}&status=${status}`);
  return (r.json?.data ?? []).length;
}

/** availableInMCP workflows via the internal REST filter (authoritative column). */
export async function mcpWorkflows(c) {
  const r = await c.http('GET', `/rest/workflows?filter=${encodeURIComponent(JSON.stringify({ availableInMCP: true }))}`);
  return r.json?.data ?? [];
}
