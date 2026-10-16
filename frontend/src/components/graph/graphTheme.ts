/**
 * Canvas rendering rules for the company knowledge graph.
 *
 * Kept separate from the React component so the visual language can be reasoned
 * about (and adjusted) in one place, and so the same rules drive the legend.
 *
 * Encoding rules:
 *   - SHAPE + COLOUR both encode node type, so type survives colour-blindness.
 *   - RING encodes review/validity state (the thing that needs a human).
 *   - DIM encodes "outside the inspected chain".
 */

import type { GraphEdge, GraphNode, NodeType } from '../../api/types';
import { NODE_TYPE_META } from '../../lib/vocabulary';
import type { PathHighlight } from '../../lib/graph';

export const GRAPH_INK = {
  label: '#1c2536',
  labelHalo: 'rgba(255,255,255,0.92)',
  structuralLink: '#c3ccd9',
  dim: 0.1,
};

export const PRIMARY_EDGE_COLOR: Partial<Record<GraphEdge['type'], string>> = {
  contradicts: '#c0392b',
  supersedes: '#c0392b',
  supports: '#2563eb',
  depends_on: '#7c3aed',
  assumes: '#7c3aed',
  affects: '#0f766e',
  raised_for: '#b91c1c',
  observed_by: '#b91c1c',
  escalates: '#b26a04',
};

export interface DrawState {
  selectedId: string | null;
  hoveredId: string | null;
  highlight: PathHighlight | null;
  /** Dim everything outside the inspected chain. */
  dimUnrelated: boolean;
  showLabels: boolean;
}

export type FGNode = GraphNode & { x?: number; y?: number; vx?: number; vy?: number; fx?: number; fy?: number };
export type FGLink = GraphEdge & { source: string | FGNode; target: string | FGNode };

export function nodeAlpha(node: GraphNode, state: DrawState): number {
  if (state.dimUnrelated && state.highlight) {
    if (state.highlight.nodeIds.has(node.id)) return 1;
    if (state.selectedId === node.id) return 1;
    return node.type === 'message' || node.type === 'document' ? 0.05 : GRAPH_INK.dim;
  }
  // Source records are numerous; keep them quiet so structure reads clearly.
  if (node.type === 'message') return 0.55;
  if (node.type === 'document') return 0.75;
  return 1;
}

export function nodeRadius(node: GraphNode): number {
  const base = NODE_TYPE_META[node.type]?.size ?? 5;
  const degreeBoost = Math.min(4, Math.log2((node.degree ?? 0) + 1) * 0.9);
  return base + degreeBoost;
}

/** Ring colour for the review/validity state, or null when nothing is outstanding. */
export function stateRing(node: GraphNode): { color: string; dashed: boolean; width: number } | null {
  switch (node.state) {
    case 'contradicted':
      return { color: '#c0392b', dashed: true, width: 2 };
    case 'new_fact':
    case 'contradicted_replacement':
      return { color: '#0b6c95', dashed: false, width: 2 };
    case 'needs_review':
      return { color: '#b26a04', dashed: false, width: 2 };
    case 'confirmed_stale':
      return { color: '#c0392b', dashed: false, width: 2.5 };
    case 'potentially_affected':
      return { color: '#b26a04', dashed: true, width: 1.6 };
    case 'dismissed':
      return { color: '#8794a8', dashed: true, width: 1.2 };
    case 'resolved':
      return { color: '#16714a', dashed: false, width: 1.6 };
    default:
      return null;
  }
}

