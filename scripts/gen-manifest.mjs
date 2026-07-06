#!/usr/bin/env node
// Generate the analyzer's vendored classification manifest from the pinned n8n
// source (standing rule 1: ground truth, not memory). READ-ONLY over ../n8n.
//
// The manifest is the analyzer's ground truth for: which node types are triggers,
// what a node/credential's display name is, and which external system a credential
// maps to. It is a BUILD-TIME artifact — generated here, vendored into the repo
// (apps/server/src/analyzer/manifest.data.ts), and version-pinned. Runtime never
// touches the n8n tree. Regenerate on every n8n version bump.
//
// Source registries (n8n's own compiled metadata — the authoritative list):
//   packages/nodes-base/dist/types/{nodes,credentials}.json
//   packages/@n8n/nodes-langchain/dist/types/{nodes,credentials}.json
//
// Usage: node scripts/gen-manifest.mjs   (requires ../n8n built — dist present)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const N8N = join(ROOT, '..', 'n8n');
const N8N_VERSION = '2.29.0';
const OUT = join(ROOT, 'apps/server/src/analyzer/manifest.data.ts');

const PACKAGES = [
  { dir: 'packages/nodes-base', prefix: 'n8n-nodes-base' },
  { dir: 'packages/@n8n/nodes-langchain', prefix: '@n8n/n8n-nodes-langchain' },
];

// Generic auth credential types that are NOT an external system — mapping them to
// a "system" would pollute the systems facet with plumbing (a raw HTTP call is not
// "touching HttpHeaderAuth"). These carry system=null.
const GENERIC_AUTH = new Set([
  'httpBasicAuth', 'httpDigestAuth', 'httpHeaderAuth', 'httpQueryAuth',
  'httpCustomAuth', 'httpBearerAuth', 'httpSslAuth', 'oAuth1Api', 'oAuth2Api', 'jwtAuth',
]);

// Normalized names that are auth plumbing, not an external system — nulled out even
// if a credential/node maps to one (e.g. "JWT Auth" → "Auth").
const PLUMBING_SYSTEMS = new Set(['Auth', 'Basic Auth', 'Header Auth', 'Bearer Auth', 'Custom Auth', 'Digest Auth', 'Query Auth', 'SSL', '']);

// Normalize a credential/node displayName to an external-system name. Deterministic
// and vendored (this is stored output, not a runtime guess): strip the auth-plumbing
// words n8n appends to credential display names.
function toSystem(displayName) {
  const s = String(displayName)
    .replace(/\b(API|OAuth2|OAuth1|OAuth|SSO|SAML|JWT|Service Account|account|credentials?|token)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const name = s || String(displayName).trim();
  return PLUMBING_SYSTEMS.has(name) ? null : name;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---- credentials → { display, system } ----
const credentialTypes = {};
for (const { dir } of PACKAGES) {
  const path = join(N8N, dir, 'dist/types/credentials.json');
  for (const c of readJson(path)) {
    if (!c?.name) continue;
    if (credentialTypes[c.name]) continue; // first wins (stable)
    const display = c.displayName ?? c.name;
    credentialTypes[c.name] = {
      display,
      system: GENERIC_AUTH.has(c.name) ? null : toSystem(display),
    };
  }
}

// ---- nodes → { display, isTrigger, system } ----
// n8n's nodes.json repeats a node once per version; merge (last non-empty wins for
// display; isTrigger if ANY version is a trigger). system is inferred from the
// node's declared credentials when they agree on a single system.
const nodeTypes = {};
const triggerTypes = {};
for (const { dir, prefix } of PACKAGES) {
  const path = join(N8N, dir, 'dist/types/nodes.json');
  for (const n of readJson(path)) {
    if (!n?.name) continue;
    const fullType = `${prefix}.${n.name}`;
    const isTrigger = Array.isArray(n.group) && n.group.includes('trigger');

    // System inference from declared credentials: collect distinct non-null systems.
    const credSystems = new Set();
    for (const cred of n.credentials ?? []) {
      const sys = credentialTypes[cred.name]?.system;
      if (sys) credSystems.add(sys);
    }
    const system = credSystems.size === 1 ? [...credSystems][0] : null;

    const prev = nodeTypes[fullType];
    const entry = {
      display: n.displayName ?? prev?.display ?? n.name,
      group: Array.isArray(n.group) ? n.group : (prev?.group ?? []),
      isTrigger: isTrigger || prev?.isTrigger || false,
      // Prefer a resolved system over null across versions.
      system: system ?? prev?.system ?? null,
    };
    nodeTypes[fullType] = entry;
    if (entry.isTrigger) triggerTypes[fullType] = { display: entry.display };

    // n8n auto-generates a `<name>Tool` alias for every node flagged usableAsTool
    // (the AI-agent tool-ified form, e.g. gmail → gmailTool). These are first-party
    // but absent from the static registry, so register them deterministically here.
    // usableAsTool may be `true` OR a config object ({ replacements: … }) — both mean
    // n8n generates a `<name>Tool` alias, so treat any truthy value as usable.
    if (n.usableAsTool) {
      const toolType = `${prefix}.${n.name}Tool`;
      const prevTool = nodeTypes[toolType];
      nodeTypes[toolType] = {
        display: `${entry.display} (as tool)`,
        group: prevTool?.group ?? entry.group,
        isTrigger: false,
        system: entry.system ?? prevTool?.system ?? null,
      };
    }
  }
}

// ---- emit the vendored TS ----
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const data = {
  n8nVersion: N8N_VERSION,
  credentialTypes: sortObj(credentialTypes),
  nodeTypes: sortObj(nodeTypes),
  triggerTypes: sortObj(triggerTypes),
};

const banner = `// GENERATED by scripts/gen-manifest.mjs from n8n ${N8N_VERSION} source — DO NOT EDIT BY HAND.
// The analyzer's classification ground truth (standing rule 1). Regenerate on every
// n8n version bump: \`node scripts/gen-manifest.mjs\`.
import type { ManifestData } from './manifest.js';

export const MANIFEST_DATA: ManifestData = ${JSON.stringify(data, null, 0)};
`;
writeFileSync(OUT, banner + '\n', 'utf8');

const nCred = Object.keys(data.credentialTypes).length;
const nNode = Object.keys(data.nodeTypes).length;
const nTrig = Object.keys(data.triggerTypes).length;
const nSys = new Set(Object.values(data.credentialTypes).map((c) => c.system).filter(Boolean)).size;
console.log(`manifest.data.ts written: ${nNode} node types, ${nTrig} triggers, ${nCred} credentials, ${nSys} distinct systems (n8n ${N8N_VERSION}).`);
