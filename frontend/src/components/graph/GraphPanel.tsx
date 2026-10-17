/**
 * The graph panel: filters + canvas/list + legend.
 *
 * Filtering happens client-side on the payload the backend returned, so the panel
 * never invents entities and dimming is purely a presentation concern.
 */

import { useMemo, useState } from 'react';
import type { GraphResponse, NodeType } from '../../api/types';
import { filterGraph, countByType, affectedNodeIds, type PathHighlight } from '../../lib/graph';
import { NODE_TYPES } from '../../api/types';
import { Badge, Button, ErrorState, Panel, PanelBody, PanelFoot, PanelHead, SkeletonRows } from '../common';
import { IconNetwork, IconSearch } from '../common/Icons';
import { GraphCanvas, GraphTextView, isCanvasSupported } from './GraphCanvas';
import { GraphLegend } from './GraphLegend';
import './graph.css';

export interface GraphPanelProps {
  graph: GraphResponse | null;
  loading: boolean;
  error: { message: string; code?: string; status?: number; details?: Record<string, unknown> } | null;
  onRetry: () => void;
  selectedId: string | null;
  highlight: PathHighlight | null;
  onSelect: (id: string | null) => void;
  pathLabel?: string;
}

export function GraphPanel({
  graph,
  loading,
  error,
  onRetry,
  selectedId,
  highlight,
  onSelect,
  pathLabel,
}: GraphPanelProps) {
  const [types, setTypes] = useState<NodeType[]>(NODE_TYPES);
  const [query, setQuery] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [dimUnrelated, setDimUnrelated] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [textView, setTextView] = useState(false);

  const canvasAvailable = useMemo(() => isCanvasSupported(), []);

  const filtered = useMemo(
    () => filterGraph(graph, { types, query, attentionOnly, pathOnly: false }, highlight),
    [graph, types, query, attentionOnly, highlight],
  );

  const counts = useMemo(() => countByType(graph?.nodes ?? []), [graph]);
  const attention = useMemo(() => affectedNodeIds(graph?.nodes ?? []), [graph]);

  const toggleType = (type: NodeType) => {
    setTypes((current) =>
      current.includes(type)
        ? current.length === 1
          ? current
          : current.filter((t) => t !== type)
        : [...current, type],
    );
  };

  const usingTextView = textView || !canvasAvailable;

  const body = (() => {
    if (error && !graph) {
      return <ErrorState title="Could not load the knowledge graph" error={error} onRetry={onRetry} />;
    }
    if (loading && !graph) {
      return (
        <div className="stack">
          <div className="loading-row">
            <span className="spinner" />
            <span>Loading the company knowledge graph…</span>
          </div>
          <SkeletonRows rows={4} />
        </div>
      );
    }
    if (!graph) {
      return <ErrorState title="No graph data" error={{ message: 'The backend returned no graph payload.' }} onRetry={onRetry} />;
    }
    if (filtered.nodes.length === 0) {
      return (
        <div className="state">
          <IconNetwork className="state__icon" size={28} />
          <p className="state__title">Nothing matches the current filters</p>
          <p className="state__text">
            {attentionOnly
              ? 'No entity is currently flagged for attention with the selected types. Turn off “Needs attention only” to see the whole graph.'
              : 'No entity matches the search text with the selected types.'}
          </p>
          <Button
            size="sm"
            onClick={() => {
              setTypes(NODE_TYPES);
              setQuery('');
              setAttentionOnly(false);
            }}
          >
            Reset filters
          </Button>
        </div>
      );
    }
    if (usingTextView) {
      return (
        <GraphTextView
          nodes={filtered.nodes}
          edges={filtered.edges}
          selectedId={selectedId}
          highlight={highlight}
          onSelect={onSelect}
          emptyTitle="No entities to list"
        />
      );
    }
    return (
      <GraphCanvas
        nodes={filtered.nodes}
        edges={filtered.edges}
        selectedId={selectedId}
        highlight={highlight}
        dimUnrelated={dimUnrelated}
        showLabels={showLabels}
        onSelect={onSelect}
      />
    );
  })();

  return (
    <Panel className="graph-panel">
      <PanelHead
        icon={<IconNetwork size={17} />}
        title="Company knowledge graph"
        subtitle="Every entity, and the relationships that carry it."
        actions={
          <>
            {highlight && highlight.nodeIds.size > 0 ? (
              <Badge tone="brand" dot title={pathLabel}>
                Chain highlighted · {highlight.nodeIds.size} entities
              </Badge>
            ) : null}
            <Badge tone="neutral" outline title="Graph revision reported by the backend">
              rev {graph?.revision ?? '—'}
            </Badge>
          </>
        }
      />

      <PanelBody tight>
        <div className="stack stack--tight">
          <div className="graph-toolbar">
            <label className="graph-toolbar__search">
              <IconSearch size={13} />
              <span className="visually-hidden">Filter entities by name or summary</span>
              <input
                type="search"
                value={query}
                placeholder="Filter entities…"
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Filter entities by name or summary"
              />
            </label>

            <label className={`toggle ${attentionOnly ? 'toggle--active' : ''}`}>
              <input
                type="checkbox"
                checked={attentionOnly}
                onChange={(event) => setAttentionOnly(event.target.checked)}
              />
              Needs attention only
              {attention.size > 0 ? <span className="legend__count">{attention.size}</span> : null}
            </label>

            {!usingTextView ? (
              <>
                <label className={`toggle ${dimUnrelated ? 'toggle--active' : ''}`}>
                  <input
                    type="checkbox"
                    checked={dimUnrelated}
                    onChange={(event) => setDimUnrelated(event.target.checked)}
                    disabled={!highlight}
                  />
                  Dim unrelated
                </label>
                <label className={`toggle ${showLabels ? 'toggle--active' : ''}`}>
                  <input
                    type="checkbox"
                    checked={showLabels}
                    onChange={(event) => setShowLabels(event.target.checked)}
                  />
                  Labels
                </label>
              </>
            ) : null}

            {canvasAvailable ? (
              <Button size="sm" variant="ghost" onClick={() => setTextView((v) => !v)}>
                {textView ? 'Show graph' : 'Text view'}
              </Button>
            ) : (
              <span className="tiny muted" title="This environment has no 2D canvas, so the structured text view is used.">
                Canvas unavailable — showing the text view
              </span>
            )}
          </div>

          <div className={usingTextView ? undefined : 'graph-canvas-wrap'}>{body}</div>
        </div>
      </PanelBody>

      <PanelFoot>
        <GraphLegend counts={counts} activeTypes={types} onToggleType={toggleType} />
      </PanelFoot>

      <PanelFoot>
        <span data-testid="graph-counts">
          Showing <span className="mono">{filtered.nodes.length}</span> of{' '}
          <span className="mono">{graph?.stats.node_count ?? 0}</span> entities and{' '}
          <span className="mono">{filtered.edges.length}</span> of{' '}
          <span className="mono">{graph?.stats.edge_count ?? 0}</span> relationships
          {filtered.hiddenCount > 0 ? ' (filters applied)' : ''}.
        </span>
        {graph?.truncated ? (
          <Badge tone="warning">Backend truncated this graph — some entities are not shown</Badge>
        ) : null}
      </PanelFoot>
    </Panel>
  );
}
