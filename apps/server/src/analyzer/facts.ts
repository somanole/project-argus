import type {
  CallerPolicy,
  DataTableRef,
  N8nNode,
  N8nWorkflowListItem,
  NodeTypeFact,
  SystemFact,
  TriggerFact,
  WorkflowFacts,
  CoverageGap,
} from '@argus/shared';
import type { Manifest } from './manifest.js';
import { classifyTrigger } from './triggers.js';
import { systemsForNode, dedupeSystems } from './systems.js';
import { extractDirectRefs, parseWorkflowId, type RawRef } from './refs.js';
import { resolveRefs } from './resolve.js';

/** The fact-shape version; bump when WorkflowFacts changes to force recompute. */
export const FACTS_SCHEMA_VERSION = 1 as const;

const DATA_TABLE_NODE = 'n8n-nodes-base.dataTable';

/**
 * Pass-1 output: everything derivable from ONE workflow's JSON, without knowing the
 * rest of the instance. Direct-dependency resolution + final coverage happen in
 * pass 2 (finalizeFacts), once the instance's full id set is in hand.
 */
export interface Pass1Facts {
  nodeCount: number;
  nodeTypes: NodeTypeFact[];
  triggers: TriggerFact[];
  triggerCountDetected: number;
  triggerCountReported: number | null;
  systems: SystemFact[];
  credentialTypes: string[];
  dataTableRefs: DataTableRef[];
  mcpExposed: boolean;
  callerPolicy: CallerPolicy;
  rawRefs: RawRef[];
  // Coverage inputs (finalized in pass 2):
  unknownNodeTypes: string[];
  unknownCredentials: string[];
  parseAnomalies: string[];
}

/** Pass 1 — analyze a single workflow's node graph. Pure; never throws. */
export function analyzeWorkflow(wf: N8nWorkflowListItem, manifest: Manifest): Pass1Facts {
  const nodes: N8nNode[] = Array.isArray(wf.nodes) ? wf.nodes : [];

  const typeCounts = new Map<string, number>();
  const triggersByType = new Map<string, TriggerFact>();
  const systemFacts: SystemFact[] = [];
  const credentialTypeSet = new Set<string>();
  const dataTableRefs: DataTableRef[] = [];
  const unknownNodeTypeSet = new Set<string>();
  const unknownCredentialSet = new Set<string>();
  const parseAnomalies: string[] = [];
  let triggerCountDetected = 0;

  for (const node of nodes) {
    const type = node.type;
    if (typeof type !== 'string' || type === '') {
      parseAnomalies.push('node missing type');
      continue;
    }
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);

    // Triggers.
    const trig = classifyTrigger(type, manifest);
    if (trig) {
      if (!triggersByType.has(type)) triggersByType.set(type, trig);
      if (node.disabled !== true) triggerCountDetected += 1;
    }

    // Systems + credential types.
    for (const s of systemsForNode(node, manifest)) {
      systemFacts.push(s);
      if (s.via === 'credential' && s.credentialType) {
        credentialTypeSet.add(s.credentialType);
        if (!s.resolved) unknownCredentialSet.add(s.credentialType);
      }
    }

    // Data tables.
    if (type === DATA_TABLE_NODE) {
      const parsed = parseWorkflowId((node.parameters as Record<string, unknown>)?.dataTableId);
      if (parsed) {
        dataTableRefs.push({ mode: parsed.mode, rawValue: parsed.rawValue, cachedName: parsed.cachedName, resolved: false });
      }
    }

    // Unknown node type (rule 5: recorded raw in nodeTypes, drives a coverage gap).
    if (!manifest.nodeKnown(type) && !manifest.isTrigger(type)) unknownNodeTypeSet.add(type);
  }

  const nodeTypes: NodeTypeFact[] = [...typeCounts.entries()].map(([type, count]) => {
    const known = manifest.nodeKnown(type) || manifest.isTrigger(type);
    const category: NodeTypeFact['category'] = manifest.isTrigger(type) ? 'trigger' : known ? 'action' : 'unknown';
    return { type, count, category, known };
  });

  // Caller policy (inward-facing; stored, not shown in the outbound drawer — S5).
  const settings = wf.settings ?? {};
  const callerIdsRaw = (settings as { callerIds?: unknown }).callerIds;
  const callerPolicy: CallerPolicy = {
    policy: typeof settings.callerPolicy === 'string' ? settings.callerPolicy : null,
    callerIds: typeof callerIdsRaw === 'string' ? callerIdsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [],
  };

  return {
    nodeCount: nodes.length,
    nodeTypes,
    triggers: [...triggersByType.values()],
    triggerCountDetected,
    triggerCountReported: typeof wf.triggerCount === 'number' ? wf.triggerCount : null,
    systems: dedupeSystems(systemFacts),
    credentialTypes: [...credentialTypeSet],
    dataTableRefs,
    mcpExposed: settings.availableInMCP === true,
    callerPolicy,
    rawRefs: extractDirectRefs(wf),
    unknownNodeTypes: [...unknownNodeTypeSet],
    unknownCredentials: [...unknownCredentialSet],
    parseAnomalies,
  };
}

/**
 * Pass 2 — finalize one workflow's facts against the instance's complete id set:
 * resolve direct deps and compute the coverage verdict. `understood` is false only
 * when a genuine analyzer gap exists (unknown node type, a by-name unresolved ref,
 * or a parse anomaly); `dynamic` and `broken` are defensible determinations and do
 * NOT count against understanding.
 */
export function finalizeFacts(
  p: Pass1Facts,
  idSet: ReadonlySet<string>,
  complete: boolean,
  nameById: ReadonlyMap<string, string>,
  analyzedAt: string,
): WorkflowFacts {
  const directDeps = resolveRefs(p.rawRefs, idSet, complete, nameById);
  const unresolvedRefs = directDeps.filter((d) => d.resolution === 'unresolved').length;

  const reasons: CoverageGap[] = [];
  for (const t of p.unknownNodeTypes) reasons.push({ kind: 'unknownNodeType', detail: t });
  for (const c of p.unknownCredentials) reasons.push({ kind: 'unknownCredential', detail: c });
  for (const a of p.parseAnomalies) reasons.push({ kind: 'parseAnomaly', detail: a });
  for (const d of directDeps) {
    if (d.resolution === 'dynamic') reasons.push({ kind: 'dynamicRef', detail: d.rawValue ?? d.kind });
    if (d.resolution === 'unresolved') reasons.push({ kind: 'unresolvedRef', detail: d.rawValue ?? d.kind });
  }

  const understood = p.unknownNodeTypes.length === 0 && unresolvedRefs === 0 && p.parseAnomalies.length === 0;

  return {
    schemaVersion: FACTS_SCHEMA_VERSION,
    analyzedAt,
    nodeCount: p.nodeCount,
    nodeTypes: p.nodeTypes,
    triggers: p.triggers,
    triggerCountDetected: p.triggerCountDetected,
    triggerCountReported: p.triggerCountReported,
    systems: p.systems,
    credentialTypes: p.credentialTypes,
    dataTableRefs: p.dataTableRefs,
    mcpExposed: p.mcpExposed,
    directDeps,
    callerPolicy: p.callerPolicy,
    coverage: {
      understood,
      unknownNodeTypes: p.unknownNodeTypes,
      unresolvedRefs,
      reasons,
    },
  };
}
