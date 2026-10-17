/**
 * The company knowledge graph.
 *
 * Renders on canvas when the environment supports it. When it does not (jsdom in
 * tests, a browser with canvas disabled, a text-only context) the component
 * degrades to `GraphTextView` — a structured, keyboard-operable representation of
 * exactly the same nodes and relationships. The two views are interchangeable by
 * design, so the graph is never the only way to reach the information.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods, NodeObject } from 'react-force-graph-2d';
import type { GraphEdge, GraphNode } from '../../api/types';
import type { PathHighlight } from '../../lib/graph';
import { NODE_STATE_META, NODE_TYPE_META, edgeLabel, nodeTypeLabel } from '../../lib/vocabulary';
import { Badge, EmptyState } from '../common';
import { IconFit, IconZoomIn, IconZoomOut } from '../common/Icons';
import {
  drawNode,
  linkArrowLength,
  linkColor,
  linkCurvature,
  linkLineDash,
  linkWidth,
  traceShape,
  type DrawState,
  type FGLink,
  type FGNode,
} from './graphTheme';
import './graph.css';

export function isCanvasSupported(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext && canvas.getContext('2d'));
  } catch {
    return false;
  }
}

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  highlight: PathHighlight | null;
  dimUnrelated: boolean;
  showLabels?: boolean;
  onSelect: (id: string | null) => void;
}

export function GraphCanvas({
  nodes,
  edges,
  selectedId,
  highlight,
  dimUnrelated,
  showLabels = true,
  onSelect,
}: GraphCanvasProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods<FGNode, FGLink> | undefined>(undefined);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [hasSettled, setHasSettled] = useState(false);

  /* --------------------------------------------------------------- sizing */

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({
        width: Math.max(280, Math.round(rect.width)),
        height: Math.max(320, Math.round(rect.height || 520)),
      });
    };
    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* ----------------------------------------------------------- graph data */

  // Fresh copies every time: force-graph mutates node x/y/vx/vy and rewrites
  // link.source/target into object references. The API payload must stay pristine.
  const graphData = useMemo(
    () => ({
      nodes: nodes.map((node) => ({ ...node })) as FGNode[],
      links: edges.map((edge) => ({ ...edge })) as FGLink[],
    }),
    [nodes, edges],
  );

  const drawState: DrawState = useMemo(
    () => ({
      selectedId,
      hoveredId: hovered?.id ?? null,
      highlight,
      dimUnrelated,
      showLabels,
    }),
    [selectedId, hovered, highlight, dimUnrelated, showLabels],
  );

  /* ------------------------------------------------------------ painting */

  /*
   * WHY THESE DEPEND ON `drawState` — do not "optimise" them back to a ref.
   *
   * force-graph 1.52 runs a permanent requestAnimationFrame loop but skips the
   * actual paint unless one of these is true (see its `_animationCycle`):
   *
   *   doRedraw = !autoPauseRedraw || needsRedraw || engine.isEngineRunning() || photons
   *
   * `needsRedraw` is only ever set by a *styling prop change* reaching the inner
   * canvas graph (its `notifyRedraw` handler). A settled layout has
   * `isEngineRunning() === false` and no photons, so if our paint callbacks keep a
   * stable identity the loop declines to redraw and the canvas freezes on whatever
   * it painted last — selection rings and chain highlighting silently never appear.
   *
   * `resumeAnimation()` does NOT help: a frame is already scheduled, so it is a
   * no-op, and the loop still evaluates `doRedraw === false`.
   *
   * The fix is therefore to let each callback's identity change with the drawing
   * state, which makes the prop change and forces exactly one repaint per state
   * change — cheaper than disabling `autoPauseRedraw` (which would paint forever).
   */
  const nodeCanvasObject = useCallback(
    (node: NodeObject<FGNode>, ctx: CanvasRenderingContext2D, globalScale: number) => {
      drawNode(ctx, node as FGNode, globalScale, drawState);
    },
    [drawState],
  );

  const nodePointerAreaPaint = useCallback(
    (node: NodeObject<FGNode>, color: string, ctx: CanvasRenderingContext2D) => {
      const typed = node as FGNode;
      const radius = (NODE_TYPE_META[typed.type]?.size ?? 5) + 6;
      traceShape(ctx, typed.type, typed.x ?? 0, typed.y ?? 0, radius);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [],
  );

  const linkColorFn = useCallback((link: object) => linkColor(link as GraphEdge, drawState), [drawState]);
  const linkWidthFn = useCallback((link: object) => linkWidth(link as GraphEdge, drawState), [drawState]);
  const linkArrowFn = useCallback((link: object) => linkArrowLength(link as GraphEdge, drawState), [drawState]);
  const linkDashFn = useCallback((link: object) => linkLineDash(link as GraphEdge, drawState), [drawState]);
  const linkCurvatureFn = useCallback((link: object) => linkCurvature(link as GraphEdge), []);

  /* ------------------------------------------------------- simulation */

  /*
   * Open the layout up. The force defaults pack ~110 nodes into a dense ball, which
   * is what made the graph read as "congested": nodes overlapped, labels collided
   * and every link looked equally important. More charge and a longer link distance
   * buy the whitespace that makes clusters legible.
   */
  useEffect(() => {
    const charge = fgRef.current?.d3Force('charge') as { strength?: (value: number) => void } | undefined;
    charge?.strength?.(-340);
    const link = fgRef.current?.d3Force('link') as { distance?: (value: number) => void } | undefined;
    link?.distance?.(120);
    fgRef.current?.d3ReheatSimulation?.();
  }, []);

  /* ------------------------------------------------------- interactions */

  const handleFit = useCallback(() => {
    fgRef.current?.zoomToFit(420, 46);
  }, []);

  const handleZoom = useCallback((factor: number) => {
    const current = fgRef.current?.zoom?.() ?? 1;
    fgRef.current?.zoom?.(Math.min(12, Math.max(0.15, current * factor)), 220);
  }, []);

  const focusPath = useCallback(() => {
    if (!highlight || highlight.nodeIds.size === 0) return;
    fgRef.current?.zoomToFit(500, 70, (node) => highlight.nodeIds.has(String((node as FGNode).id)));
  }, [highlight]);

  const handleEngineStop = useCallback(() => {
    if (hasSettled) return;
    setHasSettled(true);
    /*
     * Deliberately NOT zoomToFit. Fitting every node is exactly why the graph
     * "kept zooming out": the first layout settle snapped the camera to the whole
     * graph (~115 nodes => tiny dots), and every remount of the page repeated it, so
     * any interaction appeared to be undone. Park the camera at a readable scale and
     * centre it; zoom from here on is only ever the user's explicit choice.
     */
    fgRef.current?.centerAt(0, 0, 500);
    fgRef.current?.zoom(1.05, 500);
  }, [hasSettled]);

  /*
   * Repainting is handled by the identity of the paint callbacks above (~50 lines
   * up) — there is deliberately no `resumeAnimation()` nudge here. An earlier
   * attempt used one and it could not work: force-graph always has a frame
   * scheduled, so `resumeAnimation()` is a no-op, and the frame it is already
   * scheduled for evaluates `doRedraw === false` once the layout is cold.
   *
   * The one thing that IS needed is a paint after a *fresh* data set has settled,
   * because the first frame of a new layout happens while the engine is still
   * running (so it paints), but the final settled frame needs the same prop-change
   * signal. `graphData` identity changes on every new payload, which drives that.
   */

  const tooltip = hovered
    ? `${nodeTypeLabel(hovered.type)} · ${hovered.label}${
        hovered.state !== 'normal' ? ` — ${NODE_STATE_META[hovered.state].label}` : ''
      }`
    : null;

  return (
    <div className="graph" ref={wrapRef} data-testid="graph-canvas">
      <ForceGraph2D<FGNode, FGLink>
        ref={fgRef}
        graphData={graphData}
        width={size.width}
        height={size.height}
        backgroundColor="#0a0f1e"
        nodeId="id"
        nodeCanvasObject={nodeCanvasObject}
        /*
         * Without an explicit nodeLabel, react-force-graph stringifies the whole
         * node object - that is where the "[object Object]" tooltip came from.
         */
        nodeLabel={(node: NodeObject<FGNode>) => {
          const typed = node as FGNode;
          return `${nodeTypeLabel(typed.type)} · ${typed.label}`;
        }}
        nodePointerAreaPaint={nodePointerAreaPaint}
        linkColor={linkColorFn}
        linkWidth={linkWidthFn}
        linkLineDash={linkDashFn}
        linkCurvature={linkCurvatureFn}
        linkDirectionalArrowLength={linkArrowFn}
        linkDirectionalArrowRelPos={0.92}
        linkDirectionalArrowColor={linkColorFn}
        linkLabel={(link: object) => {
          const edge = link as GraphEdge;
          return `${edge.source as unknown as string} —${edgeLabel(edge.type)}→ ${edge.target as unknown as string}`;
        }}
        /*
         * Click-to-focus: select the node AND fly the camera to it. The graph is a
         * map you navigate, not a picture you look at; Fit returns to the overview.
         */
        onNodeClick={(node: NodeObject<FGNode>) => {
          const target = node as unknown as FGNode & { x?: number; y?: number };
          onSelect(String(target.id));
          if (typeof target.x === 'number' && typeof target.y === 'number') {
            fgRef.current?.centerAt(target.x, target.y, 600);
            fgRef.current?.zoom(2.1, 600);
          }
        }}
        onNodeHover={(node: NodeObject<FGNode> | null) => setHovered(node ? (node as FGNode) : null)}
        onBackgroundClick={() => onSelect(null)}
        onEngineStop={handleEngineStop}
        cooldownTicks={140}
        warmupTicks={30}
        d3AlphaDecay={0.028}
        d3VelocityDecay={0.32}
        enableNodeDrag
        /*
         * Zoom is enabled. It was previously disabled to stop the view collapsing on
         * page scroll, but the real cause of that was the auto `zoomToFit` on engine
         * stop, which is now gone - so wheel/pinch zoom is safe and expected.
         */
        enableZoomInteraction
        enablePanInteraction
        aria-label={`Company knowledge graph with ${nodes.length} entities and ${edges.length} relationships. Use the text view for a full keyboard-readable list.`}
      />

      <div className="graph__overlay graph__overlay--top">
        {tooltip ? <span className="graph__tooltip">{tooltip}</span> : null}
      </div>

      <div className="graph__overlay graph__overlay--bottom">
        <div className="graph__controls" role="group" aria-label="Graph zoom controls">
          <button type="button" className="graph__control" onClick={() => handleZoom(1.4)} title="Zoom in" aria-label="Zoom in">
            <IconZoomIn size={14} />
          </button>
          <button type="button" className="graph__control" onClick={() => handleZoom(0.7)} title="Zoom out" aria-label="Zoom out">
            <IconZoomOut size={14} />
          </button>
          <button type="button" className="graph__control" onClick={handleFit} title="Fit graph to view" aria-label="Fit graph to view">
            <IconFit size={14} />
          </button>
          {highlight && highlight.nodeIds.size > 0 ? (
            <button type="button" className="graph__control graph__control--wide" onClick={focusPath}>
              Focus chain
            </button>
          ) : null}
        </div>
        <span className="graph__hint tiny faded">
          Click a node to inspect · drag to move · scroll to zoom
        </span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- text view */

export interface GraphTextViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  highlight: PathHighlight | null;
  onSelect: (id: string | null) => void;
  emptyTitle?: string;
}

/**
 * Structured, keyboard-navigable representation of the graph. Same data, no canvas.
 */
export function GraphTextView({
  nodes,
  edges,
  selectedId,
  highlight,
  onSelect,
  emptyTitle = 'No entities match the current filters',
}: GraphTextViewProps) {
  const grouped = useMemo(() => {
    const byType = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      const list = byType.get(node.type) ?? [];
      list.push(node);
      byType.set(node.type, list);
    }
    return [...byType.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [nodes]);

  const degree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of edges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    }
    return counts;
  }, [edges]);

  if (nodes.length === 0) {
    return <EmptyState title={emptyTitle}>Adjust the type filters or clear the search to see entities.</EmptyState>;
  }

  return (
    <div className="graph-text" data-testid="graph-text-view">
      <p className="tiny muted">
        Text view of the same graph: {nodes.length} entities and {edges.length} relationships currently displayed.
      </p>
      {grouped.map(([type, list]) => (
        <section key={type} className="graph-text__group">
          <h4 className="section__title">
            {nodeTypeLabel(type as GraphNode['type'])}
            <span className="muted"> · {list.length}</span>
          </h4>
          <ul className="list">
            {list
              .slice()
              .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
              .map((node) => {
                const onPath = highlight?.nodeIds.has(node.id) ?? false;
                const meta = NODE_STATE_META[node.state];
                return (
                  <li key={node.id} className="list__item">
                    <button
                      type="button"
                      className="graph-text__row"
                      aria-pressed={selectedId === node.id}
                      onClick={() => onSelect(node.id)}
                    >
                      <span className="graph-text__label">
                        {node.label}
                        {onPath ? <Badge tone="brand">On inspected chain</Badge> : null}
                      </span>
                      <span className="cluster">
                        {node.state !== 'normal' ? <Badge tone={meta.tone}>{meta.label}</Badge> : null}
                        <span className="tiny muted mono">{degree.get(node.id) ?? 0} links</span>
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}
