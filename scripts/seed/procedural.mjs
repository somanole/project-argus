// The procedural background fleet — the ~70-per-instance workflows that sit *on
// top of* the curated planted-problem core (workflows.mjs) so the estate reads
// like a real, messy enterprise instead of a dozen tidy demo flows.
//
// It is a GENERATOR, not a hand-authored list, and it is deliberately factored so
// the future scale-stress task (seed:large, 1000s of workflows) can reuse it with a
// bigger `scale` — see generateProceduralFleet(opts).
//
// Two hard contracts it must never break (the curated core owns these exact
// numbers, and verify pins them):
//   • It NEVER references a curated workflow — every executeWorkflow / toolWorkflow
//     ref points at another *procedural* key that IS created (topo-ordered), so it
//     adds ZERO broken refs and does NOT perturb "Send Slack Alert fan-in = 5".
//   • It NEVER touches Salesforce and is NEVER MCP-exposed — those stay curated-only
//     (exactly one Salesforce workflow and exactly two MCP workflows per instance).
// And one quality contract: every node type it emits is known to the analyzer
// manifest and every ref resolves, so the estate stays 100% "understood".
//
// Determinism: shape is a pure function of each workflow's key (a seeded PRNG), so
// re-running `pnpm seed` lands the identical fleet — same count, same structure,
// same verify numbers. No Math.random / Date.now.

import {
  buildWorkflow,
  manualTrigger, webhookTrigger, scheduleTrigger, chatTrigger, executeWorkflowTrigger,
  httpRequest, set, noOp, appNode, attachCred,
  executeWorkflow, agent, lmChatOpenAi, memoryBuffer, toolWorkflow,
} from './nodes.mjs';