export function traceShape(
  ctx: CanvasRenderingContext2D,
  type: NodeType,
  x: number,
  y: number,
  r: number,
): void {
  const shape = NODE_TYPE_META[type]?.shape ?? 'circle';
  ctx.beginPath();

  switch (shape) {
    case 'square': {
      const s = r * 1.75;
      ctx.rect(x - s / 2, y - s / 2, s, s);
      break;
    }
    case 'diamond': {
      const s = r * 1.3;
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      break;
    }
    case 'triangle': {
      const s = r * 1.35;
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s * 0.92, y + s * 0.72);
      ctx.lineTo(x - s * 0.92, y + s * 0.72);
      ctx.closePath();
      break;
    }
    case 'hexagon': {
      const s = r * 1.2;
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        const px = x + s * Math.cos(angle);
        const py = y + s * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'star': {
      const outer = r * 1.5;
      const inner = r * 0.66;
      for (let i = 0; i < 10; i += 1) {
        const radius = i % 2 === 0 ? outer : inner;
        const angle = (Math.PI / 5) * i - Math.PI / 2;
        const px = x + radius * Math.cos(angle);
        const py = y + radius * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'circle':
    default:
      ctx.arc(x, y, r, 0, Math.PI * 2);
      break;
  }
}

export function drawNode(ctx: CanvasRenderingContext2D, node: FGNode, globalScale: number, state: DrawState): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const r = nodeRadius(node);
  const alpha = nodeAlpha(node, state);
  const meta = NODE_TYPE_META[node.type];
  const isSelected = state.selectedId === node.id;
  const isHovered = state.hoveredId === node.id;
  const onPath = state.highlight?.nodeIds.has(node.id) ?? false;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Selected / on-path halo, drawn behind the node so the shape stays crisp.
  if (isSelected || onPath) {
    ctx.beginPath();
    ctx.arc(x, y, r + (isSelected ? 7 : 4.5), 0, Math.PI * 2);
    ctx.fillStyle = isSelected ? 'rgba(31,75,216,0.22)' : 'rgba(31,75,216,0.13)';
    ctx.fill();
  }

  if (isHovered) {
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15,23,41,0.10)';
    ctx.fill();
  }

  traceShape(ctx, node.type, x, y, r);
  ctx.fillStyle = meta.hex;
  ctx.fill();

  // A white inner edge keeps overlapping nodes readable on the light canvas.
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const ring = stateRing(node);
  if (ring) {
    ctx.save();
    ctx.globalAlpha = Math.max(alpha, 0.85);
    traceShape(ctx, node.type, x, y, r + 3);
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = ring.width;
    ctx.setLineDash(ring.dashed ? [3, 2.5] : []);
    ctx.stroke();
    ctx.restore();
  }

  if (isSelected) {
    traceShape(ctx, node.type, x, y, r + (ring ? 5.5 : 3.5));
    ctx.strokeStyle = '#1f4bd8';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.stroke();
  }

  ctx.restore();

  // Labels: constant screen size regardless of zoom, and only when they help.
  const labelWorthIt =
    state.showLabels &&
    (globalScale > 0.85 ||
      isSelected ||
      isHovered ||
      onPath ||
      node.state === 'new_fact' ||
      node.state === 'contradicted' ||
      node.state === 'needs_review' ||
      node.state === 'confirmed_stale' ||
      node.type === 'decision' ||
      node.type === 'project');

  if (!labelWorthIt) return;

  const fontSize = (isSelected || onPath ? 4.2 : 3.6) / globalScale;
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(alpha, isSelected || onPath ? 0.95 : 0.7));
  ctx.font = `${isSelected || onPath ? 600 : 400} ${fontSize}px "Inter", "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const text = truncateLabel(node.label, isSelected || onPath ? 34 : 22);
  ctx.lineWidth = 3 / globalScale;
  ctx.strokeStyle = GRAPH_INK.labelHalo;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y + r + 2.5 / globalScale);
  ctx.fillStyle = GRAPH_INK.label;
  ctx.fillText(text, x, y + r + 2.5 / globalScale);
  ctx.restore();
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export function linkAlpha(edge: GraphEdge, state: DrawState): number {
  if (!state.dimUnrelated || !state.highlight) return 1;
  if (state.highlight.edgeIds.has(edge.id)) return 1;
  return 0.07;
}

export function linkColor(edge: GraphEdge, state: DrawState): string {
  if (state.highlight?.edgeIds.has(edge.id)) return '#1f4bd8';
  const primary = PRIMARY_EDGE_COLOR[edge.type];
  if (primary) return primary;
  return GRAPH_INK.structuralLink;
}

export function linkWidth(edge: GraphEdge, state: DrawState): number {
  if (state.highlight?.edgeIds.has(edge.id)) return 2.6;
  if (PRIMARY_EDGE_COLOR[edge.type]) return 1.5;
  return 0.5;
}

/** Only meaningful edges get arrowheads, else the canvas turns into noise. */
export function linkArrowLength(edge: GraphEdge, state: DrawState): number {
  if (state.highlight?.edgeIds.has(edge.id)) return 4;
  return PRIMARY_EDGE_COLOR[edge.type] ? 2.6 : 0;
}

export function linkLineDash(edge: GraphEdge, state: DrawState): number[] {
  if (state.highlight?.edgeIds.has(edge.id)) return [];
  if (edge.type === 'contradicts' || edge.type === 'supersedes') return [3, 2];
  return [];
}

export function linkCurvature(edge: GraphEdge): number {
  if (edge.type === 'contradicts' || edge.type === 'supersedes') return 0.18;
  if (edge.type === 'about' || edge.type === 'documented_in' || edge.type === 'author_of') return 0.32;
  return 0;
}
