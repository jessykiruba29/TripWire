/**
 * Demo driver.
 *
 * Two jobs:
 *  1. Explain what Tripwire is, in one paragraph, without marketing language.
 *  2. Let the operator run the Frankfurt scenario honestly — the event goes
 *     through the backend, and nothing is shown as applied until it returns.
 *
 * The stepper marks which of the seven explanatory steps the backend can actually
 * support right now, and each step jumps to the panel that proves it.
 *
 * Narrative rule (verified against the live engine): the EU launch is
 * POTENTIALLY_STALE, not confirmed stale, because an independent SOC 2 attestation
 * still supports the data-residency assumption. The copy here must never imply the
 * engine concluded the decision is wrong.
 */

import { useEffect, useMemo, useState } from 'react';
import type { DemoState, TriggerEventResponse } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { Badge, Button, Callout, Chip, Panel, PanelBody, PanelFoot, PanelHead, Section, Stat } from '../common';
import { IconBolt, IconCheck, IconInfo, IconRefresh } from '../common/Icons';
import './demo.css';

export type StoryStepId =
  | 'event'
  | 'contradiction'
  | 'propagation'
  | 'path'
  | 'review'
  | 'expert'
  | 'history';

interface StepDefinition {
  id: StoryStepId;
  index: number;
  title: string;
  detail: string;
  action: string;
}

const STEPS: StepDefinition[] = [
  {
    id: 'event',
    index: 1,
    title: 'The new event and its source',
    detail: 'A message enters the company brain and becomes a recorded fact with a verbatim source.',
    action: 'Open the source message',
  },
  {
    id: 'contradiction',
    index: 2,
    title: 'The contradiction with the earlier fact',
    detail:
      'The engine checks the new claim against what the graph already believed, and finds a conflict. Both facts are kept.',
    action: 'Inspect the earlier fact',
  },
  {
    id: 'propagation',
    index: 3,
    title: 'Affected assumptions and decisions',
    detail:
      'The conflict travels along the assumptions decisions actually depend on. The engine returns certainty, depth and a reason for every entity it evaluated.',
    action: 'See the impact list',
  },
  {
    id: 'path',
    index: 4,
    title: 'The exact evidence path',
    detail: 'Every hop is named, with the relationship between each pair of entities.',
    action: 'Highlight the chain in the graph',
  },
  {
    id: 'review',
    index: 5,
    title: 'Why it needs review — and what it does not claim',
    detail:
      'Potential impact is a request for a human, not a verdict. Where independent evidence still supports an assumption, the engine says so instead of escalating.',
    action: 'Read the reasoning',
  },
  {
    id: 'expert',
    index: 6,
    title: 'Who really knows the affected system',
    detail:
      'Ranked on recorded contributions — not on who appears most often, and not on the org chart. The listed owner is shown separately for contrast.',
    action: 'See who has done the work',
  },
  {
    id: 'history',
    index: 7,
    title: 'What the company believed, and when',
    detail:
      'Real-world validity (valid_from/valid_to) is kept apart from recorded time (recorded_at/recorded_to). A scheduled expiry is not a contradiction.',
    action: 'Step back in time',
  },
];

export interface ScenarioPanelProps {
  demoState: DemoState | null;
  trigger: TriggerEventResponse | null;
  triggerBusy: boolean;
  triggerError: { message: string; code?: string; status?: number; details?: Record<string, unknown> } | null;
  resetBusy: boolean;
  resetError: { message: string; code?: string; status?: number } | null;
  onTrigger: (input: { scenario?: string; text?: string }) => void;
  onReset: () => void;
  onStep: (step: StoryStepId) => void;
  expertAvailable: boolean;
  historyAvailable: boolean;

  /* mode-aware controls */
  isReal: boolean;
  scenarioTrigger: boolean;
  scenarios: Array<{ id: string; description?: string }>;
  scenario: string | null;
  onScenarioChange: (id: string) => void;
}

