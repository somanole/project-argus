// The estate's people, projects, credentials and tags — the same on both
// instances (prod + staging), which is what makes the shared-identity SPOF and
// shared-external-system findings real. Instance-specific wiring lives in estate.mjs.

// Members created via /rest/e2e/reset (fully active users, each with a personal project).
// Sam is the single-point-of-failure owner (sole member of Revenue Ops, owns the
// critical workflows there) — and has the SAME email on both instances.
export const PEOPLE = {
  sam: { key: 'sam', email: 'sam.rivers@acme.example', password: 'PlaywrightTest123', firstName: 'Sam', lastName: 'Rivers' },
  priya: { key: 'priya', email: 'priya.patel@acme.example', password: 'PlaywrightTest123', firstName: 'Priya', lastName: 'Patel' },
  diana: { key: 'diana', email: 'diana.ops@acme.example', password: 'PlaywrightTest123', firstName: 'Diana', lastName: 'Ops' },
  marco: { key: 'marco', email: 'marco.lee@acme.example', password: 'PlaywrightTest123', firstName: 'Marco', lastName: 'Lee' },
};

// Team projects + their human members (role is an assignable project role).
// Revenue Ops has exactly ONE member (Sam) → the single-owner-critical scenario.
export const PROJECTS = {
  revenue: { key: 'revenue', name: 'Revenue Ops', members: [['sam', 'project:admin']] },
  support: { key: 'support', name: 'Customer Support', members: [['priya', 'project:admin'], ['sam', 'project:editor']] },
  data: { key: 'data', name: 'Data Platform', members: [['diana', 'project:admin']] },
  marketing: { key: 'marketing', name: 'Marketing', members: [['marco', 'project:admin']] },
};

// Dummy credentials (fake data — never real secrets). Postgres+Stripe form the
// "sensitive cluster"; Salesforce is the shared external system across instances.
//
// The first five are the curated core (referenced by the planted-problem
// workflows). The rest give the procedural background fleet realistic credential
// diversity — each type is rule-1 verified to create cleanly via the public API
// (see the credential probe in this session's journal entry). NB: no procedural
// credential is `salesforceOAuth2Api` — Salesforce must stay exactly one workflow
// per instance (a verified planted problem), so its credential is curated-only.
export const CREDENTIALS = {
  slack: { key: 'slack', name: 'Slack — Alerts', type: 'slackApi', project: 'support', data: { accessToken: 'xoxb-not-a-real-token' } },
  postgres: { key: 'postgres', name: 'Postgres — Warehouse', type: 'postgres', project: 'data', data: { host: 'warehouse.db.internal', database: 'warehouse', user: 'etl', password: 'not-real', port: 5432, ssl: 'disable' } },
  stripe: { key: 'stripe', name: 'Stripe — Billing', type: 'stripeApi', project: 'revenue', data: { secretKey: 'sk_test_not_a_real_key' } },
  salesforce: { key: 'salesforce', name: 'Salesforce — CRM', type: 'salesforceOAuth2Api', project: 'revenue', data: { clientId: 'not-real', clientSecret: 'not-real' } },
  email: { key: 'email', name: 'Email — SMTP', type: 'smtp', project: 'marketing', data: { host: 'smtp.internal', port: 587, user: 'mailer', password: 'not-real' } },

  // Procedural-fleet credentials (background diversity).
  notion: { key: 'notion', name: 'Notion — Docs', type: 'notionApi', project: 'marketing', data: { apiKey: 'secret_not_real' } },
  hubspot: { key: 'hubspot', name: 'HubSpot — Marketing', type: 'hubspotApi', project: 'marketing', data: { apiKey: 'not-real' } },
  airtable: { key: 'airtable', name: 'Airtable — Ops Base', type: 'airtableApi', project: 'data', data: { apiKey: 'not-real' } },
  telegram: { key: 'telegram', name: 'Telegram — Bot', type: 'telegramApi', project: 'support', data: { accessToken: 'not-real' } },
  mattermost: { key: 'mattermost', name: 'Mattermost — Eng', type: 'mattermostApi', project: 'support', data: { baseUrl: 'https://mm.internal', accessToken: 'not-real' } },
  mongo: { key: 'mongo', name: 'MongoDB — App', type: 'mongoDb', project: 'data', data: { connectionString: 'mongodb://svc:pass@db.internal:27017', database: 'app' } },
  mysql: { key: 'mysql', name: 'MySQL — Reporting', type: 'mySql', project: 'data', data: { host: 'mysql.internal', database: 'reporting', user: 'svc', password: 'not-real', port: 3306 } },
  gsheets: { key: 'gsheets', name: 'Google Sheets — Exports', type: 'googleSheetsOAuth2Api', project: 'marketing', data: { clientId: 'not-real', clientSecret: 'not-real' } },
  intercom: { key: 'intercom', name: 'Intercom — Support', type: 'intercomApi', project: 'support', data: { apiKey: 'not-real' } },
};

// The tags the fleet uses. The first five are the curated core (verify keys off
// 'critical'); the rest label the procedural background so the estate reads like a
// real, varied company rather than a repetitive one.
export const TAGS = ['critical', 'production', 'ai', 'finance', 'internal', 'ops', 'etl', 'crm', 'reporting', 'notifications', 'integration'];
