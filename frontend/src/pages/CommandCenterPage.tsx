/**
 * Command Center — system status, emerging risks, high-impact changes and the
 * fastest routes into an investigation.  Every number here comes from a real
 * endpoint (`/api/health`, `/api/alerts`, the trigger result, the timeline).
 */

import { useMemo } from 'react';
import type { ShellContext } from '../App';
import { Badge, Callout, EmptyState, ErrorState, Panel, PanelBody, PanelHead, Stat } from '../components/common';
import { IconAlert, IconArrowRight, IconBolt, IconHistory, IconNetwork, IconTarget, IconUser } from '../components/common/Icons';
import { TimelineFeed } from '../components/history/TimelineFeed';
import { ALERT_STATUS_META, SEVERITY_META, decisionStatusMeta } from '../lib/vocabulary';
import { formatRelative } from '../lib/format';
import { Link } from '../router';

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export function CommandCenterPage({ ctx }: { ctx: ShellContext }) {
  const { tw } = ctx;
  const health = tw.health.data;
  const alerts = tw.alerts.data?.alerts ?? [];
  const flagged = useMemo(
    () => tw.affectedDecisions.filter((d) => d.status !== 'ACTIVE' || d.open_alert_count > 0),
    [tw.affectedDecisions],
  );

  const topAlerts = useMemo(
    () =>
      [...alerts]
        .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))
        .slice(0, 4),
    [alerts],
  );

  const impacts = tw.lastTrigger?.entity_impacts ?? [];

  return (
    <div className="cc">
      {/* ---------------------------------------------------------- status */}
      <section className="cc__stats" aria-label="System status">
        <Stat
          label="Backend"
          value={tw.isMock ? 'Mock engine' : 'Live'}
          tone={tw.isMock ? 'warning' : 'ok'}
          title={tw.connection?.reason}
        />
        <Stat
          label="Knowledge graph"
          value={`${health?.counts.nodes ?? '—'} entities`}
          tone="info"
          title="Nodes and relationships stored by the backend"
        />
        <Stat
          label="Open alerts"
          value={alerts.length}
          tone={alerts.length > 0 ? 'warning' : 'ok'}
        />
        <Stat
          label="Flagged decisions"
          value={flagged.length}
          tone={flagged.length > 0 ? 'warning' : 'ok'}
          title="Decisions with open alerts or a non-ACTIVE status"
        />
      </section>

      <div className="cc__grid">
        {/* ------------------------------------------------- emerging risk */}
        <Panel className="cc__panel">
          <PanelHead
            icon={<IconAlert size={17} />}
            title="Emerging risks"
            subtitle="Alerts raised by the backend, most severe first."
          />
          <PanelBody tight>
            {tw.alerts.error ? (
              <ErrorState title="Alert feed unavailable" error={tw.alerts.error} onRetry={tw.alerts.reload} />
            ) : topAlerts.length === 0 ? (
              <EmptyState title="No alerts">
                <p>
                  Nothing is flagged right now. Run a scenario in the Scenario Lab to see how a change propagates.
                </p>
              </EmptyState>
            ) : (
              <ul className="cc__list">
                {topAlerts.map((alert) => {
                  const sev = SEVERITY_META[alert.severity] ?? { label: alert.severity, tone: 'neutral' as const };
                  const status = ALERT_STATUS_META[alert.status];
                  return (
                    <li key={alert.id} className="cc__item">
                      <div className="cc__item-head">
                        <Badge tone={sev.tone}>{sev.label}</Badge>
                        <Badge tone={status?.tone ?? 'neutral'} outline>
                          {status?.label ?? alert.status}
                        </Badge>
                        <span className="tiny muted">{formatRelative(alert.created_at)}</span>
                      </div>
                      <Link to="/alerts" className="cc__item-title">
                        {alert.title}
                      </Link>
                      <p className="cc__item-text">{alert.what_changed}</p>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="cc__panel-foot">
              <Link to="/alerts" className="cc__link">
                Review alerts <IconArrowRight size={13} />
              </Link>
            </div>
          </PanelBody>
        </Panel>

        {/* ---------------------------------------------- decision risk */}
        <Panel className="cc__panel">
          <PanelHead
            icon={<IconTarget size={17} />}
            title="High-impact decisions"
            subtitle="Decisions with open alerts or a changed status, ranked by impact weight."
          />
          <PanelBody tight>
            {flagged.length === 0 ? (
              <EmptyState title="All decisions are quiet">
                <p>Every recorded decision is ACTIVE with no open alerts.</p>
              </EmptyState>
            ) : (
              <ul className="cc__list">
                {flagged.slice(0, 4).map((decision) => {
                  const meta = decisionStatusMeta(decision.status);
                  return (
                    <li key={decision.id} className="cc__item">
                      <div className="cc__item-head">
                        <Badge tone={meta.tone} outline>
                          {meta.label}
                        </Badge>
                        {decision.open_alert_count > 0 ? (
                          <Badge tone="warning">{decision.open_alert_count} open alert(s)</Badge>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="cc__item-title cc__item-title--button"
                        onClick={() => ctx.explainDecision(decision.id)}
                      >
                        {decision.title}
                      </button>
                      <p className="cc__item-text">
                        {meta.description}
                        {decision.impact_weight ? ` · impact weight ${decision.impact_weight}` : ''}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="cc__panel-foot">
              <Link to="/decisions" className="cc__link">
                Open Decision Explorer <IconArrowRight size={13} />
              </Link>
            </div>
          </PanelBody>
        </Panel>

        {/* ---------------------------------------------- latest change */}
        <Panel className="cc__panel">
          <PanelHead
            icon={<IconBolt size={17} />}
            title="Latest change propagation"
            subtitle="Straight from the backend's last trigger result — never recomputed in the browser."
          />
          <PanelBody tight>
            {!tw.lastTrigger ? (
              <EmptyState title="No scenario has been run yet">
                <p>Run the Frankfurt scenario to see a contradiction propagate into a decision flag and an alert.</p>
                <p>
                  <Link to="/scenarios" className="btn btn--primary">
                    <IconBolt size={14} /> Open Scenario Lab
                  </Link>
                </p>
              </EmptyState>
            ) : (
              <div className="stack stack--tight">
                <Callout tone="info" title="A change was recorded">
                  {tw.lastTrigger.event?.summary ?? 'The backend applied a new fact and recomputed impact.'}
                </Callout>
                {impacts.length > 0 ? (
                  <ul className="cc__list">
                    {impacts.slice(0, 5).map((impact) => (
                      <li key={impact.id} className="cc__item">
                        <div className="cc__item-head">
                          <Badge tone={impact.certainty === 'confirmed' ? 'critical' : 'warning'} outline>
                            {impact.certainty ?? impact.status}
                          </Badge>
                          {impact.requires_investigation ? <Badge tone="warning">investigate</Badge> : null}
                        </div>
                        <button
                          type="button"
                          className="cc__item-title cc__item-title--button"
                          onClick={() => ctx.explainDecision(impact.id)}
                        >
                          {impact.label}
                        </button>
                        {impact.reason ? <p className="cc__item-text">{impact.reason}</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="cc__panel-foot">
                  <Link to="/scenarios" className="cc__link">
                    Inspect the run <IconArrowRight size={13} />
                  </Link>
                  <Link to="/graph" className="cc__link">
                    See it on the graph <IconArrowRight size={13} />
                  </Link>
                </div>
              </div>
            )}
          </PanelBody>
        </Panel>

        {/* ---------------------------------------------- activity */}
        <Panel className="cc__panel">
          <PanelHead
            icon={<IconHistory size={17} />}
            title="Recent activity"
            subtitle="Append-only event history recorded by the backend."
          />
          <PanelBody tight>
            <TimelineFeed
              entries={(tw.timeline.data?.events ?? []).slice(0, 6)}
              loading={tw.timeline.loading}
              error={tw.timeline.error}
              onSelectEntity={ctx.inspectNode}
              emptyTitle="No recorded activity yet"
              limit={6}
            />
            <div className="cc__panel-foot">
              <Link to="/history" className="cc__link">
                Full history <IconArrowRight size={13} />
              </Link>
            </div>
          </PanelBody>
        </Panel>
      </div>

      {/* ------------------------------------------------- entry points */}
      <section className="cc__entries" aria-label="Investigation entry points">
        {[
          { to: '/graph', icon: IconNetwork, title: 'Knowledge Graph', text: 'Explore entities, relationships and downstream impact.' },
          { to: '/decisions', icon: IconTarget, title: 'Decision Explorer', text: 'Why a decision was made, and what it rests on.' },
          { to: '/evidence', icon: IconBolt, title: 'Evidence & Provenance', text: 'The source records behind every claim.' },
          { to: '/experts', icon: IconUser, title: 'Expert Intelligence', text: 'Who actually has the knowledge.' },
        ].map((entry) => (
          <Link key={entry.to} to={entry.to} className="cc__entry">
            <span className="cc__entry-icon" aria-hidden="true">
              <entry.icon size={18} />
            </span>
            <span className="cc__entry-body">
              <span className="cc__entry-title">{entry.title}</span>
              <span className="cc__entry-text">{entry.text}</span>
            </span>
            <IconArrowRight size={15} />
          </Link>
        ))}
      </section>

      {!tw.isMock ? (
        <Callout tone="info" title="Live backend">
          Every panel on this page is answered by the running backend. Nothing here is computed in the browser.
        </Callout>
      ) : null}
    </div>
  );
}