export function ScenarioPanel({
  demoState,
  trigger,
  triggerBusy,
  triggerError,
  resetBusy,
  resetError,
  onTrigger,
  onReset,
  onStep,
  expertAvailable,
  historyAvailable,
  isReal,
  scenarioTrigger,
  scenarios,
  scenario,
  onScenarioChange,
}: ScenarioPanelProps) {
  const suggested = demoState?.storyline.trigger_text ?? '';
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!touched && suggested) setText(suggested);
  }, [suggested, touched]);

  // Default to the Frankfurt scenario once the backend's list arrives, so the
  // primary action is never dead on first load.
  useEffect(() => {
    if (!scenarioTrigger || scenario || scenarios.length === 0) return;
    const preferred =
      scenarios.find((item) => item.id.includes('frankfurt')) ?? scenarios[0];
    if (preferred) onScenarioChange(preferred.id);
  }, [scenarioTrigger, scenario, scenarios, onScenarioChange]);

  const applied = Boolean(trigger);
  const phase = demoState?.phase ?? 'baseline';

  const availability: Record<StoryStepId, boolean> = {
    event: Boolean(trigger?.event),
    contradiction: Boolean(trigger?.extraction?.contradicted_fact?.id),
    propagation: Boolean(trigger && (trigger.entity_impacts?.length ?? trigger.propagation.decisions.length) > 0),
    path: Boolean(trigger?.path?.nodes?.length),
    review: Boolean(trigger?.explanation?.headline),
    expert: expertAvailable,
    history: historyAvailable,
  };

  /** The engine's own summary: confirmed vs potential, and what it left alone. */
  const audit = trigger?.audit;
  const flagged = useMemo(
    () => (trigger?.entity_impacts ?? []).filter((impact) => impact.requires_investigation),
    [trigger],
  );
  const leftAlone = useMemo(
    () => (trigger?.entity_impacts ?? []).filter((impact) => !impact.requires_investigation),
    [trigger],
  );

  return (
    <Panel>
      <PanelHead
        icon={<IconBolt size={17} />}
        title="Tripwire remembers the assumptions behind company decisions"
        subtitle="Introduce a new fact. Tripwire shows what changed, which assumptions and decisions it puts at risk, why they are connected, which sources say so, who has done the work on the affected system, and whether the decision needs review — or whether independent evidence means it does not."
        actions={
          <>
            <Badge tone={phase === 'event_applied' ? 'warning' : 'ok'} dot>
              {phase === 'event_applied' ? 'Event applied' : 'Baseline'}
            </Badge>
            {demoState ? (
              <Badge tone="neutral" outline title="Node count reported by the backend">
                {demoState.counts.nodes} nodes
              </Badge>
            ) : null}
          </>
        }
      />

      <PanelBody>
        <div className="stack stack--loose">
          <div className="grid-3">
            <Stat
              label="Open alerts"
              value={demoState?.counts.alerts_open ?? 0}
              tone={(demoState?.counts.alerts_open ?? 0) > 0 ? 'critical' : undefined}
            />
            <Stat
              label="Decisions needing review"
              value={demoState?.counts.decisions_needing_review ?? 0}
              tone={(demoState?.counts.decisions_needing_review ?? 0) > 0 ? 'warning' : undefined}
            />
            <Stat label="Entities" value={demoState?.counts.nodes ?? 0} />
            <Stat label="Relationships" value={demoState?.counts.edges ?? 0} />
          </div>

          {/* ------------------------------------------------------- controls */}

          <Section title="Introduce the event">
            <div className="demo__form">
              {scenarioTrigger ? (
                <label className="demo__field">
                  <span className="tiny muted">Scenario</span>
                  <select
                    value={scenario ?? ''}
                    onChange={(event) => onScenarioChange(event.target.value)}
                    aria-label="Demo scenario"
                  >
                    <option value="">Choose a scenario…</option>
                    {scenarios.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                  {scenarios.find((item) => item.id === scenario)?.description ? (
                    <span className="tiny muted">
                      {scenarios.find((item) => item.id === scenario)?.description}
                    </span>
                  ) : null}
                </label>
              ) : null}

              <label className="demo__field">
                <span className="tiny muted">
                  {scenarioTrigger ? 'Event text (for the record — the backend uses the scenario id)' : 'What happened'}
                </span>
                <textarea
                  rows={3}
                  value={text}
                  onChange={(event) => {
                    setTouched(true);
                    setText(event.target.value);
                  }}
                  placeholder="Describe the change in plain language…"
                  aria-label="Event text"
                />
              </label>

              <div className="demo__form-row">
                <div className="demo__buttons">
                  <Button
                    variant="primary"
                    busy={triggerBusy}
                    disabled={scenarioTrigger ? !scenario : text.trim().length === 0}
                    onClick={() =>
                      onTrigger({
                        scenario: scenario ?? undefined,
                        text: text.trim() || undefined,
                      })
                    }
                  >
                    <IconBolt size={14} />
                    {applied ? 'Re-run scenario' : 'Run Frankfurt scenario'}
                  </Button>
                  <Button busy={resetBusy} onClick={onReset}>
                    <IconRefresh size={14} />
                    Reset demo
                  </Button>
                  {touched && suggested && text !== suggested ? (
                    <Button size="sm" variant="ghost" onClick={() => setText(suggested)}>
                      Use scenario text
                    </Button>
                  ) : null}
                </div>
              </div>

              {scenarioTrigger && !scenario ? (
                <p className="tiny muted">
                  Pick a scenario id. The backend triggers demo events by id, not by free text — each id is a
                  deterministic, repeatable event.
                </p>
              ) : null}

              {triggerError ? (
                <Callout tone="critical" title="The event was not applied">
                  <p>{triggerError.message}</p>
                  {triggerError.code === 'scenario_required' ? (
                    <p className="tiny">
                      The backend did not receive a scenario id, so nothing was written to the graph.
                    </p>
                  ) : null}
                  {triggerError.code === 'validation_error' ? (
                    <p className="tiny">
                      The backend rejected the payload — nothing was written to the graph.
                    </p>
                  ) : null}
                  {triggerError.details && Object.keys(triggerError.details).length > 0 ? (
                    <pre className="state__detail">{JSON.stringify(triggerError.details, null, 2)}</pre>
                  ) : null}
                </Callout>
              ) : null}

              {resetError ? (
                <Callout tone="critical" title="Reset failed">
                  <p>{resetError.message}</p>
                </Callout>
              ) : null}
            </div>
          </Section>

          {/* ------------------------------------------------------ storyline */}

          <Section title={applied ? 'What just happened — step through it' : 'What the demonstration shows'}>
            {applied && trigger ? (
              <div className="demo__summary">
                <div className="cluster">
                  <Chip title="Scenario">{trigger.event.type}</Chip>
                  {trigger.event.occurred_at ? (
                    <span className="tiny muted">Recorded {formatDateTime(trigger.event.recorded_at)}</span>
                  ) : null}
                  {trigger.already_applied ? (
                    <Badge tone="neutral" title="The backend recognised this event as already applied.">
                      Already applied — no state changed
                    </Badge>
                  ) : null}
                  {audit ? (
                    <Badge tone="neutral" outline title="The engine ran without an LLM in this environment.">
                      {audit.llm_used ? 'LLM-assisted' : 'Deterministic rules'}
                    </Badge>
                  ) : null}
                </div>
                <p className="small quote">{trigger.event.raw_text}</p>

                {audit?.counts ? (
                  <p className="tiny muted">
                    The engine evaluated {audit.counts.affected_total} entities and flagged{' '}
                    <strong>{flagged.length}</strong>. {audit.counts.confirmed} are{' '}
                    <strong>confirmed</strong>, {audit.counts.potential} are{' '}
                    <strong>potential only</strong> — a potential impact requests a review, it does not conclude the
                    decision is wrong.
                  </p>
                ) : null}

                {leftAlone.length > 0 ? (
                  <p className="tiny muted">
                    {leftAlone.length} evaluated {leftAlone.length === 1 ? 'entity was' : 'entities were'} deliberately
                    left without a warning.
                  </p>
                ) : null}
              </div>
            ) : null}

            {trigger?.propagation.not_affected.length ? (
              <Callout tone="ok" title="Tripwire did not overreact">
                {trigger.propagation.not_affected.length} active decisions were not reachable from the changed fact, so
                they were left alone and are still listed as unaffected. Avoiding a false alarm is as much the point as
                catching a real one.
              </Callout>
            ) : null}

            <ol className="demo__steps">
              {STEPS.map((step) => {
                const ready = availability[step.id];
                return (
                  <li key={step.id} className={`demo__step ${ready ? 'demo__step--ready' : ''}`}>
                    <span className="demo__step-index" aria-hidden="true">
                      {ready ? <IconCheck size={12} /> : step.index}
                    </span>
                    <div className="demo__step-body">
                      <span className="demo__step-title">
                        {step.title}
                        {ready ? <span className="visually-hidden"> — available</span> : null}
                      </span>
                      <span className="tiny muted">{step.detail}</span>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => onStep(step.id)} disabled={!ready}>
                      {ready ? step.action : 'Run the scenario first'}
                    </Button>
                  </li>
                );
              })}
            </ol>
          </Section>
        </div>
      </PanelBody>

      <PanelFoot>
        <IconInfo size={12} />
        <span>
          {isReal ? (
            <>
              The event is sent to <span className="mono">POST /api/demo/trigger-event</span> as{' '}
              <span className="mono">{'{ scenario: "…" }'}</span>. Nothing is shown as applied until the backend
              confirms it, and entities the engine left unflagged stay visible.
            </>
          ) : (
            <>
              Mock mode is active: this event runs through the in-browser reference engine, not the real backend. Every
              record is simulated.
            </>
          )}
        </span>
      </PanelFoot>
    </Panel>
  );
}
