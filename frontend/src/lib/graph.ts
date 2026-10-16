/**
 * Pure graph helpers.
 *
 * Everything here is a function of data in, data out — no React, no fetching — so
 * path highlighting and affected-node detection can be unit tested directly and
 * the canvas can stay a dumb renderer.
 */

import type { EdgeType, GraphEdge, GraphNode, GraphResponse, NodeType, PathLike } from '../api/types';

export interface Adjacency {
  byNode: Map<string, { edges: GraphEdge[]; neighbourIds: Set<string> }>;
}

export function buildAdjacency(edges: GraphEdge[]): Adjacency {
  const byNode = new Map<string, { edges: GraphEdge[]; neighbourIds: Set<string> }>();

  const touch = (id: string) => {
    let entry = byNode.get(id);
    if (!entry) {
      entry = { edges: [], neighbourIds: new Set() };
      byNode.set(id, entry);
    }
    return entry;
  };

  for (const edge of edges) {
    const source = touch(edge.source);
    const target = touch(edge.target);
    source.edges.push(edge);
    target.edges.push(edge);
    source.neighbourIds.add(edge.target);
    target.neighbourIds.add(edge.source);
  }

  return { byNode };
}

export interface NeighbourLink {
  edge: GraphEdge;
  node: GraphNode | null;
  /** 'out' when the inspected node is the edge source, 'in' when it is the target. */
  direction: 'out' | 'in';
}

export function neighboursOf(
  nodeId: string,
  edges: GraphEdge[],
  nodeIndex: Map<string, GraphNode>,
): NeighbourLink[] {
  const links: NeighbourLink[] = [];
  for (const edge of edges) {
    if (edge.source === nodeId) links.push({ edge, node: nodeIndex.get(edge.target) ?? null, direction: 'out' });
    else if (edge.target === nodeId) links.push({ edge, node: nodeIndex.get(edge.source) ?? null, direction: 'in' });
  }
  return links.sort((a, b) => (b.node?.degree ?? 0) - (a.node?.degree ?? 0));
}

export function indexNodes(nodes: GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** States that mean "this node is involved in the current problem". */
const ATTENTION_STATES = new Set([
  'new_fact',
  'contradicted',
  'contradicted_replacement',
  'potentially_affected',
  'needs_review',
  'confirmed_stale',
]);

export function isAttention(node: GraphNode): boolean {
  return ATTENTION_STATES.has(node.state);
}

export function affectedNodeIds(nodes: GraphNode[]): Set<string> {
  return new Set(nodes.filter(isAttention).map((n) => n.id));
}

export interface PathHighlight {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  /** Ordered node ids for a step-through list. */
  ordered: string[];
  narration: string[];
}

/**
 * Frontend-computed highlight for the currently inspected evidence chain.
 *
 * The backend gives us the canonical path; we do not invent hops. We only mark
 * which existing nodes/edges belong to it so unrelated nodes can be dimmed.
 */
export function pathHighlight(
  nodes: GraphNode[],
  edges: GraphEdge[],
  path: PathLike | null | undefined,
): PathHighlight | null {
  if (!path || !path.nodes || path.nodes.length === 0) return null;

  const nodeIds = new Set(path.nodes);
  const edgeIds = new Set<string>();

  for (const pathEdge of path.edges ?? []) {
    // Prefer the backend's edge id; fall back to matching on type + endpoints so a
    // path still highlights correctly if the backend omits ids.
    if (pathEdge.id) {
      edgeIds.add(pathEdge.id);
      continue;
    }
    const match = edges.find(
      (e) =>
        e.type === pathEdge.type &&
        ((e.source === pathEdge.source && e.target === pathEdge.target) ||
          (e.source === pathEdge.target && e.target === pathEdge.source)),
    );
    if (match) edgeIds.add(match.id);
  }

  // Path ids may reference nodes missing from the current (filtered) graph.
  const ordered = path.nodes.filter((id) => nodes.some((n) => n.id === id));
  return { nodeIds, edgeIds, ordered, narration: path.narration ?? [] };
}

export interface GraphFilters {
  types: NodeType[];
  query: string;
  /** Keep only nodes in an attention state plus their immediate neighbours. */
  attentionOnly: boolean;
  /** Keep only nodes/edges that sit on the inspected path, plus kept endpoints. */
  pathOnly: boolean;
}

export interface FilterResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hiddenCount: number;
}

export function filterGraph(
  graph: GraphResponse | null,
  filters: GraphFilters,
  highlight: PathHighlight | null,
): FilterResult {
  if (!graph) return { nodes: [], edges: [], hiddenCount: 0 };

  const typeFilter = new Set(filters.types);
  const needle = filters.query.trim().toLowerCase();

  let keep = graph.nodes.filter((node) => typeFilter.has(node.type));

  if (filters.attentionOnly) {
    const adjacency = buildAdjacency(graph.edges);
    const attention = affectedNodeIds(graph.nodes);
    const expanded = new Set(attention);
    for (const id of attention) {
      for (const neighbour of adjacency.byNode.get(id)?.neighbourIds ?? []) expanded.add(neighbour);
    }
    keep = keep.filter((node) => expanded.has(node.id));
  }

  if (needle) {
    keep = keep.filter(
      (node) =>
        node.label.toLowerCase().includes(needle) ||
        node.summary.toLowerCase().includes(needle) ||
        node.id.toLowerCase().includes(needle),
    );
  }

  if (filters.pathOnly && highlight) {
    keep = keep.filter((node) => highlight.nodeIds.has(node.id));
  }

  const keptIds = new Set(keep.map((n) => n.id));
  const edges = graph.edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target));

  return { nodes: keep, edges, hiddenCount: graph.nodes.length - keep.length };
}

/** Type counts for the current graph, used by the legend and filters. */
export function countByType(nodes: GraphNode[]): Map<NodeType, number> {
  const counts = new Map<NodeType, number>();
  for (const node of nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  return counts;
}

/**
 * Node ids at the interesting end of a graph: a changed fact, a challenged
 * assumption, or a decision that needs review. Used for the graph's empty/baseline hint.
 */
export function spotlightNodes(nodes: GraphNode[]): GraphNode[] {
  return nodes.filter(isAttention).sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
}

/** Groups an edge list by edge type, for the relationship summary of a node. */
export function groupByEdgeType(links: NeighbourLink[]): Array<{ type: EdgeType; links: NeighbourLink[] }> {
  const groups = new Map<EdgeType, NeighbourLink[]>();
  for (const link of links) {
    const list = groups.get(link.edge.type) ?? [];
    list.push(link);
    groups.set(link.edge.type, list);
  }
  return [...groups.entries()]
    .map(([type, typeLinks]) => ({ type, links: typeLinks }))
    .sort((a, b) => b.links.length - a.links.length);
}
