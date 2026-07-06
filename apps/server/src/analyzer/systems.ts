import type { N8nNode, SystemFact } from '@argus/shared';
import type { Manifest } from './manifest.js';

/**
 * External-system extraction. A workflow "touches" a system when a node binds one
 * of its credentials, or is a dedicated integration node for it. Two honest states:
 *   - resolved: the credential/node type is in the vendored manifest (system may
 *     still be null for generic auth like Header Auth — that's plumbing, not a system).
 *   - unresolved: the credential type is unknown to the manifest — recorded raw, so
 *     nothing is lost, and it drives an `unknownCredential` coverage gap (rule 5).
 */
export function systemsForNode(node: N8nNode, manifest: Manifest): SystemFact[] {
  const out: SystemFact[] = [];

  // From credentials actually bound on the node — the ground truth of what it touches.
  for (const credType of Object.keys(node.credentials ?? {})) {
    const cred = manifest.credential(credType);
    out.push({
      system: cred?.system ?? null,
      via: 'credential',
      credentialType: credType,
      nodeType: null,
      resolved: cred != null,
      raw: credType,
    });
  }

  // From the node type itself (a credential-less integration node still surfaces).
  const nodeSystem = manifest.nodeSystem(node.type);
  if (nodeSystem) {
    out.push({ system: nodeSystem, via: 'node', credentialType: null, nodeType: node.type, resolved: true, raw: node.type });
  }

  return out;
}

/** Dedupe system facts for a whole workflow, preferring a resolved system name. */
export function dedupeSystems(facts: SystemFact[]): SystemFact[] {
  const byKey = new Map<string, SystemFact>();
  for (const f of facts) {
    // Key by the resolved system when known, else the raw type (so unknowns are kept distinct).
    const key = f.system ?? `raw:${f.raw}`;
    const prev = byKey.get(key);
    if (!prev || (!prev.resolved && f.resolved)) byKey.set(key, f);
  }
  return [...byKey.values()];
}
