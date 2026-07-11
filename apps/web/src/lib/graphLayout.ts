import type { GraphNode, GraphEdge } from '@argus/shared';

/**
 * Deterministic 2D layout for the fleet graph. A fleet estate is fan-out heavy: a few
 * shared utilities/credentials are called by many workflows, and many workflows
 * reference nothing at all. A layered (dagre) pass turns those fat fan-outs into tall
 * columns and piles every edge-less node into one rank — a hairline that fit-view then
 * shrinks to nothing. So the connected part is laid out with a force-directed
 * simulation (Fruchterman–Reingold + gentle gravity): hubs sit central, their callers
 * fan out radially, and separate dependency clusters settle side by side, filling 2D.
 * The reference-nothing workflows collapse into a compact grid packed beside the blob.
 * Direction still reads from the edge arrowheads. Everything is seeded deterministically
 * (a phyllotaxis spiral, no RNG) so the same payload always lays out identically;
 * positions are computed once and vue-flow only pans/zooms/renders. The estate view is
 * node-capped server-side, so this never runs on thousands of nodes (PLAN scale note).
 */

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 48;

/** Ideal edge length — the resting distance the simulation pulls linked nodes toward. */
const IDEAL = 165;
const ITERATIONS = 500;
const GRAVITY = 0.015;
const GOLDEN_ANGLE = 2.399963229728653;
/** Gap between cells in the isolated-singleton grid. */
const CELL_GAP_X = 26;
const CELL_GAP_Y = 22;
/** Gap between the force blob and the singleton grid. */
const BLOCK_GAP = 90;

export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
}

interface Pt { x: number; y: number }
interface Box { minX: number; minY: number; maxX: number; maxY: number }

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): PositionedNode[] {
  if (nodes.length === 0) return [];

  const ids = new Set(nodes.map((n) => n.id));
  const validEdges = edges.filter((e) => e.source !== e.target && ids.has(e.source) && ids.has(e.target));

  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n.id, 0);
  for (const e of validEdges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const connected = nodes.filter((n) => (degree.get(n.id) ?? 0) > 0);
  const isolated = nodes.filter((n) => (degree.get(n.id) ?? 0) === 0);

  const pos = new Map<string, Pt>();
  forceLayout(connected, validEdges, pos);
  resolveOverlaps(connected, pos);

  const blobBox = boundsOf(connected, pos);
  const grid = gridLayout(isolated);

  // Pack: force blob on the left, the singleton grid on the right, vertically centred.
  const blobW = width(blobBox);
  const blobH = height(blobBox);
  // Normalise the blob to origin.
  for (const n of connected) {
    const p = pos.get(n.id)!;
    pos.set(n.id, { x: p.x - blobBox.minX, y: p.y - blobBox.minY });
  }

  const gridX = blobW + (grid.count > 0 ? BLOCK_GAP : 0);
  const totalH = Math.max(blobH, grid.h);
  for (const n of connected) {
    const p = pos.get(n.id)!;
    pos.set(n.id, { x: p.x, y: p.y + (totalH - blobH) / 2 });
  }
  for (const id of grid.order) {
    const p = grid.pos.get(id)!;
    pos.set(id, { x: gridX + p.x, y: p.y + (totalH - grid.h) / 2 });
  }

  return nodes.map((n) => {
    const p = pos.get(n.id);
    return { ...n, x: p?.x ?? 0, y: p?.y ?? 0 };
  });
}

/** One node's simulation state: position and accumulated displacement this tick. */
interface Sim { x: number; y: number; dx: number; dy: number }