// ---- deterministic PRNG (FNV-1a seed → mulberry32) -------------------------

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seedStr) {
  let a = hashSeed(seedStr);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (arr, r) => arr[Math.floor(r() * arr.length)];
// Skew toward the front of the list (r²) so a few items become fan-in hubs.
const pickHub = (arr, r) => arr[Math.floor(r() * r() * arr.length)];

// ---- palette ---------------------------------------------------------------

// Owning contexts: the four curated team projects + the four personal spaces.
// (No NEW team projects — verify pins "4 team projects per instance", and the
// single-owner-critical Revenue Ops narrative depends on the project set staying
// as curated. Diversity comes from systems / triggers / dependency shape instead.)
const TEAM_PROJECTS = ['revenue', 'support', 'data', 'marketing'];
const PERSONAL_OWNERS = ['sam', 'priya', 'diana', 'marco'];

// External systems the background touches. `cred` (optional) is a key in the
// CREDENTIALS fixture; when present the node binds it, otherwise the node type
// alone surfaces the system to the analyzer. typeVersions are the base versions
// the running n8n reports for each (rule-1 checked), so every node opens cleanly.
const SYSTEMS = [
  { node: 'n8n-nodes-base.slack', v: 2.3, cred: 'slack', credType: 'slackApi', op: { resource: 'message', operation: 'post' } },
  { node: 'n8n-nodes-base.postgres', v: 2.6, cred: 'postgres', credType: 'postgres', op: { operation: 'executeQuery', query: 'SELECT 1' } },
  { node: 'n8n-nodes-base.notion', v: 1, cred: 'notion', credType: 'notionApi', op: { resource: 'databasePage' } },
  { node: 'n8n-nodes-base.hubspot', v: 1, cred: 'hubspot', credType: 'hubspotApi', op: { resource: 'contact' } },
  { node: 'n8n-nodes-base.airtable', v: 1, cred: 'airtable', credType: 'airtableApi', op: { operation: 'list' } },
  { node: 'n8n-nodes-base.telegram', v: 1.2, cred: 'telegram', credType: 'telegramApi', op: { resource: 'message', operation: 'sendMessage' } },
  { node: 'n8n-nodes-base.mattermost', v: 1, cred: 'mattermost', credType: 'mattermostApi', op: { resource: 'message' } },
  { node: 'n8n-nodes-base.mongoDb', v: 1.3, cred: 'mongo', credType: 'mongoDb', op: { operation: 'find' } },
  { node: 'n8n-nodes-base.mySql', v: 1, cred: 'mysql', credType: 'mySql', op: { operation: 'executeQuery' } },
  { node: 'n8n-nodes-base.googleSheets', v: 2, cred: 'gsheets', credType: 'googleSheetsOAuth2Api', op: { operation: 'append' } },
  { node: 'n8n-nodes-base.intercom', v: 1, cred: 'intercom', credType: 'intercomApi', op: { resource: 'user' } },
  // credential-less (node type alone maps to a system in the manifest):
  { node: 'n8n-nodes-base.zendesk', v: 1, op: { resource: 'ticket' } },
  { node: 'n8n-nodes-base.asana', v: 1, op: { resource: 'task' } },
  { node: 'n8n-nodes-base.clickUp', v: 1, op: { resource: 'task' } },
  { node: 'n8n-nodes-base.linear', v: 1.1, op: { resource: 'issue' } },
  { node: 'n8n-nodes-base.gitlab', v: 1, op: { resource: 'issue' } },
  { node: 'n8n-nodes-base.freshdesk', v: 1, op: { resource: 'ticket' } },
  { node: 'n8n-nodes-base.googleCalendar', v: 1.3, op: { resource: 'event' } },
  { node: 'n8n-nodes-base.microsoftTeams', v: 2, op: { resource: 'channelMessage' } },
  { node: 'n8n-nodes-base.mailchimp', v: 1, op: { resource: 'member' } },
  { node: 'n8n-nodes-base.trello', v: 1, op: { resource: 'card' } },
];

const BG_TAGS = ['production', 'internal', 'ops', 'etl', 'crm', 'reporting', 'notifications', 'integration'];

// Domain vocabulary for believable names.
const DOMAINS = [
  'Order', 'Invoice', 'Customer', 'Lead', 'Ticket', 'Contact', 'Payment', 'Subscription',
  'Inventory', 'Shipment', 'Campaign', 'Report', 'Metric', 'Account', 'Deal', 'Contract',
  'Onboarding', 'Renewal', 'Refund', 'Feedback', 'Incident', 'Alert', 'Backup', 'Export',
  'Import', 'Digest', 'Reminder', 'Survey', 'Payroll', 'Expense', 'Asset', 'License',
];
const VERBS = ['Sync', 'Process', 'Notify', 'Aggregate', 'Reconcile', 'Enrich', 'Route', 'Archive', 'Dispatch', 'Monitor', 'Publish', 'Ingest'];
const UTIL_NAMES = [
  'Log Event', 'Write Audit Entry', 'Send Ops Notification', 'Format Payload',
  'Normalize Contact', 'Rate-Limit Guard', 'Enrich Company Record', 'Post Metric',
];
const MID_NAMES = [
  'Validate & Route Payload', 'Transform Records', 'Fan Out Notifications', 'Batch Upsert',
  'Reconcile Ledger Slice', 'Score & Tag Lead', 'Compose Digest', 'Resolve Owner',
  'Materialize View', 'Sync External IDs',
];

// A stable node-name builder so buildWorkflow's hashed node ids never collide
// within a workflow.
const step = (label, i) => `${label} ${i + 1}`;

// ---- node helpers ----------------------------------------------------------

const formTrigger = (name = 'On Form Submission') => ({
  type: 'n8n-nodes-base.formTrigger', typeVersion: 1,
  parameters: { formTitle: name, formFields: { values: [] } }, name,
});

const lmAnthropic = (name = 'Anthropic Chat Model') => ({
  type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.5,
  parameters: { model: 'claude-3-5-sonnet', options: {} }, name,
});
const lmGemini = (name = 'Gemini Chat Model') => ({
  type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', typeVersion: 1.1,
  parameters: { modelName: 'models/gemini-1.5-pro', options: {} }, name,
});

// Build a system action node (bind its credential when the fixture has one).
function systemNode(sys, name, ctx) {
  const node = appNode(name, sys.node, sys.v, { ...(sys.op ?? {}) });
  return sys.cred ? attachCred(node, sys.credType, ctx.cred(sys.cred)) : node;
}

// ---- generator -------------------------------------------------------------

/**
 * Generate the procedural background fleet.
 * @param {object} opts
 * @param {number} [opts.utilities=8]  shared sub-workflows (fan-in hubs)
 * @param {number} [opts.mids=10]      mid-level sub-workflows (call utilities, are called)
 * @param {number} [opts.chains=4]     linear sub-workflow chains…
 * @param {number} [opts.chainDepth=3] …each this many workflows deep
 * @param {number} [opts.leaves=33]    top-level business workflows (the bulk)
 * @param {number} [opts.agents=8]     AI-agent workflows (agent→tool links)
 * @returns entries in the workflows.mjs registry shape (key/name/project|ownerPersonal/
 *   tags/active/webhookPath/dependsOn/exec/build). scale ≈ sum of the above (~71).
 */
export function generateProceduralFleet(opts = {}) {
  const {
    utilities = 8, mids = 10, chains = 4, chainDepth = 3, leaves = 33, agents = 8,
  } = opts;

  const entries = [];
  const utilKeys = [];
  const midKeys = [];
  const callableKeys = []; // everything a leaf/agent may call (utilities + mids + chain heads)

  const ownerOf = (r) => (r() < 0.22
    ? { ownerPersonal: pick(PERSONAL_OWNERS, r) }
    : { project: pick(TEAM_PROJECTS, r) });
  const tagsOf = (r, n = 2) => {
    const out = new Set();
    const k = Math.floor(r() * (n + 1));
    for (let i = 0; i < k; i++) out.add(pick(BG_TAGS, r));
    return [...out];
  };

  // --- Tier A: shared utility sub-workflows (the fan-in hubs) ---
  for (let i = 0; i < utilities; i++) {
    const key = `p-util-${i}`;
    const r = rng(key);
    const name = `${UTIL_NAMES[i % UTIL_NAMES.length]}${i >= UTIL_NAMES.length ? ` ${Math.floor(i / UTIL_NAMES.length) + 1}` : ''}`;
    const sys = pick(SYSTEMS, r);
    utilKeys.push(key);
    callableKeys.push(key);
    entries.push({
      key, name, ...ownerOf(r), tags: tagsOf(r, 1), exec: { kind: 'none' },
      build: (ctx) => buildWorkflow(name,
        [executeWorkflowTrigger(), systemNode(sys, 'Do Work', ctx), noOp('Return')],
        [{ from: 'When Executed by Another Workflow', to: 'Do Work' }, { from: 'Do Work', to: 'Return' }]),
    });
  }

  // --- Tier B: mid-level sub-workflows (call 1–2 utilities; are callable) ---
  for (let i = 0; i < mids; i++) {
    const key = `p-mid-${i}`;
    const r = rng(key);
    const name = `${MID_NAMES[i % MID_NAMES.length]}${i >= MID_NAMES.length ? ` ${Math.floor(i / MID_NAMES.length) + 1}` : ''}`;
    const calls = uniquePicks(utilKeys, 1 + Math.floor(r() * 2), r, pickHub);
    const sys = pick(SYSTEMS, r);
    midKeys.push(key);
    callableKeys.push(key);
    entries.push({
      key, name, ...ownerOf(r), tags: tagsOf(r), dependsOn: calls, exec: { kind: 'none' },
      build: (ctx) => {
        const nodes = [executeWorkflowTrigger(), systemNode(sys, 'Transform', ctx)];
        const edges = [{ from: 'When Executed by Another Workflow', to: 'Transform' }];
        calls.forEach((ck, j) => {
          const n = step('Call Utility', j);
          nodes.push(executeWorkflow(n, ctx.ref(ck), ck));
          edges.push({ from: 'Transform', to: n });
        });
        return buildWorkflow(name, nodes, edges);
      },
    });
  }

  // --- Tier C: linear sub-workflow chains (depth `chainDepth`) ---
  for (let c = 0; c < chains; c++) {
    // Build tail→head so each hop can ref the next (already-pushed) workflow.
    for (let d = chainDepth - 1; d >= 0; d--) {
      const key = `p-chain-${c}-${d}`;
      const r = rng(key);
      const isHead = d === 0;
      const nextKey = d < chainDepth - 1 ? `p-chain-${c}-${d + 1}` : null;
      const name = `${pick(VERBS, r)} ${pick(DOMAINS, r)} — Stage ${d + 1}`;
      const sys = pick(SYSTEMS, r);
      // Chains stay inactive internal structures (they carry app nodes, which n8n
      // refuses to publish without full config). The head still varies its trigger
      // kind so the fleet's trigger diversity reads real.
      const trig = isHead ? pick(['schedule', 'webhook', 'manual'], r) : 'sub';
      const dependsOn = nextKey ? [nextKey] : [];
      entries.push({
        key, name, ...ownerOf(r), tags: tagsOf(r), dependsOn,
        exec: { kind: 'none' },
        build: (ctx) => {
          const head = isHead
            ? (trig === 'schedule' ? scheduleTrigger('Every Hour')
              : trig === 'webhook' ? webhookTrigger('Ingest', { path: `p-hook-${key}` })
                : manualTrigger('Run Stage'))
            : executeWorkflowTrigger();
          const headName = head.name;
          const nodes = [head, systemNode(sys, 'Work', ctx)];
          const edges = [{ from: headName, to: 'Work' }];
          if (nextKey) {
            nodes.push(executeWorkflow('Call Next Stage', ctx.ref(nextKey), nextKey));
            edges.push({ from: 'Work', to: 'Call Next Stage' });
          }
          return buildWorkflow(name, nodes, edges);
        },
      });
    }
  }

  // --- Tier D: top-level business leaves (the bulk; drive fan-in + cross-project) ---
  // n8n publishes a workflow only when every node's config is complete, which our
  // deliberately-sparse app nodes are not. So the ~35% we mark ACTIVE (the "what's
  // running" slice) get a publish-clean shape — a production trigger → Set → a
  // static HTTP call, no app nodes and no sub-workflow calls. The inactive majority
  // carry the rich shape (app-node systems + fan-in calls) that gives the estate its
  // diversity and dependency clusters.
  for (let i = 0; i < leaves; i++) {
    const key = `p-wf-${i}`;
    const r = rng(key);
    const active = r() < 0.35;
    if (active) {
      const domain = pick(DOMAINS, r);
      const name = `${pick(['Sync', 'Poll', 'Monitor', 'Dispatch'], r)} ${domain} #${i + 1}`;
      const useWebhook = r() < 0.5;
      const webhookPath = useWebhook ? `p-hook-${key}` : undefined;
      const url = pick(['https://api.internal/v1/status', 'https://hooks.internal/notify', 'https://api.acme.example/ingest'], r);
      entries.push({
        key, name, ...ownerOf(r), tags: tagsOf(r, 2), active: true,
        ...(webhookPath ? { webhookPath } : {}), exec: { kind: 'none' },
        build: () => {
          const head = useWebhook ? webhookTrigger('Incoming', { path: webhookPath }) : scheduleTrigger('Daily');
          return buildWorkflow(name,
            [head, set('Prepare'), httpRequest('Call API', url)],
            [{ from: head.name, to: 'Prepare' }, { from: 'Prepare', to: 'Call API' }]);
        },
      });
      continue;
    }
    // Inactive, rich: app-node systems + fan-in calls.
    const name = `${pick(VERBS, r)} ${pick(DOMAINS, r)}${r() < 0.5 ? ` to ${systemLabel(pick(SYSTEMS, r))}` : ''} #${i + 1}`;
    const trigKind = pick(['schedule', 'webhook', 'manual', 'form', 'schedule', 'manual'], r);
    const sysA = pick(SYSTEMS, r);
    const sysB = r() < 0.45 ? pick(SYSTEMS, r) : null;
    const calls = r() < 0.75 ? uniquePicks(callableKeys, 1 + Math.floor(r() * 2), r, pickHub) : [];
    entries.push({
      key, name, ...ownerOf(r), tags: tagsOf(r, 3), dependsOn: calls, exec: { kind: 'none' },
      build: (ctx) => {
        const head = trigKind === 'schedule' ? scheduleTrigger('Daily')
          : trigKind === 'webhook' ? webhookTrigger('Incoming', { path: `p-hook-${key}` })
            : trigKind === 'form' ? formTrigger('Intake Form')
              : manualTrigger('Run');
        const nodes = [head, systemNode(sysA, 'Fetch', ctx)];
        const edges = [{ from: head.name, to: 'Fetch' }];
        let tail = 'Fetch';
        if (sysB) { nodes.push(systemNode(sysB, 'Push', ctx)); edges.push({ from: tail, to: 'Push' }); tail = 'Push'; }
        calls.forEach((ck, j) => {
          const n = step('Call', j);
          nodes.push(executeWorkflow(n, ctx.ref(ck), ck));
          edges.push({ from: tail, to: n });
        });
        return buildWorkflow(name, nodes, edges);
      },
    });
  }

  // --- Tier E: AI-agent workflows (agent → tool sub-workflow links) ---
  for (let i = 0; i < agents; i++) {
    const key = `p-ai-${i}`;
    const r = rng(key);
    const name = `${pick(['Support', 'Research', 'Ops', 'Sales', 'Data', 'Triage', 'Docs', 'Finance'], r)} AI Assistant ${i + 1}`;
    const toolKey = pickHub(callableKeys, r);
    const lm = pick(['openai', 'anthropic', 'gemini'], r);
    const useChat = r() < 0.6;
    entries.push({
      key, name, ...ownerOf(r), tags: ['ai', ...tagsOf(r, 1)], dependsOn: [toolKey], exec: { kind: 'none' },
      build: (ctx) => {
        const trig = useChat ? chatTrigger('When chat message received') : manualTrigger('Ask Assistant');
        const model = lm === 'anthropic' ? lmAnthropic() : lm === 'gemini' ? lmGemini() : lmChatOpenAi();
        const nodes = [
          trig, agent(`${name} Agent`), model, memoryBuffer('Window Buffer Memory'),
          toolWorkflow('Knowledge Tool', ctx.ref(toolKey), 'Look something up via a sub-workflow'),
        ];
        return buildWorkflow(name, nodes, [
          { from: trig.name, to: `${name} Agent` },
          { from: model.name, to: `${name} Agent`, type: 'ai_languageModel' },
          { from: 'Window Buffer Memory', to: `${name} Agent`, type: 'ai_memory' },
          { from: 'Knowledge Tool', to: `${name} Agent`, type: 'ai_tool' },
        ]);
      },
    });
  }

  return entries;
}

// Distinct picks from `arr` (returns fewer than `n` only if the pool is smaller).
function uniquePicks(arr, n, r, picker = pick) {
  const out = new Set();
  let guard = 0;
  while (out.size < Math.min(n, arr.length) && guard++ < n * 8) out.add(picker(arr, r));
  return [...out];
}

function systemLabel(sys) {
  return sys.node.split('.').pop().replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}
