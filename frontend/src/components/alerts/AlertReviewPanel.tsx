/**
 * AlertReviewPanel — the human review workflow for alerts.
 *
 * This component is presentational and never optimistic: it collects a note and a
 * target status, hands both to `onReview`, and displays no new status of its own.
 * The parent performs the POST and feeds back `busyAlertId` / `reviewError`; the UI
 * only ever claims a change once the backend has confirmed it.
 */

import type { ReactNode } from 'react';
import { useState } from 'react';
import type { Alert, AlertStatus, AlertsResponse } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { REVIEW_ACTIONS, SEVERITY_META, alertStatusMeta, type Tone } from '../../lib/vocabulary';
import {
  Badge,
  Button,
  Callout,
  Chip,
  EmptyState,
  ErrorState,
  LoadingState,
  Meter,
  Panel,
  PanelBody,
  PanelHead,
  Section,
  SkeletonRows,
} from '../common';
import './alerts.css';

const MISSING = 'Not available from the backend';

interface ReviewOption {
  status: AlertStatus;
  label: string;
  tone: Tone;
  hint: string;
}

/**
 * Allowed targets come from the backend when it advertises `allowed_transitions`
 * for the alert's current status; otherwise fall back to the shared REVIEW_ACTIONS.
 * A transition to the current status is always filtered out (it would be a no-op).
 */
function optionFor(status: AlertStatus): ReviewOption {
  // Prefer the shared review wording so both paths read identically; fall back to
  // the status vocabulary for any status the review actions do not cover.
  const action = REVIEW_ACTIONS.find((candidate) => candidate.status === status);
  if (action) return { status, label: action.label, tone: action.tone, hint: action.hint };
  const meta = alertStatusMeta(status);
  return { status, label: meta.label, tone: meta.tone, hint: meta.description };
}

function allowedTransitions(alert: Alert, allowed?: Partial<Record<AlertStatus, AlertStatus[]>>): ReviewOption[] {
  const fromBackend = allowed?.[alert.status];
  if (fromBackend && fromBackend.length > 0) {
    return fromBackend.filter((status) => status !== alert.status).map(optionFor);
  }
  return REVIEW_ACTIONS.filter((action) => action.status !== alert.status);
}

function buttonVariant(tone: Tone): 'default' | 'primary' | 'danger' {
  if (tone === 'critical') return 'danger';
  if (tone === 'ok') return 'primary';
  return 'default';
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

function IdGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="alerts-ids__group">
      <span className="alerts-ids__label">{label}</span>
      {children}
    </div>
  );
}

