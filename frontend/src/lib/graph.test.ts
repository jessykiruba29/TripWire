import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, GraphResponse, PathLike } from '../api/types';
import {
  affectedNodeIds,
  buildAdjacency,
  countByType,
  filterGraph,
  groupByEdgeType,
  indexNodes,
  isAttention,
  neighboursOf,
  pathHighlight,
  spotlightNodes,
} from './graph';

function node(partial: Partial<GraphNode> & Pick<GraphNode, 'id' | 'type'>): GraphNode {
  return {
    label: partial.id,
    state: 'normal',
    summary: '',
    confidence: null,
    project_ids: [],
    team_ids: [],
    valid_from: null,
    valid_to: null,
    recorded_at: null,
    degree: 0,
    source_ids: [],
    properties: {},
    ...partial,
  };
}

function edge(id: string, source: string, target: string, type: GraphEdge['type']): GraphEdge {
  return { id, source, target, type, label: type, confidence: null, properties: {} };
}

const NODES: GraphNode[] = [
  node({ id: 'FACT-NEW', type: 'fact', state: 'new_fact', degree: 2, label: 'Certification lost' }),
  node({ id: 'FACT-OLD', type: 'fact', state: 'contradicted', degree: 3, label: 'Certification held' }),
  node({ id: 'ASM-RES', type: 'assumption', state: 'needs_review', degree: 5, label: 'Data residency' }),
  node({ id: 'DEC-LAUNCH', type: 'decision', state: 'needs_review', degree: 6, label: 'EU launch' }),
  node({ id: 'DEC-OTHER', type: 'decision', state: 'normal', degree: 2, label: 'Atlanta retry' }),
  node({ id: 'PER-1', type: 'person', state: 'normal', degree: 4, label: 'Lukas Meyer' }),
  node({ id: 'SRC-1', type: 'message', state: 'normal', degree: 1, label: '#ecom-launch' }),
];

const EDGES: GraphEdge[] = [
  edge('e1', 'FACT-NEW', 'FACT-OLD', 'contradicts'),
  edge('e2', 'FACT-OLD', 'ASM-RES', 'supports'),
  edge('e3', 'DEC-LAUNCH', 'ASM-RES', 'depends_on'),
  edge('e4', 'PER-1', 'DEC-LAUNCH', 'owns_decision'),
  edge('e5', 'SRC-1', 'FACT-OLD', 'documented_in'),
];

const GRAPH: GraphResponse = {
  revision: 2,
  generated_at: '2026-10-16T09:00:00.000Z',
  nodes: NODES,
  edges: EDGES,
  stats: { node_count: NODES.length, edge_count: EDGES.length, by_type: {}, by_state: {} },
  truncated: false,
};

describe('buildAdjacency / neighboursOf', () => {
  it('links both directions and keeps edge identity', () => {
    const adjacency = buildAdjacency(EDGES);
    expect(adjacency.byNode.get('FACT-OLD')?.neighbourIds).toEqual(new Set(['FACT-NEW', 'ASM-RES', 'SRC-1']));
    expect(adjacency.byNode.get('DEC-LAUNCH')?.edges.map((e) => e.id).sort()).toEqual(['e3', 'e4']);
  });

  it('reports direction relative to the inspected node', () => {
    const links = neighboursOf('DEC-LAUNCH', EDGES, indexNodes(NODES));
    const toAssumption = links.find((l) => l.node?.id === 'ASM-RES');
    const fromPerson = links.find((l) => l.node?.id === 'PER-1');
    expect(toAssumption?.direction).toBe('out');
    expect(fromPerson?.direction).toBe('in');
  });

  it('groups relationships by edge type, most common first', () => {
    const groups = groupByEdgeType(neighboursOf('FACT-OLD', EDGES, indexNodes(NODES)));
    expect(groups.map((g) => g.type).sort()).toEqual(['contradicts', 'documented_in', 'supports']);
  });
});

describe('attention states', () => {
  it('treats only meaningful states as attention', () => {
    expect(isAttention(node({ id: 'a', type: 'fact', state: 'new_fact' }))).toBe(true);
    expect(isAttention(node({ id: 'b', type: 'fact', state: 'needs_review' }))).toBe(true);
    expect(isAttention(node({ id: 'c', type: 'fact', state: 'normal' }))).toBe(false);
    expect(isAttention(node({ id: 'd', type: 'fact', state: 'dismissed' }))).toBe(false);
  });

  it('spotlights the most connected relevant node first', () => {
    const attention = affectedNodeIds(NODES);
    expect(attention.has('DEC-OTHER')).toBe(false);
    expect(spotlightNodes(NODES).map((n) => n.id)).toContain('ASM-RES');
  });
});

