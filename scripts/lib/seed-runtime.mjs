// Per-instance seed pipeline: reset → unlock → key → projects → members →
// credentials → workflows (topo order, refs injected) → tags → activate →
// archive → MCP toggle → executions. Returns a summary of what it planted so
// the estate step and verify can build on it.

import { createN8nClient } from './n8n-client.mjs';
import { topoSort } from './topo.mjs';
import { generateExecutions } from './exec-driver.mjs';
import { PEOPLE, PROJECTS, CREDENTIALS, TAGS } from '../seed/fixtures.mjs';
import { WORKFLOWS } from '../seed/workflows.mjs';

function log(instName, msg) {
  console.log(`  [${instName}] ${msg}`);
}

/**
 * Seed one instance end to end.
 * @param inst  { name, port, baseUrl } from launch.INSTANCES
 * @param opts  { withExecutions=true, extraWorkflows=[] } — estate adds extras
 */
export async function seedInstance(inst, opts = {}) {
  const { withExecutions = true, extraWorkflows = [] } = opts;
  const c = createN8nClient(inst.baseUrl);
  const webhookBase = inst.baseUrl;

  // 1. reset (owner+admin+chat + our members), unlock, key
  const members = Object.values(PEOPLE).map((p) => ({ email: p.email, password: p.password, firstName: p.firstName, lastName: p.lastName }));
  const reset = await c.reset({ members });
  if (!(reset.ok || reset.status === 200)) throw new Error(`${inst.name}: reset failed (${reset.status}) ${reset.text}`);
  await c.unlock();
  await c.login();
  await c.mintApiKey(`argus-seed-${inst.name}`);
  if (!c.apiKey) throw new Error(`${inst.name}: could not mint API key`);
  log(inst.name, 'reset + unlocked + authenticated');

  // 2. users → id map (by email)
  const usersResp = await c.api('GET', '/users?includeRole=true');
  const userIdByEmail = new Map((usersResp.json?.data ?? []).map((u) => [u.email, u.id]));

  // 3. projects (team) + capture ids
  const projectId = {}; // key -> id
  for (const p of Object.values(PROJECTS)) {
    const r = await c.api('POST', '/projects', { name: p.name });
    const id = r.json?.id ?? r.json?.data?.id;
    if (!id) throw new Error(`${inst.name}: project "${p.name}" create failed (${r.status}) ${r.text}`);
    projectId[p.key] = id;
  }
  log(inst.name, `created ${Object.keys(projectId).length} team projects`);

  // 4. project members
  for (const p of Object.values(PROJECTS)) {
    const relations = p.members
      .map(([personKey, role]) => ({ userId: userIdByEmail.get(PEOPLE[personKey].email), role }))
      .filter((r) => r.userId);
    if (relations.length) await c.api('POST', `/projects/${projectId[p.key]}/users`, { relations });
  }

  // 5. personal project ids (for personal-space-owned workflows)
  const projectsResp = await c.api('GET', '/projects');
  const personalProjectId = {}; // personKey -> id
  for (const person of Object.values(PEOPLE)) {
    const proj = (projectsResp.json?.data ?? []).find((p) => p.type === 'personal' && p.name.includes(person.email));
    if (proj) personalProjectId[person.key] = proj.id;
  }

  // 6. credentials (into their projects)
  const credById = {}; // key -> { id, name }
  for (const cred of Object.values(CREDENTIALS)) {
    const r = await c.api('POST', '/credentials', { name: cred.name, type: cred.type, data: cred.data, projectId: projectId[cred.project] });
    const id = r.json?.id ?? r.json?.data?.id;
    if (!id) throw new Error(`${inst.name}: credential "${cred.name}" create failed (${r.status}) ${r.text}`);
    credById[cred.key] = { id, name: cred.name };
  }
  log(inst.name, `created ${Object.keys(credById).length} credentials`);

  // 7. tags → name→id map (reuse existing, create the rest)
  const existingTags = await c.api('GET', '/tags');
  const tagId = new Map((existingTags.json?.data ?? []).map((t) => [t.name, t.id]));
  for (const name of TAGS) {
    if (!tagId.has(name)) {
      const r = await c.api('POST', '/tags', { name });
      if (r.json?.id) tagId.set(name, r.json.id);
    }
  }

  // 8. workflows in topological order (callees first) with refs injected
  const registry = [...WORKFLOWS, ...extraWorkflows];
  const ordered = topoSort(registry);
  const workflowId = {}; // key -> id
  const byKey = new Map(registry.map((w) => [w.key, w]));

  const ctx = {
    webhookBase,
    ref: (key) => {
      const id = workflowId[key];
      if (!id) throw new Error(`${inst.name}: unresolved ref "${key}" — dependency not created first`);
      return id;
    },
    cred: (key) => credById[key] ?? {},
  };

  for (const entry of ordered) {
    const payload = entry.build(ctx);
    const targetProject = entry.ownerPersonal ? personalProjectId[entry.ownerPersonal] : projectId[entry.project];
    if (!targetProject) throw new Error(`${inst.name}: no target project for "${entry.key}"`);
    payload.projectId = targetProject;
    // carry MCP intent in settings too (analyzer reads workflow JSON later)
    if (entry.mcp) payload.settings = { ...(payload.settings ?? {}), availableInMCP: true };
    const r = await c.api('POST', '/workflows', payload);
    const id = r.json?.id ?? r.json?.data?.id;
    if (!id) throw new Error(`${inst.name}: workflow "${entry.name}" create failed (${r.status}) ${r.text}`);
    workflowId[entry.key] = id;
  }
  log(inst.name, `created ${ordered.length} workflows`);

  // 9. tags on workflows
  for (const entry of ordered) {
    if (!entry.tags?.length) continue;
    const ids = entry.tags.map((t) => tagId.get(t)).filter(Boolean).map((id) => ({ id }));
    if (ids.length) await c.api('PUT', `/workflows/${workflowId[entry.key]}/tags`, ids);
  }

  // 10. activate (publish) the live workflows. n8n 2.29 requires a parent's
  // executeWorkflow callees to be published first, so publish transitive
  // non-archived callees (via dependsOn) before the parent, in topo order.
  const toPublish = new Set();
  const markPublish = (key) => {
    const e = byKey.get(key);
    if (!e || e.archived || toPublish.has(key)) return;
    for (const dep of e.dependsOn ?? []) markPublish(dep);
    toPublish.add(key);
  };
  for (const e of ordered) if (e.active) markPublish(e.key);

  let activated = 0;
  for (const entry of ordered) { // ordered is callee-first, so callees publish before parents
    if (!toPublish.has(entry.key)) continue;
    const r = await c.api('POST', `/workflows/${workflowId[entry.key]}/activate`);
    if (r.json?.active === true || r.status === 200) activated++;
    else log(inst.name, `WARN: activation of "${entry.name}" failed (${r.status}) ${JSON.stringify(r.json ?? r.text).slice(0, 160)}`);
  }
  log(inst.name, `activated ${activated} workflows`);

  // 11. archive (after everything else — archived workflows are read-only)
  for (const entry of ordered) {
    if (entry.archived) await c.api('POST', `/workflows/${workflowId[entry.key]}/archive`);
  }

  // 12. MCP exposure (authoritative column via internal REST toggle)
  const mcpIds = ordered.filter((e) => e.mcp).map((e) => workflowId[e.key]);
  if (mcpIds.length) {
    await c.http('PATCH', '/rest/mcp/workflows/toggle-access', { body: { availableInMCP: true, workflowIds: mcpIds } });
    log(inst.name, `exposed ${mcpIds.length} workflows to MCP`);
  }

  // 13. rename-only edit artifact (M2 exercises re-enrichment on a no-content change)
  await renameOnly(c, workflowId.aiCopywriter, 'Marketing AI Copywriter · v2').catch(() => {});

  // 14. executions (incl. deliberate failures)
  let execSummary = { total: 0 };
  if (withExecutions) {
    execSummary = await generateExecutions(c, inst, ordered, workflowId);
    log(inst.name, `generated ${execSummary.total} executions (${execSummary.errors} failing)`);
  }

  return { instance: inst.name, baseUrl: inst.baseUrl, projectId, personalProjectId, credById, workflowId, userIdByEmail, counts: { projects: Object.keys(projectId).length, workflows: ordered.length, activated }, execSummary };
}

// PUT the workflow back with only its name changed (leaves updatedAt>createdAt, same nodes).
async function renameOnly(c, id, newName) {
  if (!id) return;
  const g = await c.api('GET', `/workflows/${id}`);
  const wf = g.json;
  if (!wf?.nodes) return;
  await c.api('PUT', `/workflows/${id}`, { name: newName, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? {} });
}
