// Node + workflow-shape helpers for the seed fleet.
//
// These produce the literal n8n node/connection JSON the analyzer will later read,
// so the specific shapes (resource-locator vs plain-string executeWorkflow refs,
// inline sub-workflows, expression URLs, agent/agentTool wiring) live here, visibly.

import { createHash } from 'node:crypto';

// Deterministic uuid-shaped node id from a seed string (no randomness → idempotent).
export function nodeId(seed) {
  const h = createHash('md5').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// A sub-workflow reference id that intentionally never exists (the one broken_ref).
export const BROKEN_REF = '00000000-0000-4000-8000-000000000000';

// --- triggers ---
export const manualTrigger = (name = 'When clicking Test') => ({
  type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {}, name,
});

export const webhookTrigger = (name, { path, httpMethod = 'POST' } = {}) => ({
  type: 'n8n-nodes-base.webhook', typeVersion: 2,
  parameters: { path, httpMethod, responseMode: 'onReceived', options: {} }, name,
});

export const scheduleTrigger = (name = 'Schedule') => ({
  type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2,
  parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } }, name,
});

export const chatTrigger = (name = 'Chat Trigger') => ({
  type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.1, parameters: {}, name,
});

// --- actions ---
export const httpRequest = (name, url, { options = {} } = {}) => ({
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  parameters: { url, options }, name,
});

export const noOp = (name = 'NoOp') => ({ type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {}, name });

// The trigger a sub-workflow starts from when called via executeWorkflow.
export const executeWorkflowTrigger = (name = 'When Executed by Another Workflow') => ({
  type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1,
  parameters: { inputSource: 'passthrough' }, name,
});

// Generic app/action node carrying a credential (Slack/Postgres/Stripe/Salesforce/Email).
export const appNode = (name, type, typeVersion, parameters = {}) => ({ type, typeVersion, parameters, name });

export const set = (name = 'Set') => ({
  type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { assignments: { assignments: [] } }, name,
});

export const code = (name, jsCode) => ({
  type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { language: 'javaScript', jsCode }, name,
});

// A Code node whose error is SWALLOWED (onError:'continueRegularOutput'): when its
// script throws, the node's executionStatus is 'error' but the run continues on the
// normal output and finishes 'success'. This is the "green but swallowing" mechanism
// the S6.3 silent-failure detector must catch (paired with ALWAYS_FAIL below).
export const swallowingCode = (name, jsCode) => ({
  type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { language: 'javaScript', jsCode }, name,
  onError: 'continueRegularOutput',
});

// executeWorkflow — standard resource-locator ("list" mode) reference to a real id.
export const executeWorkflow = (name, workflowId, cachedResultName = '') => ({
  type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2,
  parameters: { source: 'database', workflowId: { __rl: true, value: workflowId, mode: 'list', cachedResultName } },
  name,
});

// executeWorkflow — PLAIN-STRING reference (analyzer edge case: workflowId is a bare string).
export const executeWorkflowPlainString = (name, workflowId) => ({
  type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1,
  parameters: { source: 'database', workflowId }, name,
});

// executeWorkflow — INLINE sub-workflow (analyzer edge case: source=parameter, workflowJson).
export const executeWorkflowInline = (name, workflowJson) => ({
  type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2,
  parameters: { source: 'parameter', workflowJson: JSON.stringify(workflowJson, null, 2) }, name,
});

// --- AI (langchain) ---
export const agent = (name = 'AI Agent') => ({
  type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.7,
  parameters: { promptType: 'auto', options: {} }, name,
});

export const lmChatOpenAi = (name = 'OpenAI Chat Model') => ({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1,
  parameters: { model: 'gpt-4o-mini', options: {} }, name,
});

export const memoryBuffer = (name = 'Window Buffer Memory') => ({
  type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', typeVersion: 1.3, parameters: {}, name,
});

// A toolWorkflow (agentTool) node that calls a sub-workflow as an agent tool.
export const toolWorkflow = (name, workflowId, description = 'A tool the agent can call') => ({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2.2,
  parameters: {
    name: name.replace(/\s+/g, '_').toLowerCase(), description,
    workflowId: { __rl: true, value: workflowId, mode: 'list', cachedResultName: '' },
  },
  name,
});

// The `agentTool` node type itself (analyzer edge case: an agentTool orchestration node).
export const agentTool = (name = 'Agent Tool') => ({
  type: '@n8n/n8n-nodes-langchain.agentTool', typeVersion: 2.2,
  parameters: { toolDescription: 'Orchestration sub-agent', promptType: 'auto', options: {} }, name,
});

/** Attach a credential to a node: attachCred(node, 'slackApi', {id, name}). */
export function attachCred(node, credType, cred) {
  if (!cred?.id) return node;
  node.credentials = { ...(node.credentials ?? {}), [credType]: { id: cred.id, name: cred.name } };
  return node;
}

/**
 * Assemble a workflow payload from named nodes + edges.
 * @param nodes  array of partial nodes (need at least {name, type}); ids/positions auto-filled
 * @param edges  array of { from, to, type='main' } by node name
 * @param opts   { settings }
 */
export function buildWorkflow(name, nodes, edges = [], opts = {}) {
  const placed = nodes.map((n, i) => ({
    id: nodeId(`${name}:${n.name}`),
    name: n.name,
    type: n.type,
    typeVersion: n.typeVersion,
    position: [260 * (i % 6), 180 * Math.floor(i / 6)],
    parameters: n.parameters ?? {},
    ...(n.credentials ? { credentials: n.credentials } : {}),
    // Error-handling config must survive assembly (the analyzer's can-mask-failures
    // signal + the seeded green-but-swallowing case depend on these reaching n8n).
    ...(n.onError ? { onError: n.onError } : {}),
    ...(n.continueOnFail ? { continueOnFail: n.continueOnFail } : {}),
    ...(n.alwaysOutputData ? { alwaysOutputData: n.alwaysOutputData } : {}),
  }));
  const connections = {};
  for (const { from, to, type = 'main' } of edges) {
    connections[from] ??= {};
    connections[from][type] ??= [[]];
    connections[from][type][0].push({ node: to, type, index: 0 });
  }
  return { name, nodes: placed, connections, settings: opts.settings ?? { executionOrder: 'v1' } };
}