function AlertCard({
  alert,
  note,
  onNoteChange,
  onRequest,
  isBusy,
  busyStatus,
  transitions,
  reviewError,
  onSelectDecision,
  onSelectEntity,
}: {
  alert: Alert;
  note: string;
  onNoteChange: (value: string) => void;
  onRequest: (status: AlertStatus) => void;
  isBusy: boolean;
  busyStatus: AlertStatus | null;
  transitions: ReviewOption[];
  reviewError: { message: string; code?: string; status?: number } | null;
  onSelectDecision?: (decisionId: string) => void;
  onSelectEntity?: (entityId: string) => void;
}) {
  const statusMeta = alertStatusMeta(alert.status);
  const severity = SEVERITY_META[alert.severity];
  const noteId = `alert-note-${alert.id}`;

  return (
    <li className="list__item">
      <article className="alerts-item" aria-label={alert.title}>
        <div className="cluster">
          <Badge tone={severity.tone} title={`Severity: ${severity.label}`}>
            {severity.label}
          </Badge>
          <Badge tone={statusMeta.tone} title={statusMeta.description}>
            {statusMeta.label}
          </Badge>
           <Badge tone={alert.requires_investigation ? 'warning' : 'neutral'}>
             {alert.requires_investigation ? 'Requires investigation' : 'No investigation required'}
           </Badge>
           <Chip title="Alert id">{alert.id}</Chip>
         </div>

        <div className="stack stack--tight">
          <h3 className="alerts-item__title">{alert.title}</h3>
          <blockquote className="quote alerts-quote">{alert.what_changed}</blockquote>
          <p className="small">{alert.why}</p>
        </div>

        <div className="row row--between row--wrap">
          <span className="tiny muted">Confidence</span>
          {alert.confidence === null ? (
            <span className="tiny muted">Confidence {MISSING.toLowerCase()}</span>
          ) : (
            <Meter value={alert.confidence} label="Alert confidence" />
          )}
        </div>

        <div className="alerts-ids">
          {alert.contradicted_fact_id ? (
            <IdGroup label="Contradicted fact">
              <EntityChip id={alert.contradicted_fact_id} onSelectEntity={onSelectEntity} />
            </IdGroup>
          ) : null}
          {alert.new_fact_id ? (
            <IdGroup label="New fact">
              <EntityChip id={alert.new_fact_id} onSelectEntity={onSelectEntity} />
            </IdGroup>
          ) : null}
          {alert.assumption_ids.length > 0 ? (
            <IdGroup label="Assumptions">
              {alert.assumption_ids.map((id) => (
                <Chip key={id} title={id}>
                  {id}
                </Chip>
              ))}
            </IdGroup>
          ) : null}
          {alert.decision_ids.length > 0 ? (
            <IdGroup label="Decisions">
              {alert.decision_ids.map((id) =>
                onSelectDecision ? (
                  <button
                    key={id}
                    type="button"
                    className="chip chip--button mono"
                    title={`Open decision ${id}`}
                    onClick={() => onSelectDecision(id)}
                  >
                    {id}
                  </button>
                ) : (
                  <Chip key={id} title={id}>
                    {id}
                  </Chip>
                ),
              )}
            </IdGroup>
          ) : null}
          {alert.project_ids.length > 0 ? (
            <IdGroup label="Projects">
              {alert.project_ids.map((id) => (
                <EntityChip key={id} id={id} onSelectEntity={onSelectEntity} />
              ))}
            </IdGroup>
          ) : null}
          {alert.source_ids.length > 0 ? (
            <IdGroup label="Sources">
              {alert.source_ids.map((id) => (
                <Chip key={id} title={id}>
                  {id}
                </Chip>
              ))}
            </IdGroup>
          ) : null}
        </div>

        <p className="tiny muted">
          Opened {formatDateTime(alert.created_at)} · Updated {formatDateTime(alert.updated_at)}
        </p>

        <Section title="Review audit trail">
          {alert.history.length === 0 ? (
            <p className="tiny muted">No status transitions have been recorded by the backend.</p>
          ) : (
            <ul className="list alerts-audit">
              {alert.history.map((entry, i) => (
                <li key={`${entry.at}-${i}`} className="alerts-audit__item">
                  <div className="cluster">
                    {entry.from ? (
                      <span className="tiny">{alertStatusMeta(entry.from).label}</span>
                    ) : (
                      <span className="tiny muted">No previous status</span>
                    )}
                    <span className="alerts-arrow" aria-hidden="true">
                      →
                    </span>
                    <span className="tiny strong">{alertStatusMeta(entry.to).label}</span>
                  </div>
                  <p className="tiny muted">
                    {entry.actor ? entry.actor : MISSING} · <span title={entry.at}>{formatDateTime(entry.at)}</span>
                  </p>
                  {entry.note ? <p className="small alerts-audit__note">{entry.note}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {alert.people && alert.people.length > 0 ? (
          <Section title="People">
            <ul className="list alerts-people">
              {alert.people.map((person) => (
                <li key={person.id} className="alerts-person">
                  <div className="alerts-person__head">
                    <span className="strong">{person.name}</span>
                    <span className="tiny muted">
                      {person.role}
                      {person.team_name ? ` · ${person.team_name}` : ''}
                    </span>
                    {person.is_official_owner ? <Badge tone="brand">Official owner</Badge> : null}
                  </div>
                  <p className="tiny">{person.reason}</p>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <div className="alerts-controls">
          <div className="alerts-note">
            <label className="alerts-note__label" htmlFor={noteId}>
              Review note
            </label>
            <textarea
              id={noteId}
              className="alerts-note__input"
              rows={2}
              value={note}
              disabled={isBusy}
              placeholder="Explain the decision for the audit trail."
              onChange={(e) => onNoteChange(e.target.value)}
            />
          </div>

          {reviewError ? (
            <Callout tone="critical" title="Review failed">
              <p>{reviewError.message}</p>
              {reviewError.code || reviewError.status ? (
                <p className="tiny mono">
                  {[reviewError.status ? `HTTP ${reviewError.status}` : null, reviewError.code ? `code: ${reviewError.code}` : null]
                    .filter(Boolean)
                    .join('  ·  ')}
                </p>
              ) : null}
            </Callout>
          ) : null}

          {transitions.length === 0 ? (
            <p className="tiny muted">The backend offers no review transitions from this status.</p>
          ) : (
            <div className="alerts-actions">
              {transitions.map((option) => (
                <Button
                  key={option.status}
                  size="sm"
                  variant={buttonVariant(option.tone)}
                  title={option.hint}
                  disabled={isBusy}
                  busy={isBusy && busyStatus === option.status}
                  onClick={() => onRequest(option.status)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          )}

          <p className="tiny alerts-confirm">
            Review is applied by the backend. This alert shows a new status only after the server confirms the transition —
            nothing here is changed optimistically.
          </p>
          {isBusy ? (
            <p className="tiny" role="status" aria-live="polite">
              Submitting review…
            </p>
          ) : null}
        </div>
      </article>
    </li>
  );
}

export function AlertReviewPanel({
  response,
  loading,
  error,
  onReview,
  busyAlertId,
  reviewError,
  onSelectDecision,
  onSelectEntity,
}: {
  response: AlertsResponse | null;
  loading?: boolean;
  error?: { message: string; code?: string; status?: number } | null;
  /** called only with transitions the backend allows; the app performs the POST and shows the real result */
  onReview: (alertId: string, status: AlertStatus, note: string) => void;
  busyAlertId?: string | null;
  reviewError?: { message: string; code?: string; status?: number } | null;
  onSelectDecision?: (decisionId: string) => void;
  onSelectEntity?: (entityId: string) => void;
}): JSX.Element {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [lastRequested, setLastRequested] = useState<{ alertId: string; status: AlertStatus } | null>(null);

  const setNote = (alertId: string, value: string) => setNotes((prev) => ({ ...prev, [alertId]: value }));

  const requestReview = (alertId: string, status: AlertStatus) => {
    setLastRequested({ alertId, status });
    onReview(alertId, status, notes[alertId] ?? '');
  };

  if (error) {
    return (
      <Panel>
        <PanelHead title="Alert review" subtitle="Record the outcome of each alert" />
        <PanelBody>
          <ErrorState title="Could not load alerts" error={error} />
        </PanelBody>
      </Panel>
    );
  }

  if (!response) {
    return (
      <Panel>
        <PanelHead title="Alert review" subtitle="Record the outcome of each alert" />
        <PanelBody>
          {loading ? (
            <SkeletonRows rows={4} />
          ) : (
            <EmptyState title="No alerts loaded">
              <p>Alerts appear here once the backend returns them.</p>
            </EmptyState>
          )}
        </PanelBody>
      </Panel>
    );
  }

  const alerts = response.alerts;
  const affectedAlertId = busyAlertId ?? (lastRequested ? lastRequested.alertId : null);
  const subtitle =
    typeof response.total === 'number' && response.total !== alerts.length
      ? `${alerts.length} shown of ${response.total}`
      : `${alerts.length} alert${alerts.length === 1 ? '' : 's'}`;

  return (
    <Panel>
      <PanelHead title="Alert review" subtitle={subtitle} />
      <PanelBody>
        <div className="stack stack--loose">
          {loading ? <LoadingState label="Refreshing alerts…" /> : null}

          {reviewError && !affectedAlertId ? (
            <Callout tone="critical" title="Review failed">
              <p>{reviewError.message}</p>
            </Callout>
          ) : null}

          {alerts.length === 0 ? (
            response.empty_reason ? (
              <Callout tone="info" title="No alerts">
                <p>{response.empty_reason}</p>
              </Callout>
            ) : (
              <EmptyState title="No alerts to review">
                <p>The backend returned no alerts for this view.</p>
              </EmptyState>
            )
          ) : (
            <ul className="list list--divided alerts-list">
              {alerts.map((alert) => (
                <AlertCard
                  key={alert.id}
                  alert={alert}
                  note={notes[alert.id] ?? ''}
                  onNoteChange={(value) => setNote(alert.id, value)}
                  onRequest={(status) => requestReview(alert.id, status)}
                  isBusy={busyAlertId === alert.id}
                  busyStatus={lastRequested && lastRequested.alertId === alert.id ? lastRequested.status : null}
                  transitions={allowedTransitions(alert, response.allowed_transitions)}
                  reviewError={reviewError && affectedAlertId === alert.id ? reviewError : null}
                  onSelectDecision={onSelectDecision}
                  onSelectEntity={onSelectEntity}
                />
              ))}
            </ul>
          )}
        </div>
      </PanelBody>
    </Panel>
  );
}
