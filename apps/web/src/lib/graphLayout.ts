import dagre from 'dagre';
import type { GraphNode, GraphEdge } from '@argus/shared';

/**
 * Deterministic left-to-right layered layout (dagre) for the fleet graph. Positions
 * are computed once per graph payload; vue-flow only pans/zooms/renders. Node size is
 * fixed so ranks stay legible; the estate view is already node-capped server-side, so
 * dagre never runs on thousands of nodes (PLAN scale note).
 */

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 48;

export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
}

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): PositionedNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 96, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    // dagre centres nodes; vue-flow positions by top-left.
    return { ...n, x: (pos?.x ?? 0) - NODE_WIDTH / 2, y: (pos?.y ?? 0) - NODE_HEIGHT / 2 };
  });
}
