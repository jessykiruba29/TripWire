/**
 * Alerts & Review — the server-side alert feed with its persisted state, the
 * legal transitions the engine will accept, and review notes that survive a
 * same-status re-review.  Transitions are only ever offered when the backend
 * reports them in `allowed_transitions`.
 */

import type { ShellContext } from '../App';
import { Callout } from '../components/common';
import { AlertReviewPanel } from '../components/alerts/AlertReviewPanel';

export function AlertsPage({ ctx }: { ctx: ShellContext }) {
  const { tw } = ctx;

  return (
    <div className="stack stack--loose alerts-page">
      {tw.reviewNotice ? (
        <Callout
          tone={
            tw.reviewNotice.kind === 'changed' ? 'ok' : tw.reviewNotice.kind === 'noop' ? 'warning' : 'critical'
          }
          title={
            tw.reviewNotice.kind === 'changed'
              ? 'Review recorded by the backend'
              : tw.reviewNotice.kind === 'noop'
                ? 'No change was made'
                : 'Review not confirmed'
          }
        >
          {tw.reviewNotice.message}
        </Callout>
      ) : null}

      <AlertReviewPanel
        response={tw.alerts.data}
        loading={tw.alerts.loading}
        error={tw.alerts.error}
        onReview={(alertId, status, note) => {
          void tw.reviewAlert(alertId, status, note);
        }}
        busyAlertId={tw.reviewBusyAlertId}
        reviewError={tw.reviewError}
        onSelectDecision={ctx.explainDecision}
        onSelectEntity={ctx.inspectNode}
      />
    </div>
  );
}
