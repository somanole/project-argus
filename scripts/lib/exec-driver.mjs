// Generate real execution history, including deliberate failures. Three drivers:
//   'webhook'     — POST the production webhook a few times (all succeed)
//   'mixed'       — POST alternating {fail:true/false} → guaranteed success+error
//   'manual-fail' — manual-run a workflow whose HTTP node targets a dead host → error
// All three write execution_entity rows the analyzer will later read.

import { setTimeout as sleep } from 'node:timers/promises';

async function hitWebhook(baseUrl, path, body) {
  try {
    const res = await fetch(`${baseUrl}/webhook/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.status;
  } catch { return 0; }
}

async function manualRun(client, id, triggerName) {
  const r = await client.http('POST', `/rest/workflows/${id}/run`, { body: { triggerToStartFrom: { name: triggerName } } });
  return r.json?.data?.executionId ?? r.json?.executionId ?? '';
}

async function waitDone(client, execId, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const r = await client.http('GET', `/rest/executions/${execId}`);
    const status = r.json?.data?.status ?? r.json?.status;
    if (status && !['running', 'new', 'waiting'].includes(status)) return status;
    await sleep(200);
  }
  return 'unknown';
}

// Find a workflow's start-trigger node name from its built payload.
function triggerNameOf(entry) {
  const wf = entry.build({ webhookBase: 'http://localhost', ref: () => 'x', cred: () => ({}) });
  const trigger = wf.nodes.find((n) => /trigger/i.test(n.type) || n.type.endsWith('manualTrigger'));
  return trigger?.name;
}

export async function generateExecutions(client, inst, ordered, workflowId) {
  let total = 0;
  let errors = 0;

  for (const entry of ordered) {
    const plan = entry.exec ?? { kind: 'none' };
    const id = workflowId[entry.key];
    if (!id || plan.kind === 'none') continue;

    if (plan.kind === 'webhook') {
      for (let i = 0; i < (plan.runs ?? 3); i++) { await hitWebhook(inst.baseUrl, entry.webhookPath, { fail: false, i }); total++; }
    } else if (plan.kind === 'mixed') {
      for (let i = 0; i < (plan.runs ?? 6); i++) {
        const fail = i % 2 === 1; // alternate → guaranteed success + error
        await hitWebhook(inst.baseUrl, entry.webhookPath, { fail, i });
        total++; if (fail) errors++;
      }
    } else if (plan.kind === 'manual-fail') {
      const triggerName = triggerNameOf(entry);
      for (let i = 0; i < (plan.runs ?? 3); i++) {
        const execId = await manualRun(client, id, triggerName);
        if (execId) { const status = await waitDone(client, execId); total++; if (status === 'error') errors++; }
      }
    }
  }

  // let async webhook executions settle before the caller (or verify) reads them
  await sleep(1500);
  return { total, errors };
}
