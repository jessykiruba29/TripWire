/**
 * Scenario Lab — run the deterministic demo event (or a custom claim), inspect
 * the backend's own propagation answer and jump into the graph, evidence or
 * review pages for each step.  Nothing here recomputes impact: the tables are
 * the trigger response verbatim.
 */

import type { ShellContext } from '../App';
import { Badge, Callout, EmptyState, Panel, PanelBody, PanelHead } from '../components/common';
import { IconArrowRight, IconBolt } from '../components/common/Icons';
import { ScenarioPanel } from '../components/demo/ScenarioPanel';
import { IMPACT_META } from '../lib/vocabulary';
import { Link } from '../router';

export type { StoryStepId } from '../components/demo/ScenarioPanel';

export function ScenarioLabPage({ ctx }: { ctx: ShellContext }) {
  const { tw } = ctx;
  const trigger = tw.lastTrigger;
  const impacts = trigger?.entity_impacts ?? trigger?.propagation.decisions ?? [];
  const audit = trigger?.audit;

  return (
    <div className="scenario-page">
      <div data-testid="scenario-panel">
        <ScenarioPanel
          demoState={tw.demoState.data}
          trigger={trigger}
          triggerBusy={tw.triggerBusy}
          triggerError={tw.triggerError}
          resetBusy={tw.resetBusy}
          resetError={tw.resetError}
          onTrigger={(input) => {
            void tw.triggerDemo(input);
          }}
          onReset={() => {
            void tw.resetDemo();
          }}
          onStep={ctx.onStep}
          expertAvailable={Boolean(tw.experts.data && tw.experts.data.experts.length > 0)}
          historyAvailable={Boolean(tw.history.data)}
          isReal={tw.isReal}
          scenarioTrigger={Boolean(tw.capabilities?.scenarioTrigger)}
          scenarios={tw.demoScenarios.data ?? []}
          scenario={tw.scenario}
          onScenarioChange={tw.setScenario}
        />
      </div>

      {trigger ? (
        <Panel>
          <PanelHead
            icon={<IconBolt size={17} />}
            title="Propagation result (backend's answer)"
            subtitle="One row per entity the engine evaluated — including entities it deliberately did not flag."
          />
          <PanelBody tight>
            {audit?.counts ? (
              <div className="scenario-page__counts">
                <Badge tone="info">
                  {audit.counts.confirmed} confirmed
                </Badge>
                <Badge tone="warning">{audit.counts.potential} potential</Badge>
                <Badge tone="neutral">
                  {audit.counts.affected_total} entities evaluated
                </Badge>
                <Badge tone="neutral">depth ≤ {audit.max_depth}</Badge>
              </div>
            ) : null}

            <ul className="cc__list">
              {impacts.map((impact) => {
                const meta = IMPACT_META[impact.impact as keyof typeof IMPACT_META];
                return (
                  <li key={impact.id} className="cc__item">
                    <div className="cc__item-head">
                      {meta ? (
                        <Badge tone={meta.tone} outline>
                          {meta.label}
                        </Badge>
                      ) : null}
                      <Badge
                        tone={
                          impact.certainty === 'confirmed' || impact.status === 'confirmed_stale'
                            ? 'critical'
                            : 'warning'
                        }
                      >
                        {impact.certainty ?? impact.status}
                      </Badge>
                      {impact.requires_investigation ? (
                        <Badge tone="warning">requires investigation</Badge>
                      ) : (
                        <Badge tone="ok">no action needed</Badge>
                      )}
                    </div>
                    <button
                      type="button"
                      className="cc__item-title cc__item-title--button"
                      onClick={() => ctx.explainDecision(impact.id)}
                    >
                      {impact.label}
                    </button>
                    <p className="cc__item-text">{impact.reason}</p>
                    <div className="cc__item-links">
                      <button type="button" className="cc__link" onClick={() => ctx.inspectNode(impact.id)}>
                        Inspect on graph <IconArrowRight size={12} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>

            {impacts.length === 0 ? (
              <EmptyState title="The last run changed no entity state">
                <p>The backend applied the event but nothing crossed a propagation threshold.</p>
              </EmptyState>
            ) : null}

            {trigger.uncertainty?.length ? (
              <Callout tone="warning" title="Uncertainty the engine refused to resolve">
                <ul>
                  {trigger.uncertainty.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}

            <div className="cc__panel-foot">
              <Link to="/graph" className="cc__link">
                Explore on the graph <IconArrowRight size={13} />
              </Link>
              <Link to="/evidence" className="cc__link">
                Compare the evidence <IconArrowRight size={13} />
              </Link>
              <Link to="/alerts" className="cc__link">
                Review the alerts <IconArrowRight size={13} />
              </Link>
            </div>
          </PanelBody>
        </Panel>
      ) : (
        <EmptyState title="No run yet">
          <p>Run a scenario above; the backend's propagation answer appears here verbatim.</p>
        </EmptyState>
      )}
    </div>
  );
}
