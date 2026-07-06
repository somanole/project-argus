// The demo fleet. Two layers:
//   • CURATED (~29/instance) — the planted-problem core. Each entry carries a
//     specific shape or governance problem the analyzer/health/graph slices must
//     find. THESE ARE THE DEMO STORY; verify pins their exact numbers. Don't dilute.
//   • PROCEDURAL (~71/instance) — a generated background fleet (procedural.mjs) that
//     grows the estate to ~100/instance so it reads like a real, messy enterprise
//     with real dependency clusters, not a dozen tidy flows. It never references a
//     curated workflow, never touches Salesforce, and is never MCP-exposed, so the
//     curated exact-number contracts (1 broken ref, Slack fan-in 5, 1 Salesforce,
//     2 MCP) are untouched.
// Every entry declares where it lives (team project or a person's personal space),
// its tags, whether it's active/archived/MCP-exposed, what it depends on (drives
// create order), and how to generate its execution history. build(ctx) returns the
// literal n8n JSON. ctx = { ref(key)->realId, cred(key)->{id,name}, webhookBase }

import {
  buildWorkflow, BROKEN_REF,
  manualTrigger, webhookTrigger, scheduleTrigger, chatTrigger, executeWorkflowTrigger,
  httpRequest, set, code, appNode, attachCred,
  executeWorkflow, executeWorkflowPlainString, executeWorkflowInline,
  agent, lmChatOpenAi, memoryBuffer, toolWorkflow, agentTool,
} from './nodes.mjs';
import { generateProceduralFleet } from './procedural.mjs';

const MAYBE_FAIL = "if ($json.body?.fail) { throw new Error('Simulated downstream failure'); }\nreturn $input.all();";