/** Fruchterman–Reingold with a centring gravity, seeded on a deterministic spiral. */
function forceLayout(nodes: GraphNode[], edges: GraphEdge[], pos: Map<string, Pt>): void {
  const n = nodes.length;
  if (n === 0) return;
  const first = nodes[0];
  if (n === 1 && first) { pos.set(first.id, { x: 0, y: 0 }); return; }

  const idx = new Map(nodes.map((node, i) => [node.id, i]));
  // Deterministic phyllotaxis seed spreads nodes evenly with no RNG.
  const seedR = IDEAL * 0.9;
  const P: Sim[] = nodes.map((_, i) => {
    const r = seedR * Math.sqrt(i);
    const a = i * GOLDEN_ANGLE;
    return { x: r * Math.cos(a), y: r * Math.sin(a), dx: 0, dy: 0 };
  });

  const es: Array<[number, number]> = [];
  for (const e of edges) {
    const a = idx.get(e.source);
    const b = idx.get(e.target);
    if (a !== undefined && b !== undefined) es.push([a, b]);
  }

  const k = IDEAL;
  const k2 = k * k;
  let temp = seedR * Math.sqrt(n) * 0.35;
  const cooling = 0.985;

  for (let it = 0; it < ITERATIONS; it++) {
    for (const p of P) { p.dx = 0; p.dy = 0; }
    // Repulsion — every pair pushes apart (O(n²); n is server-capped).
    for (let i = 0; i < n; i++) {
      const pi = P[i]!;
      for (let j = i + 1; j < n; j++) {
        const pj = P[j]!;
        let ex = pi.x - pj.x;
        let ey = pi.y - pj.y;
        let d2 = ex * ex + ey * ey;
        if (d2 < 0.01) { ex = (i - j) || 1; ey = 1; d2 = ex * ex + ey * ey; }
        const d = Math.sqrt(d2);
        const f = k2 / d2; // 1/d falloff, scaled by k²
        const ux = (ex / d) * f;
        const uy = (ey / d) * f;
        pi.dx += ux; pi.dy += uy;
        pj.dx -= ux; pj.dy -= uy;
      }
    }
    // Attraction — linked nodes pull together.
    for (const [a, b] of es) {
      const pa = P[a]!;
      const pb = P[b]!;
      const ex = pa.x - pb.x;
      const ey = pa.y - pb.y;
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01;
      const f = (d * d) / k;
      const ux = (ex / d) * f;
      const uy = (ey / d) * f;
      pa.dx -= ux; pa.dy -= uy;
      pb.dx += ux; pb.dy += uy;
    }
    // Gravity toward centre, then displace capped by the cooling temperature.
    for (const p of P) {
      p.dx -= p.x * GRAVITY;
      p.dy -= p.y * GRAVITY;
      const dl = Math.sqrt(p.dx * p.dx + p.dy * p.dy) || 1;
      const step = Math.min(dl, temp);
      p.x += (p.dx / dl) * step;
      p.y += (p.dy / dl) * step;
    }
    temp *= cooling;
  }

  nodes.forEach((node, i) => { const p = P[i]!; pos.set(node.id, { x: p.x, y: p.y }); });
}

/**
 * A few passes of rectangle separation so wide node cards don't overlap — the point
 * simulation ignores node size, and a governance graph you can't read a label on is
 * useless (rule 5's spirit: legible, not decorative).
 */
function resolveOverlaps(nodes: GraphNode[], pos: Map<string, Pt>): void {
  if (nodes.length < 2) return;
  const padX = 22;
  const padY = 16;
  const minX = NODE_WIDTH + padX;
  const minY = NODE_HEIGHT + padY;
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const ni = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const nj = nodes[j]!;
        const a = pos.get(ni.id)!;
        const b = pos.get(nj.id)!;
        const ox = minX - Math.abs(a.x - b.x);
        const oy = minY - Math.abs(a.y - b.y);
        if (ox > 0 && oy > 0) {
          // Push apart along the axis of least overlap (keeps rows/columns tidy).
          if (ox / minX < oy / minY) {
            const shift = (ox / 2) * (a.x <= b.x ? -1 : 1);
            a.x += shift; b.x -= shift;
          } else {
            const shift = (oy / 2) * (a.y <= b.y ? -1 : 1);
            a.y += shift; b.y -= shift;
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

/** Pack isolated nodes into a compact, roughly square grid. */
function gridLayout(isolated: GraphNode[]): { pos: Map<string, Pt>; order: string[]; w: number; h: number; count: number } {
  const pos = new Map<string, Pt>();
  const order = isolated.map((n) => n.id);
  const count = order.length;
  if (count === 0) return { pos, order, w: 0, h: 0, count };
  const cellW = NODE_WIDTH + CELL_GAP_X;
  const cellH = NODE_HEIGHT + CELL_GAP_Y;
  // Columns chosen so the grid reads visually square-ish (nodes are wide + short).
  const cols = Math.max(1, Math.round(Math.sqrt((count * cellH) / cellW)));
  const rows = Math.ceil(count / cols);
  order.forEach((id, i) => pos.set(id, { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH }));
  return {
    pos,
    order,
    w: Math.min(cols, count) * cellW - CELL_GAP_X,
    h: rows * cellH - CELL_GAP_Y,
    count,
  };
}

function boundsOf(nodes: GraphNode[], pos: Map<string, Pt>): Box {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const p = pos.get(n.id)!;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_WIDTH);
    maxY = Math.max(maxY, p.y + NODE_HEIGHT);
  }
  return { minX, minY, maxX, maxY };
}

const width = (b: Box) => b.maxX - b.minX;
const height = (b: Box) => b.maxY - b.minY;
