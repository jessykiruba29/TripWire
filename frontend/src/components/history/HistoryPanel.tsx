/**
 * HistoryPanel — the bi-temporal "what did Tripwire believe at time T" view.
 *
 * It receives an already-fetched `HistoryResponse` and renders it verbatim: the
 * recorded-time mode/as-of values, both time axes of every fact, the decisions
 * with their status-then vs status-now, and the recorded changes. It never
 * fabricates a fact, a change or a status.
 */

import type { HistoryFact, HistoryResponse } from '../../api/types';
import { describeBitemporal, formatDateTime, toDateInputValue } from '../../lib/format';
import { beliefMeta, decisionStatusMeta, nodeStateLabel, nodeStateTone } from '../../lib/vocabulary';
import {
  Badge,
  Button,
  Callout,
  Chip,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  PanelBody,
  PanelHead,
  Section,
} from '../common';
import './history.css';

const MISSING = 'Not available from the backend';

function humaniseKind(kind: string): string {
  return kind.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Shift a `YYYY-MM-DD` input value by whole days, staying a local date. */
function shiftDateInput(value: string, days: number): string {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return value;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function clampDate(value: string, min?: string, max?: string): string {
  if (min && value < min) return min;
  if (max && value > max) return max;
  return value;
}

function Axis({
  variant,
  label,
  from,
  to,
  openEndLabel,
}: {
  variant: 'world' | 'known';
  label: string;
  from: string | null;
  to: string | null;
  openEndLabel: string;
}) {
  return (
    <div className={`hist-axis hist-axis--${variant}`}>
      <span className="hist-axis__label">{label}</span>
      <span className="hist-axis__range">From {from ? formatDateTime(from) : MISSING}</span>
      <span className="hist-axis__range muted">To {to ? formatDateTime(to) : openEndLabel}</span>
    </div>
  );
}

function FactRow({ fact }: { fact: HistoryFact }) {
  const belief = beliefMeta(fact.belief);
  const bitemporal = describeBitemporal(fact.valid_from, fact.recorded_at);
  const heading = fact.label ?? fact.statement;

  return (
    <li className="list__item list__item--pad">
      <div className="hist-fact">
        <div className="row row--between row--wrap">
          <div className="row__grow">
            <p className="strong hist-fact__statement">
              {heading ? heading : `Statement ${MISSING.toLowerCase()}`}
            </p>
            {fact.label && fact.statement ? <p className="small muted">{fact.statement}</p> : null}
          </div>
          <div className="cluster">
            <Badge tone={belief.tone} title={belief.description}>
              {belief.label}
            </Badge>
            {fact.current_state ? (
              <Badge tone={nodeStateTone(fact.current_state)} title="Current state in the live graph">
                {nodeStateLabel(fact.current_state)}
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="hist-axes">
          <Axis
            variant="world"
            label="True in the world (valid time)"
            from={fact.valid_from}
            to={fact.valid_to}
            openEndLabel="No end recorded"
          />
          <Axis
            variant="known"
            label="Known to Tripwire (recorded time)"
            from={fact.recorded_at}
            to={fact.superseded_at}
            openEndLabel="Not superseded"
          />
        </div>

        {bitemporal ? <p className="hist-bitemporal tiny">{bitemporal}</p> : null}

        <div className="cluster">
          <Chip title={fact.id}>{fact.id}</Chip>
        </div>
      </div>
    </li>
  );
}

function EntityChip({ id, onSelectEntity }: { id: string; onSelectEntity?: (entityId: string) => void }) {
  if (!onSelectEntity) {
    return (
      <span className="chip mono" title={id}>
        {id}
      </span>
    );
  }
  return (
    <button type="button" className="chip chip--button mono" title={`Select entity ${id}`} onClick={() => onSelectEntity(id)}>
      {id}
    </button>
  );
}

export function HistoryPanel({
  history,
  asOf,
  onAsOfChange,
  minDate,
  maxDate,
  onSelectEntity,
  onResetToNow,
  loading,
  error,
}: {
  history: HistoryResponse | null;
  /** current `at` value as a YYYY-MM-DD date input value */
  asOf: string;
  onAsOfChange: (dateInput: string) => void;
  /** earliest and latest selectable dates, YYYY-MM-DD */
  minDate?: string;
  maxDate?: string;
  onSelectEntity?: (entityId: string) => void;
  onResetToNow?: () => void;
  loading?: boolean;
  error?: { message: string; code?: string; status?: number } | null;
}): JSX.Element {
  if (error) {
    return (
      <Panel>
        <PanelHead title="History" subtitle="Recorded-time view" />
        <PanelBody>
          <ErrorState title="Could not load history" error={error} />
        </PanelBody>
      </Panel>
    );
  }

  if (!history) {
    return (
      <Panel>
        <PanelHead title="History" subtitle="Recorded-time view" />
        <PanelBody>
          {loading ? (
            <LoadingState label="Loading history…" />
          ) : (
            <EmptyState title="No history loaded">
              <p>Pick a date to inspect what Tripwire believed at that recorded moment.</p>
            </EmptyState>
          )}
        </PanelBody>
      </Panel>
    );
  }

  // Derive quick-set dates from the caller's bounds and the recorded event time —
  // never hardcode a calendar date.
  const rawQuickSets: Array<{ key: string; label: string; value: string; hint: string }> = [];
  if (minDate) {
    rawQuickSets.push({ key: 'min', label: 'Earliest recorded', value: minDate, hint: `Earliest selectable date (${minDate}).` });
  }
  if (history.event_recorded_at) {
    const eventDay = toDateInputValue(history.event_recorded_at);
    if (eventDay) {
      rawQuickSets.push({
        key: 'pre',
        label: 'Before the event',
        value: clampDate(shiftDateInput(eventDay, -1), minDate, maxDate),
        hint: `The day before the event was recorded (${eventDay}).`,
      });
      rawQuickSets.push({
        key: 'event',
        label: 'From the event',
        value: clampDate(eventDay, minDate, maxDate),
        hint: `The day the event was recorded (${eventDay}).`,
      });
    }
  }
  if (maxDate) {
    rawQuickSets.push({ key: 'max', label: 'Latest recorded', value: maxDate, hint: `Latest selectable date (${maxDate}).` });
  }
  const seen = new Set<string>();
  const quickSets = rawQuickSets.filter((q) => {
    if (seen.has(q.value)) return false;
    seen.add(q.value);
    return true;
  });

  return (
    <Panel>
      <PanelHead
        title="History"
        subtitle="What Tripwire believed at a chosen recorded moment"
        actions={
          onResetToNow ? (
            <Button size="sm" onClick={onResetToNow}>
              Back to now
            </Button>
          ) : null
        }
      />
      <PanelBody>
        <div className="stack stack--loose">
          <div className="hist-toolbar">
            <div className="hist-date">
              <label className="hist-date__label" htmlFor="hist-asof">
                Show what Tripwire believed on
              </label>
              <input
                id="hist-asof"
                className="hist-date__input"
                type="date"
                value={asOf}
                min={minDate}
                max={maxDate}
                onChange={(e) => onAsOfChange(e.target.value)}
              />
            </div>
            <div className="cluster hist-quicksets">
              {quickSets.map((q) => (
                <button
                  key={q.key}
                  type="button"
                  className="chip chip--button"
                  aria-pressed={q.value === asOf}
                  title={q.hint}
                  onClick={() => onAsOfChange(q.value)}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>

          <Callout tone="info" title="This is a recorded-time view">
            <p>
              Tripwire is showing what it believed at that recorded moment. It is reconstructed from recorded times — when
              each fact was actually written down — rather than by re-stamping today&apos;s graph onto a past date.
            </p>
            <p className="tiny">
              mode: <span className="mono">{history.mode}</span> · as_of: <span className="mono">{history.as_of}</span>
            </p>
            {history.demo_clock || history.event_recorded_at ? (
              <p className="tiny">
                {history.demo_clock ? (
                  <>
                    Demo clock: <span className="mono">{history.demo_clock}</span>
                  </>
                ) : null}
                {history.demo_clock && history.event_recorded_at ? ' · ' : null}
                {history.event_recorded_at ? <>Event recorded at: {formatDateTime(history.event_recorded_at)}</> : null}
              </p>
            ) : null}
          </Callout>

          {history.notes && history.notes.length > 0 ? (
            <Callout tone="warning" title="Notes from the backend">
              <ul className="list list--tight">
                {history.notes.map((note, i) => (
                  <li key={i} className="small">
                    {note}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : null}

          {loading ? <LoadingState label="Refreshing history…" /> : null}

          <Section title="Facts as recorded">
            {history.facts.length === 0 ? (
              <p className="muted small">No facts were recorded at this moment.</p>
            ) : (
              <ul className="list list--divided">
                {history.facts.map((fact) => (
                  <FactRow key={fact.id} fact={fact} />
                ))}
              </ul>
            )}
          </Section>

          <Section title="Decisions at this time">
            {history.decisions.length === 0 ? (
              <p className="muted small">No decisions were recorded at this moment.</p>
            ) : (
              <ul className="list list--divided">
                {history.decisions.map((decision) => {
                  const then = decisionStatusMeta(decision.status_at_time);
                  const now = decisionStatusMeta(decision.status_now);
                  return (
                    <li key={decision.id} className="list__item list__item--pad">
                      <div className="stack stack--tight">
                        <div className="row row--between row--wrap">
                          <span className="strong">{decision.title}</span>
                          <Chip title={decision.id}>{decision.id}</Chip>
                        </div>
                        <div className="cluster hist-decision__status">
                          <span className="tiny muted">Then</span>
                          <Badge tone={then.tone} title={then.description}>
                            {then.label}
                          </Badge>
                          <span className="hist-arrow" aria-hidden="true">
                            →
                          </span>
                          <span className="tiny muted">Now</span>
                          <Badge tone={now.tone} title={now.description}>
                            {now.label}
                          </Badge>
                        </div>
                        {decision.review_state_now ? (
                          <p className="tiny muted">Review state now: {decision.review_state_now}</p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Recorded changes">
            {history.changes.length === 0 ? (
              <p className="muted small">No changes were recorded at this moment.</p>
            ) : (
              <ul className="list list--divided">
                {history.changes.map((change, i) => (
                  <li key={`${change.at}-${change.entity_id}-${i}`} className="list__item list__item--pad">
                    <div className="stack stack--tight">
                      <div className="cluster">
                        <span className="hist-change__at tiny mono" title={change.at}>
                          {formatDateTime(change.at)}
                        </span>
                        <Badge tone="neutral">{humaniseKind(change.kind)}</Badge>
                        <EntityChip id={change.entity_id} onSelectEntity={onSelectEntity} />
                      </div>
                      <p className="small">{change.summary}</p>
                      <p className="tiny muted">Actor: {change.actor ? change.actor : MISSING}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </PanelBody>
    </Panel>
  );
}
