/**
 * Knowledge Graph page — the hackathon's centrepiece.
 *
 * Composition: the constellation canvas takes the whole left side of the
 * screen, and the inspector is a STICKY column pinned beside it. Selecting a
 * node opens its full record on the right instantly — no scrolling down, the
 * incident story and the canvas are visible at the same time.
 */

import type { ShellContext } from '../App';
import { Panel, PanelBody, PanelHead } from '../components/common';
import { IconLink } from '../components/common/Icons';
import { GraphPanel } from '../components/graph/GraphPanel';
import { NodeInspector } from '../components/inspector/NodeInspector';

export function GraphPage({ ctx }: { ctx: ShellContext }) {
  const { tw } = ctx;

  const hasSelection = Boolean(tw.selectedNode);

  return (
    <div className="graph-page">
      <div className="graph-page__canvas" data-testid="graph-panel">
        <GraphPanel
          graph={tw.graph.data}
          loading={tw.graph.loading}
          error={tw.graph.error}
          onRetry={tw.graph.reload}
          selectedId={tw.selectedNodeId}
          highlight={tw.highlight}
          onSelect={(id) => tw.selectNode(id)}
          pathLabel={tw.pathLabel}
        />
      </div>

      <Panel className="graph-page__inspector">
        <PanelHead
          icon={<IconLink size={17} />}
          title={hasSelection ? 'Selected entity' : 'Inspector'}
        />
        <PanelBody>
          <NodeInspector
            node={tw.selectedNode}
            graph={tw.graph.data}
            highlight={tw.highlight}
            pathLabel={tw.pathLabel}
            onSelect={(id) => tw.selectNode(id)}
            onOpenSource={ctx.openSource}
            factDetail={tw.factDetail.data}
            decisionDetail={tw.decisionDetail.data}
            personDetail={tw.personDetail.data}
            loadingDetail={
              tw.factDetail.loading || tw.decisionDetail.loading || tw.personDetail.loading
            }
            onShowExplanation={ctx.explainDecision}
            onShowProvenance={() => ctx.goto('/evidence')}
          />
        </PanelBody>
      </Panel>

      <div className="graph-page__note">
        Click any node to open its full record here on the right. Explained chains stay highlighted
        on the canvas; the legend below doubles as the type filter.
      </div>
    </div>
  );
}