/**
 * History & Activity — the bitemporal belief view ("what did the company
 * believe then") with an as-of control, plus the append-only event feed.
 */

import type { ShellContext } from '../App';
import { Panel } from '../components/common';
import { HistoryPanel } from '../components/history/HistoryPanel';
import { TimelineFeed } from '../components/history/TimelineFeed';

export function HistoryPage({ ctx }: { ctx: ShellContext }) {
  const { tw } = ctx;

  return (
    <div className="stack stack--loose history-page">
      <HistoryPanel
        history={tw.history.data}
        asOf={tw.asOf}
        onAsOfChange={tw.setAsOfDate}
        minDate={tw.historyBounds.minDate}
        maxDate={tw.historyBounds.maxDate}
        onSelectEntity={ctx.inspectNode}
        onResetToNow={tw.resetAsOf}
        loading={tw.history.loading}
        error={tw.history.error}
      />

      <Panel flush>
        <TimelineFeed
          entries={tw.timeline.data?.events ?? []}
          loading={tw.timeline.loading}
          error={tw.timeline.error}
          onSelectEntity={ctx.inspectNode}
          emptyTitle="No recorded activity"
          limit={60}
        />
      </Panel>
    </div>
  );
}
