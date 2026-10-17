/**
 * Decision Explorer — every recorded decision with its status, and the full
 * structured explanation for the selected one: assumptions, the evidence chain
 * fact by fact, alternate evidence, and downstream impact.  The explanation is
 * the backend's `GET /api/decisions/{id}/explanation`, rendered verbatim.
 */

import type { ShellContext } from '../App';
import { DecisionPanel } from '../components/decisions/DecisionPanel';
import { ExplanationPanel } from '../components/explanation/ExplanationPanel';

export function DecisionsPage({ ctx }: { ctx: ShellContext }) {
  const { tw, nodeIndex } = ctx;

  return (
    <div className="app__grid app__grid--explorer">
      <div data-testid="decision-panel">
        <DecisionPanel
          decisions={tw.decisions.data?.decisions ?? tw.affectedDecisions}
          trigger={tw.lastTrigger}
          loading={tw.decisions.loading}
          error={tw.decisions.error}
          onRetry={tw.decisions.reload}
          selectedId={tw.selectedNodeId}
          onSelectDecision={(id) => tw.selectNode(id)}
          onExplain={ctx.explainDecision}
          explanationDecisionId={tw.explanation.data?.decision_id ?? null}
          graphRevision={tw.graph.data?.revision}
        />
      </div>

      <div data-testid="explanation-panel">
        <ExplanationPanel
          explanation={tw.explanation.data}
          loading={tw.explanation.loading}
          error={tw.explanation.error}
          onRetry={tw.explanation.reload}
          nodeIndex={nodeIndex}
          highlight={tw.highlight}
          onSelect={(id) => tw.selectNode(id)}
          onFocusChain={() => ctx.goto('/graph')}
          onOpenSource={ctx.openSource}
          idleHeadline={
            tw.lastTrigger ? 'Pick a decision to explain' : 'No decision is being explained yet'
          }
        />
      </div>
    </div>
  );
}