// The curated planted-problem core (order matters only via `dependsOn`).
const CURATED = [
  // ---- shared utility (created first: everything fans into it) ----
  {
    key: 'slackAlert', name: 'Send Slack Alert', project: 'support', tags: ['internal'],
    exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('Send Slack Alert',
      [executeWorkflowTrigger(), attachCred(appNode('Post to Slack', 'n8n-nodes-base.slack', 2.3, { resource: 'message', operation: 'post', select: 'channel', channelId: 'C-alerts', text: '={{ $json.message }}' }), 'slackApi', ctx.cred('slack'))],
      [{ from: 'When Executed by Another Workflow', to: 'Post to Slack' }]),
  },

  // ---- Revenue Ops (Sam is sole owner; the 5 critical live here) ----
  {
    key: 'billingService', name: 'Billing Service', project: 'revenue', tags: ['critical', 'finance'],
    exec: { kind: 'none' },
    build: () => buildWorkflow('Billing Service',
      [executeWorkflowTrigger(), set('Compute Charges')],
      [{ from: 'When Executed by Another Workflow', to: 'Compute Charges' }]),
  },
  {
    key: 'enrichCustomer', name: 'Enrich Customer', project: 'revenue', tags: ['production'],
    dependsOn: ['billingService'], exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('Enrich Customer',
      [executeWorkflowTrigger(), executeWorkflow('Call Billing Service', ctx.ref('billingService'), 'Billing Service')],
      [{ from: 'When Executed by Another Workflow', to: 'Call Billing Service' }]),
  },
  {
    key: 'orderIntake', name: 'Order Intake', project: 'revenue', tags: ['critical', 'production'],
    active: true, webhookPath: 'order-intake', dependsOn: ['enrichCustomer'], exec: { kind: 'webhook', runs: 5 },
    build: (ctx) => buildWorkflow('Order Intake',
      [webhookTrigger('Order Webhook', { path: 'order-intake' }), executeWorkflow('Call Enrich Customer', ctx.ref('enrichCustomer'), 'Enrich Customer')],
      [{ from: 'Order Webhook', to: 'Call Enrich Customer' }]),
  },
  {
    key: 'stripeRecon', name: 'Daily Stripe Reconciliation', project: 'revenue', tags: ['critical', 'finance'],
    exec: { kind: 'manual-fail', runs: 4 },
    build: () => buildWorkflow('Daily Stripe Reconciliation',
      [manualTrigger('Run Reconciliation'), httpRequest('Fetch Stripe Ledger', 'http://127.0.0.1:1/v1/balance/history')],
      [{ from: 'Run Reconciliation', to: 'Fetch Stripe Ledger' }]),
  },
  {
    key: 'invoiceDispatch', name: 'Invoice Dispatch', project: 'revenue', tags: ['critical', 'finance'],
    dependsOn: ['slackAlert'], exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('Invoice Dispatch',
      [manualTrigger('Dispatch Invoices'), executeWorkflow('Send Slack Alert', ctx.ref('slackAlert'), 'Send Slack Alert')],
      [{ from: 'Dispatch Invoices', to: 'Send Slack Alert' }]),
  },
  {
    key: 'refundProcessor', name: 'Refund Processor', project: 'revenue', tags: ['critical', 'finance'],
    dependsOn: ['slackAlert'], exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('Refund Processor',
      [manualTrigger('Process Refund'), attachCred(appNode('Create Stripe Refund', 'n8n-nodes-base.stripe', 1, { resource: 'charge' }), 'stripeApi', ctx.cred('stripe')), executeWorkflow('Send Slack Alert', ctx.ref('slackAlert'), 'Send Slack Alert')],
      [{ from: 'Process Refund', to: 'Create Stripe Refund' }, { from: 'Create Stripe Refund', to: 'Send Slack Alert' }]),
  },
  {
    key: 'salesforceSync', name: 'Salesforce CRM Sync', project: 'revenue', tags: ['production'],
    exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('Salesforce CRM Sync',
      [scheduleTrigger('Every 6 Hours'), attachCred(appNode('Upsert Lead', 'n8n-nodes-base.salesforce', 1, { resource: 'lead', operation: 'upsert' }), 'salesforceOAuth2Api', ctx.cred('salesforce'))],
      [{ from: 'Every 6 Hours', to: 'Upsert Lead' }]),
  },

  // ---- Customer Support ----
  {
    key: 'zendeskSync', name: 'Zendesk Sync', project: 'support', tags: ['production'],
    active: true, webhookPath: 'zendesk-sync', exec: { kind: 'mixed', runs: 6 },
    build: () => buildWorkflow('Zendesk Sync',
      [webhookTrigger('Zendesk Event', { path: 'zendesk-sync' }), code('Sync Tickets', MAYBE_FAIL)],
      [{ from: 'Zendesk Event', to: 'Sync Tickets' }]),
  },
  {
    key: 'supportTicketRouter', name: 'Support Ticket Router', project: 'support', tags: ['production'],
    active: true, webhookPath: 'ticket-in', exec: { kind: 'webhook', runs: 3 },
    build: (ctx) => buildWorkflow('Support Ticket Router',
      [webhookTrigger('Ticket In', { path: 'ticket-in' }), httpRequest('Forward to Campaign', `${ctx.webhookBase}/webhook/campaign-intake`)],
      [{ from: 'Ticket In', to: 'Forward to Campaign' }]),
  },
  {
    key: 'escalationNotifier', name: 'Escalation Notifier', project: 'support', tags: ['internal'],
    dependsOn: ['slackAlert'], exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('Escalation Notifier',
      [manualTrigger('On Escalation'), executeWorkflow('Send Slack Alert', ctx.ref('slackAlert'), 'Send Slack Alert')],
      [{ from: 'On Escalation', to: 'Send Slack Alert' }]),
  },
  {
    key: 'kbLookup', name: 'KB Lookup', project: 'support', tags: ['ai', 'internal'], mcp: true,
    exec: { kind: 'none' },
    build: () => buildWorkflow('KB Lookup',
      [executeWorkflowTrigger(), set('Return KB Doc')],
      [{ from: 'When Executed by Another Workflow', to: 'Return KB Doc' }]),
  },
  {
    key: 'aiSupportAgent', name: 'AI Support Agent', project: 'support', tags: ['ai'],
    dependsOn: ['kbLookup'], exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('AI Support Agent',
      [
        chatTrigger('When chat message received'), agent('AI Support Agent'),
        lmChatOpenAi('OpenAI Chat Model'), memoryBuffer('Window Buffer Memory'),
        toolWorkflow('KB Lookup Tool', ctx.ref('kbLookup'), 'Look up an answer in the knowledge base'),
      ],
      [
        { from: 'When chat message received', to: 'AI Support Agent' },
        { from: 'OpenAI Chat Model', to: 'AI Support Agent', type: 'ai_languageModel' },
        { from: 'Window Buffer Memory', to: 'AI Support Agent', type: 'ai_memory' },
        { from: 'KB Lookup Tool', to: 'AI Support Agent', type: 'ai_tool' },
      ]),
  },
  {
    key: 'agentToolOrchestrator', name: 'Agent Tool Orchestrator', project: 'support', tags: ['ai'],
    exec: { kind: 'none' },
    build: () => buildWorkflow('Agent Tool Orchestrator',
      [chatTrigger('When chat message received'), agent('Orchestrator Agent'), lmChatOpenAi('OpenAI Chat Model'), agentTool('Research Sub-Agent')],
      [
        { from: 'When chat message received', to: 'Orchestrator Agent' },
        { from: 'OpenAI Chat Model', to: 'Orchestrator Agent', type: 'ai_languageModel' },
        { from: 'Research Sub-Agent', to: 'Orchestrator Agent', type: 'ai_tool' },
      ]),
  },

  // ---- Data Platform ----
  {
    key: 'dataQualitySentinel', name: 'Data Quality Sentinel', project: 'data', tags: ['production'],
    active: true, webhookPath: 'data-quality', exec: { kind: 'mixed', runs: 6 },
    build: () => buildWorkflow('Data Quality Sentinel',
      [webhookTrigger('Quality Check', { path: 'data-quality' }), code('Validate Rows', MAYBE_FAIL)],
      [{ from: 'Quality Check', to: 'Validate Rows' }]),
  },
  {
    key: 'archivedAggregator', name: 'Legacy Data Aggregator', project: 'data', tags: ['internal'],
    archived: true, exec: { kind: 'none' },
    build: () => buildWorkflow('Legacy Data Aggregator',
      [executeWorkflowTrigger(), set('Aggregate')],
      [{ from: 'When Executed by Another Workflow', to: 'Aggregate' }]),
  },
  {
    // Not active: n8n 2.29 forbids publishing a workflow that references an
    // archived sub-workflow — which is exactly the depends_on_archived finding.
    key: 'postgresEtl', name: 'Postgres Nightly ETL', project: 'data', tags: ['production'],
    dependsOn: ['archivedAggregator'], exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('Postgres Nightly ETL',
      [scheduleTrigger('Nightly'), attachCred(appNode('Read Warehouse', 'n8n-nodes-base.postgres', 2.6, { operation: 'executeQuery', query: 'SELECT * FROM staging.events' }), 'postgres', ctx.cred('postgres')), executeWorkflow('Call Legacy Aggregator', ctx.ref('archivedAggregator'), 'Legacy Data Aggregator')],
      [{ from: 'Nightly', to: 'Read Warehouse' }, { from: 'Read Warehouse', to: 'Call Legacy Aggregator' }]),
  },
  {
    key: 'warehouseSync', name: 'Data Warehouse Sync', project: 'data', tags: ['production'],
    dependsOn: ['slackAlert'], exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('Data Warehouse Sync',
      [manualTrigger('Run Sync'), attachCred(appNode('Load Warehouse', 'n8n-nodes-base.postgres', 2.6, { operation: 'insert' }), 'postgres', ctx.cred('postgres')), executeWorkflow('Send Slack Alert', ctx.ref('slackAlert'), 'Send Slack Alert')],
      [{ from: 'Run Sync', to: 'Load Warehouse' }, { from: 'Load Warehouse', to: 'Send Slack Alert' }]),
  },
  {
    key: 'sensitiveExporter', name: 'Sensitive Data Exporter', project: 'data', tags: ['finance'], mcp: true,
    exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('Sensitive Data Exporter',
      [manualTrigger('Export'), attachCred(appNode('Query Warehouse', 'n8n-nodes-base.postgres', 2.6, { operation: 'executeQuery', query: 'SELECT * FROM billing.customers' }), 'postgres', ctx.cred('postgres')), attachCred(appNode('Reconcile in Stripe', 'n8n-nodes-base.stripe', 1, { resource: 'charge' }), 'stripeApi', ctx.cred('stripe'))],
      [{ from: 'Export', to: 'Query Warehouse' }, { from: 'Query Warehouse', to: 'Reconcile in Stripe' }]),
  },
  {
    key: 'oldCsvImport', name: 'Old CSV Import', project: 'data', tags: [],
    exec: { kind: 'none' },
    build: () => buildWorkflow('Old CSV Import',
      [manualTrigger('Import CSV'), set('Parse Rows')],
      [{ from: 'Import CSV', to: 'Parse Rows' }]),
  },
  {
    key: 'plainStringCaller', name: 'Plain-String Ref Caller', project: 'data', tags: ['internal'],
    dependsOn: ['billingService'], exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('Plain-String Ref Caller',
      [manualTrigger('Start'), executeWorkflowPlainString('Call Billing (string id)', ctx.ref('billingService'))],
      [{ from: 'Start', to: 'Call Billing (string id)' }]),
  },
  {
    key: 'inlineSubRunner', name: 'Inline Sub-Workflow Runner', project: 'data', tags: ['internal'],
    exec: { kind: 'none' },
    build: () => buildWorkflow('Inline Sub-Workflow Runner',
      [manualTrigger('Start'), executeWorkflowInline('Run Inline Definition', { name: 'Inline Cleanup', nodes: [{ id: 'inline-1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: {} })],
      [{ from: 'Start', to: 'Run Inline Definition' }]),
  },

  // ---- Marketing ----
  {
    key: 'campaignWebhook', name: 'Campaign Webhook Handler', project: 'marketing', tags: ['production'],
    active: true, webhookPath: 'campaign-intake', exec: { kind: 'webhook', runs: 4 },
    build: () => buildWorkflow('Campaign Webhook Handler',
      [webhookTrigger('Campaign Intake', { path: 'campaign-intake' }), set('Store Lead')],
      [{ from: 'Campaign Intake', to: 'Store Lead' }]),
  },
  {
    key: 'leadScorer', name: 'Lead Scorer', project: 'marketing', tags: ['production'],
    exec: { kind: 'none' },
    build: () => buildWorkflow('Lead Scorer',
      [manualTrigger('Score Leads'), executeWorkflow('Call Scoring Model', BROKEN_REF, 'Scoring Model (deleted)')],
      [{ from: 'Score Leads', to: 'Call Scoring Model' }]),
  },
  {
    key: 'newsletterSender', name: 'Newsletter Sender', project: 'marketing', tags: ['production'],
    dependsOn: ['slackAlert'], exec: { kind: 'none' },
    build: (ctx) => buildWorkflow('Newsletter Sender',
      [scheduleTrigger('Weekly'), attachCred(appNode('Send Newsletter', 'n8n-nodes-base.emailSend', 2.1, { subject: 'Weekly Update' }), 'smtp', ctx.cred('email')), executeWorkflow('Send Slack Alert', ctx.ref('slackAlert'), 'Send Slack Alert')],
      [{ from: 'Weekly', to: 'Send Newsletter' }, { from: 'Send Newsletter', to: 'Send Slack Alert' }]),
  },
  {
    key: 'aiCopywriter', name: 'Marketing AI Copywriter', project: 'marketing', tags: ['ai'],
    exec: { kind: 'none' },
    build: () => buildWorkflow('Marketing AI Copywriter',
      [manualTrigger('Generate Copy'), agent('Copywriter Agent'), lmChatOpenAi('OpenAI Chat Model')],
      [{ from: 'Generate Copy', to: 'Copywriter Agent' }, { from: 'OpenAI Chat Model', to: 'Copywriter Agent', type: 'ai_languageModel' }]),
  },
  {
    key: 'exprUrlFetcher', name: 'Expression URL Fetcher', project: 'marketing', tags: ['internal'],
    exec: { kind: 'none' },
    build: () => buildWorkflow('Expression URL Fetcher',
      [manualTrigger('Start'), httpRequest('Fetch Dynamic Endpoint', '={{ $json.endpoint }}')],
      [{ from: 'Start', to: 'Fetch Dynamic Endpoint' }]),
  },
  {
    key: 'exprWebhook', name: 'Dynamic Webhook Endpoint', project: 'marketing', tags: ['internal'],
    exec: { kind: 'none' },
    build: () => buildWorkflow('Dynamic Webhook Endpoint',
      [webhookTrigger('Tenant Hook', { path: '={{ $json.tenant }}-events' }), set('Handle')],
      [{ from: 'Tenant Hook', to: 'Handle' }]),
  },

  // ---- personal-space-critical (lives in Diana's personal project, not a team) ----
  {
    key: 'personalOpsHack', name: 'Personal Ops Hack', ownerPersonal: 'diana', tags: ['critical'],
    exec: { kind: 'none' },
    // A realistic governance smell AND the live planted-secret case: a hardcoded token
    // + basic-auth creds embedded in a URL parameter. Argus's allowlist NEVER forwards
    // URLs/params (DECISION #26), so this secret can never reach the LLM — the redaction
    // backstop is proven by the hermetic planted-secrets test/verify row.
    build: () => buildWorkflow('Personal Ops Hack',
      [manualTrigger('Run'), httpRequest('Ad-hoc Export', 'http://svc:hunter2Pass@reports.internal/export?token=sk-live-PLANTEDoAtQ9x2Kv7Lr8Ts5Yb')],
      [{ from: 'Run', to: 'Ad-hoc Export' }]),
  },
];

// The full per-instance fleet: curated core + procedural background (~100 total).
// The procedural set is generated deterministically, so re-seeding is idempotent.
export const WORKFLOWS = [...CURATED, ...generateProceduralFleet()];
