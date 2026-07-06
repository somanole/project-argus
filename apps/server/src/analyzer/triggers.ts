import type { TriggerFact } from '@argus/shared';
import type { Manifest } from './manifest.js';

/**
 * Trigger classification. Manifest first (ground truth), then a conservative base
 * heuristic; anything else is honestly NOT a trigger (returns null). We never
 * fabricate a display name — an unknown trigger's display is null and the UI shows
 * the raw type.
 */
export function classifyTrigger(type: string, manifest: Manifest): TriggerFact | null {
  const source = manifest.triggerSource(type);
  if (!source) return null;
  return { type, display: manifest.nodeDisplay(type), source };
}
