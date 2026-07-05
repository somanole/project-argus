// Estate-level (cross-instance) wiring. Two of the three estate scenarios are
// inherent in the base fleet applied to both instances:
//   • shared-identity SPOF — Sam Rivers has the same email in prod + staging and
//     is the sole member of Revenue Ops (5 critical workflows) in each.
//   • shared external system — a Salesforce credential + Salesforce CRM Sync
//     exist in both instances.
// The third — the cross-instance webhook edge — is a STAGING-only workflow whose
// HTTP Request calls a PROD webhook URL ("prod depended on by staging").

import { buildWorkflow, manualTrigger, httpRequest } from './nodes.mjs';

/** A staging workflow that reaches into prod's Order Intake webhook by URL. */
export function crossInstanceBridge(prodBaseUrl) {
  return {
    key: 'stagingProdBridge', name: 'Staging → Prod Order Sync', project: 'revenue', tags: ['production'],
    exec: { kind: 'none' },
    build: () => buildWorkflow('Staging → Prod Order Sync',
      [manualTrigger('Sync to Prod'), httpRequest('Call Prod Order Intake', `${prodBaseUrl}/webhook/order-intake`)],
      [{ from: 'Sync to Prod', to: 'Call Prod Order Intake' }]),
  };
}