describe('pathHighlight', () => {
  const path: PathLike = {
    nodes: ['FACT-NEW', 'FACT-OLD', 'ASM-RES', 'DEC-LAUNCH'],
    edges: [
      { id: 'e1', source: 'FACT-NEW', target: 'FACT-OLD', type: 'contradicts', label: 'contradicts' },
      { id: 'e2', source: 'FACT-OLD', target: 'ASM-RES', type: 'supports', label: 'supports' },
      { id: 'e3', source: 'DEC-LAUNCH', target: 'ASM-RES', type: 'depends_on', label: 'depends on' },
    ],
    narration: ['The new fact contradicts the old one.'],
  };

  it('marks exactly the nodes and edges on the chain', () => {
    const highlight = pathHighlight(NODES, EDGES, path);
    expect(highlight).not.toBeNull();
    expect(highlight?.nodeIds).toEqual(new Set(['FACT-NEW', 'FACT-OLD', 'ASM-RES', 'DEC-LAUNCH']));
    expect(highlight?.edgeIds).toEqual(new Set(['e1', 'e2', 'e3']));
    // the unrelated decision and its owner are NOT on the chain
    expect(highlight?.nodeIds.has('DEC-OTHER')).toBe(false);
    expect(highlight?.nodeIds.has('PER-1')).toBe(false);
  });

  it('falls back to matching on endpoints when the backend omits edge ids', () => {
    const withoutIds: PathLike = {
      nodes: ['FACT-NEW', 'FACT-OLD'],
      edges: [{ id: '', source: 'FACT-NEW', target: 'FACT-OLD', type: 'contradicts', label: 'contradicts' }],
    };
    expect(pathHighlight(NODES, EDGES, withoutIds)?.edgeIds).toEqual(new Set(['e1']));
  });

  it('returns null when there is no path to show', () => {
    expect(pathHighlight(NODES, EDGES, null)).toBeNull();
    expect(pathHighlight(NODES, EDGES, { nodes: [], edges: [] })).toBeNull();
  });

  it('drops path nodes that are not in the current graph view', () => {
    const highlight = pathHighlight(NODES, EDGES, { nodes: ['FACT-NEW', 'GHOST-1'], edges: [] });
    expect(highlight?.ordered).toEqual(['FACT-NEW']);
  });
});

describe('filterGraph', () => {
  const all = { types: NODES.map((n) => n.type), query: '', attentionOnly: false, pathOnly: false };
  const unique = [...new Set(all.types)];

  it('keeps every node when nothing is filtered', () => {
    const result = filterGraph(GRAPH, { ...all, types: unique }, null);
    expect(result.nodes).toHaveLength(NODES.length);
    expect(result.edges).toHaveLength(EDGES.length);
    expect(result.hiddenCount).toBe(0);
  });

  it('removes orphaned edges when their endpoint is filtered out', () => {
    const result = filterGraph(GRAPH, { ...all, types: ['fact'] }, null);
    expect(result.nodes.every((n) => n.type === 'fact')).toBe(true);
    // e2/e3/e4/e5 connect to non-fact nodes and must not survive
    expect(result.edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('matches the search text against label, summary and id', () => {
    expect(filterGraph(GRAPH, { ...all, types: unique, query: 'atlanta' }, null).nodes.map((n) => n.id)).toEqual([
      'DEC-OTHER',
    ]);
    expect(filterGraph(GRAPH, { ...all, types: unique, query: 'asm-res' }, null).nodes.map((n) => n.id)).toEqual([
      'ASM-RES',
    ]);
    expect(filterGraph(GRAPH, { ...all, types: unique, query: 'nothing here' }, null).nodes).toHaveLength(0);
  });

  it('keeps attention nodes plus their immediate neighbours', () => {
    const result = filterGraph(GRAPH, { ...all, types: unique, attentionOnly: true }, null);
    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain('FACT-NEW');
    expect(ids).toContain('ASM-RES');
    // PER-1 is only one hop from the affected decision, so it is kept as context
    expect(ids).toContain('PER-1');
    // SRC-1 is only adjacent to a contradicted fact, so it is kept too
    expect(ids).toContain('SRC-1');
  });

  it('returns nothing for a null graph instead of throwing', () => {
    expect(filterGraph(null, all, null)).toEqual({ nodes: [], edges: [], hiddenCount: 0 });
  });
});

describe('countByType', () => {
  it('counts nodes per type', () => {
    const counts = countByType(NODES);
    expect(counts.get('fact')).toBe(2);
    expect(counts.get('decision')).toBe(2);
    expect(counts.get('team')).toBeUndefined();
  });
});
