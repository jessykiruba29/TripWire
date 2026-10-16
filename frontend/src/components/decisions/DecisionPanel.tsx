/**
 * Affected decisions and their review status.
 *
 * Contract rule made visible: decisions that are *affected*, *uncertain* and *not
 * affected* are three separate groups. The panel never implies that everything
 * connected to a changed fact is invalid.
 */

import type { DecisionSummary, TriggerEventResponse } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { decisionStatusMeta, IMPACT_META } from '../../lib/vocabulary';
import {
  Badge,
  Button,
  Callout,
  ErrorState,
  Meter,
  Panel,
  PanelBody,
  PanelFoot,
  PanelHead,
  Section,
  SkeletonRows,
} from '../common';
import { IconAlert, IconTarget } from '../common/Icons';
import './decisions.css';

export interface DecisionPanelProps {
  decisions: DecisionSummary[];
  trigger: TriggerEventResponse | null;
  loading: boolean;
  error: { message: string; code?: string; status?: number } | null;
  onRetry: () => void;
  selectedId: string | null;
  onSelectDecision: (id: string) => void;
  onExplain: (id: string) => void;
  explanationDecisionId: string | null;
  graphRevision?: number;
}

export function DecisionPanel({
  decisions,
  trigger,
  loading,
  error,
  onRetry,
  selectedId,
  onSelectDecision,
  onExplain,
  explanationDecisionId,
  graphRevision,
}: DecisionPanelProps) {
  if (error && decisions.length === 0) {
    return (
      <Panel>
        <PanelHead title="Affected decisions" />
        <PanelBody>
          <ErrorState title="Could not load decisions" error={error} onRetry={onRetry} />
        </PanelBody>
      </Panel>
    );
  }

  if (loading && decisions.length === 0) {
    return (
      <Panel>
        <PanelHead title="Affected decisions" />
        <PanelBody>
          <SkeletonRows rows={3} />
        </PanelBody>
      </Panel>
    );
  }

  const needsReview = decisions.filter((d) => d.status === 'needs_review' || d.status === 'confirmed_stale');
  const propagation = trigger?.propagation;

  return (
    <Panel>
      <PanelHead
        icon={<IconTarget size={17} />}
        title="Decisions and review status"
        subtitle={
          trigger
            ? `After event ${trigger.event.id} · ${trigger.propagation.decisions.length} flagged, ${trigger.propagation.uncertain.length} uncertain, ${trigger.propagation.not_affected.length} unaffected`
            : 'Every decision in the company brain. Nothing is flagged until a fact changes.'
        }
        actions={
          <>
            <Badge tone={needsReview.length > 0 ? 'warning' : 'ok'} dot>
              {needsReview.length} needing review
            </Badge>
            {graphRevision !== undefined ? (
              <Badge tone="neutral" outline>
                rev {graphRevision}
              </Badge>
            ) : null}
          </>
        }
      />

      <PanelBody tight>
        <div className="stack">
          {propagation ? (
            <>
              <Section title={`Flagged for review (${propagation.decisions.length})`}>
                {propagation.decisions.length === 0 ? (
                  <p className="small muted">No decision crossed the review threshold for this event.</p>
                ) : (
                  <ul className="list">
                    {propagation.decisions.map((item) => (
                      <li key={item.id} className="list__item">
                        <DecisionCard
                          id={item.id}
                          title={item.label}
                          status={item.status}
                          confidence={item.confidence}
                          impact={item.impact}
                          reason={item.reason}
                          certainty={item.certainty}
                          depth={item.depth}
                          requiresInvestigation={item.requires_investigation}
                          alternateEvidence={item.alternate_evidence}
                          selected={selectedId === item.id}
                          onSelect={() => onSelectDecision(item.id)}
                          onExplain={() => onExplain(item.id)}
                          explaining={explanationDecisionId === item.id}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {propagation.uncertain.length > 0 ? (
                <Section title={`Uncertain — below the review threshold (${propagation.uncertain.length})`}>
                  <Callout tone="warning" title="Reported, not concluded">
                    These sit within reach of the change but under the confidence the backend requires to flag them. A
                    human has to look; Tripwire does not claim they are invalid.
                  </Callout>
                  <ul className="list">
                    {propagation.uncertain.map((item) => (
                      <li key={item.id} className="list__item">
                        <DecisionCard
                          id={item.id}
                          title={item.label}
                          status={item.status ?? 'potential'}
                          confidence={item.confidence ?? null}
                          impact={item.impact ?? 'low'}
                          reason={item.reason ?? ''}
                          requiresInvestigation={false}
                          alternateEvidence={item.alternate_evidence ?? []}
                          selected={selectedId === item.id}
                          onSelect={() => onSelectDecision(item.id)}
                          onExplain={() => onExplain(item.id)}
                          explaining={explanationDecisionId === item.id}
                        />
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {propagation.not_affected.length > 0 ? (
                <Section title={`Unaffected (${propagation.not_affected.length})`}>
                  <p className="tiny muted">
                    Kept visible on purpose: a change that at first looks enterprise-wide is usually narrower than it
                    feels.
                  </p>
                  <ul className="list list--divided">
                    {propagation.not_affected.map((item) => (
                      <li key={item.id} className="list__item list__item--pad">
                        <button
                          type="button"
                          className="dec__plain"
                          onClick={() => onSelectDecision(item.id)}
                          aria-pressed={selectedId === item.id}
                        >
                          <span className="dec__title">{item.label}</span>
                          <Badge tone="neutral">Unaffected</Badge>
                        </button>
                        {item.reason ? <p className="tiny muted">{item.reason}</p> : null}
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </>
          ) : (
            <Section title={`All decisions (${decisions.length})`}>
              <ul className="list">
                {decisions.map((decision) => {
                  const meta = decisionStatusMeta(decision.status);
                  return (
                    <li key={decision.id} className="list__item">
                      <div
                        className={`dec ${selectedId === decision.id ? 'dec--selected' : ''}`}
                        role="group"
                        aria-label={decision.title}
                      >
                        <button
                          type="button"
                          className="dec__head"
                          onClick={() => onSelectDecision(decision.id)}
                          aria-pressed={selectedId === decision.id}
                        >
                          <span className="dec__title">{decision.title}</span>
                          <Badge tone={meta.tone} dot title={meta.description}>
                            {meta.label}
                          </Badge>
                        </button>
                        <div className="dec__meta">
                          <span className="tiny muted">Owner {decision.owner_id ?? 'unknown'}</span>
                          <span className="tiny muted">Created {formatDateTime(decision.created_at)}</span>
                          {decision.confidence !== null ? (
                            <span className="dec__confidence">
                              <Meter value={decision.confidence} label={`Confidence in ${decision.title}`} />
                            </span>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => onExplain(decision.id)}>
                            Explain
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
        </div>
      </PanelBody>

      {trigger && trigger.propagation.systems.length === 0 ? (
        <PanelFoot>
          <span>
            The backend reported no directly affected system for this event; exposure is carried through projects and
            assumptions instead.
          </span>
        </PanelFoot>
      ) : null}
    </Panel>
  );
}

function DecisionCard({
  id,
  title,
  status,
  confidence,
  impact,
  reason,
  requiresInvestigation,
  alternateEvidence,
  selected,
  onSelect,
  onExplain,
  explaining,
  certainty,
  depth,
}: {
  id: string;
  title: string;
  status: string;
  confidence: number | null;
  impact: keyof typeof IMPACT_META;
  reason: string;
  requiresInvestigation: boolean;
  alternateEvidence: Array<{ fact_id: string; effect: string; note?: string; summary?: string }>;
  /** "confirmed" | "potential" — supplied by the real backend. */
  certainty?: string;
  depth?: number;
  selected: boolean;
  onSelect: () => void;
  onExplain: () => void;
  explaining: boolean;
}) {
  const meta = decisionStatusMeta(status);
  const impactMeta = IMPACT_META[impact];

  return (
    <div className={`dec ${selected ? 'dec--selected' : ''} ${requiresInvestigation ? 'dec--attention' : ''}`}>
      <button type="button" className="dec__head" onClick={onSelect} aria-pressed={selected}>
        <span className="dec__title">{title}</span>
        <span className="cluster">
          {/* The backend's own certainty is shown explicitly, because "potential"
              and "confirmed" mean different things for a reviewer. */}
          {certainty ? (
            <Badge
              tone={certainty === 'confirmed' ? 'critical' : 'warning'}
              title={
                certainty === 'confirmed'
                  ? 'The engine considers this impact established.'
                  : 'The engine considers this only possible — independent evidence still bears on it, so a human must decide.'
              }
            >
              {certainty === 'confirmed' ? 'Confirmed impact' : 'Potential impact'}
            </Badge>
          ) : null}
          <Badge tone={impactMeta.tone} outline title={`Backend impact rating: ${impactMeta.label}`}>
            {impactMeta.label}
          </Badge>
          <Badge tone={meta.tone} dot title={meta.description}>
            {meta.label}
          </Badge>
        </span>
      </button>

      <div className="dec__meta">
        <span className="mono tiny faint">{id}</span>`n        {typeof depth === 'number' ? <span className="tiny muted">depth {depth}</span> : null}
        {confidence !== null ? (
          <span className="dec__confidence">
            <Meter value={confidence} label={`Backend confidence for ${title}`} />
          </span>
        ) : null}
        <Button size="sm" variant={explaining ? 'primary' : 'ghost'} onClick={onExplain}>
          Explain
        </Button>
      </div>

      {reason ? <p className="dec__reason small">{reason}</p> : null}

      {alternateEvidence.length > 0 ? (
        <div className="dec__alternate">
          <IconAlert size={13} />
          <div>
            <span className="tiny strong">Alternate evidence that must be weighed</span>
            <ul className="dec__alternate-list">
              {alternateEvidence.map((item) => (
                <li key={item.fact_id}>
                  <span className="mono tiny">{item.fact_id}</span> — {item.summary ?? item.note ?? item.effect}
                  {item.note && item.summary ? <span className="tiny muted"> {item.note}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {requiresInvestigation ? (
        <span className="dec__flag tiny">
          Crossed the backend's review threshold — a human must confirm whether this decision still holds.
        </span>
      ) : null}
    </div>
  );
}
