import { MANIFEST_DATA } from './manifest.data.js';

/**
 * The vendored classification manifest — the analyzer's ground truth for node/
 * credential names, trigger flags, and external-system mapping. Generated from the
 * pinned n8n source by scripts/gen-manifest.mjs (standing rule 1). Runtime reads
 * this vendored data only; it never touches the n8n tree.
 */

export interface ManifestCredential {
  display: string;
  system: string | null;
}
export interface ManifestNode {
  display: string;
  group: string[];
  isTrigger: boolean;
  system: string | null;
}
export interface ManifestData {
  n8nVersion: string;
  credentialTypes: Record<string, ManifestCredential>;
  nodeTypes: Record<string, ManifestNode>;
  triggerTypes: Record<string, { display: string }>;
}

/**
 * A tiny, conservative fallback set of base trigger types — a safety net for the
 * handful of core triggers even if manifest generation ever missed one. It is NOT
 * a substitute for the manifest; anything outside both stays honestly `unknown`.
 */
const HEURISTIC_BASE_TRIGGERS = new Set<string>([
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.emailReadImap',
  '@n8n/n8n-nodes-langchain.mcpTrigger',
  '@n8n/n8n-nodes-langchain.chatTrigger',
]);

export interface Manifest {
  readonly n8nVersion: string;
  nodeKnown(type: string): boolean;
  nodeDisplay(type: string): string | null;
  nodeSystem(type: string): string | null;
  /** Classify a node type as a trigger: manifest first, then a conservative heuristic. */
  triggerSource(type: string): 'manifest' | 'heuristic' | null;
  isTrigger(type: string): boolean;
  credential(type: string): ManifestCredential | null;
}

export function createManifest(data: ManifestData = MANIFEST_DATA): Manifest {
  return {
    n8nVersion: data.n8nVersion,
    nodeKnown: (type) => type in data.nodeTypes,
    nodeDisplay: (type) => data.nodeTypes[type]?.display ?? null,
    nodeSystem: (type) => data.nodeTypes[type]?.system ?? null,
    triggerSource: (type) => {
      if (type in data.triggerTypes) return 'manifest';
      if (HEURISTIC_BASE_TRIGGERS.has(type)) return 'heuristic';
      return null;
    },
    isTrigger: (type) => type in data.triggerTypes || HEURISTIC_BASE_TRIGGERS.has(type),
    credential: (type) => data.credentialTypes[type] ?? null,
  };
}

/** The default manifest, backed by the vendored data. */
export const manifest: Manifest = createManifest();
