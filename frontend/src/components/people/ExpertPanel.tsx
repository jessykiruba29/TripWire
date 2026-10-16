/**
 * Who to ask about a system — the contributor ranking.
 *
 * Two honesty rules shape this panel and are non-negotiable:
 *   1. Popularity is not expertise. Every ranked person is shown with the recorded
 *      contributions and the evidence items behind their score, plus the backend's
 *      own ranking explanation, limitations and uncertainty strings.
 *   2. Removals are part of the answer. Everyone the backend excluded from the
 *      ranking is listed, with the reason, behind a disclosure — never silently dropped.
 */

import type { Expert, ExpertsResponse } from '../../api/types';
import { formatDate, humaniseId } from '../../lib/format';
import { sourceTypeMeta } from '../../lib/vocabulary';
import {
  Badge,
  Callout,
  Disclosure,
  EmptyState,
  ErrorState,
  LoadingState,
  Meter,
  Panel,
  PanelBody,
  PanelFoot,
  PanelHead,
  Section,
} from '../common';
import './people.css';

const UNAVAILABLE = 'Not available from the backend';

const CONTRIBUTION_KEYS = [
  'tickets_authored',
  'tickets_resolved',
  'messages',
  'documents',
  'meeting_notes',
  'decisions_touched',
] as const;

type ContributionKey = (typeof CONTRIBUTION_KEYS)[number];

/** Human wording for the backend's contribution_count keys. */
const CONTRIBUTION_LABELS: Record<ContributionKey, string> = {
  tickets_authored: 'Tickets authored',
  tickets_resolved: 'Resolved tickets',
  messages: 'Messages',
  documents: 'Documents',
  meeting_notes: 'Meeting notes',
  decisions_touched: 'Decisions touched',
};

function isContributionKey(key: string): key is ContributionKey {
  return (CONTRIBUTION_KEYS as readonly string[]).includes(key);
}

function contributionLabel(key: string): string {
  return isContributionKey(key) ? CONTRIBUTION_LABELS[key] : humaniseId(key);
}

export function ExpertPanel({
  response,
  loading,
  error,
  onSelectPerson,
  headline,
}: {
  response: ExpertsResponse | null;
  loading?: boolean;
  error?: { message: string; code?: string; status?: number } | null;
  onSelectPerson?: (personId: string) => void;
  headline?: string;
}): JSX.Element {
  if (loading) {
    return (
      <Panel className="ppl-panel">
        <PanelBody>
          <LoadingState label="Ranking contributors…" />
        </PanelBody>
      </Panel>
    );
  }

  if (error) {
    return (
      <Panel className="ppl-panel">
        <PanelBody>
          <ErrorState title="Contributor ranking unavailable" error={error} />
        </PanelBody>
      </Panel>
    );
  }

  if (!response) {
    return (
      <Panel className="ppl-panel">
        <PanelBody>
          <EmptyState title="No ranking requested">
            No contributor ranking was returned. Select a system to rank its contributors.
          </EmptyState>
        </PanelBody>
      </Panel>
    );
  }

  const systemName = response.system_label || response.system_id || 'this system';
  const expertCount = response.experts.length;

  return (
    <Panel className="ppl-panel">
      <PanelHead
        title={headline ?? `Who to ask: ${systemName}`}
        subtitle={`${expertCount} ranked contributor${expertCount === 1 ? '' : 's'}`}
      />
      <PanelBody>
        <div className="stack stack--loose">
          {response.alert_context ? (
            <Callout tone="info" title="Why this ranking was requested">
              {response.alert_context}
            </Callout>
          ) : null}

          {response.recommended_contact ? (
            <RecommendedContact contact={response.recommended_contact} onSelectPerson={onSelectPerson} />
          ) : null}

          {expertCount === 0 ? (
            <EmptyState title="No ranked contributors">
              No contributors were ranked for {systemName}.
            </EmptyState>
          ) : (
            <ol className="ppl-experts list">
              {response.experts.map((expert) => (
                <ExpertCard key={expert.person_id} expert={expert} onSelectPerson={onSelectPerson} />
              ))}
            </ol>
          )}

          <Disclosure summary="Excluded from ranking" count={response.excluded.length}>
            {response.excluded.length === 0 ? (
              <p className="muted small">No contributors were excluded from this ranking.</p>
            ) : (
              <ul className="ppl-excluded list">
                {response.excluded.map((entry) => (
                  <li className="ppl-excluded__item list__item" key={entry.person_id}>
                    <span className="strong">{entry.name ? entry.name : humaniseId(entry.person_id)}</span>
                    <span className="muted tiny mono">{entry.person_id}</span>
                    <span className="small">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </Disclosure>
        </div>
      </PanelBody>
      <PanelFoot>
        <p className="ppl-note muted tiny">Ranking method: {response.method ? response.method : UNAVAILABLE}</p>
      </PanelFoot>
    </Panel>
  );
}

function ExpertCard({
  expert,
  onSelectPerson,
}: {
  expert: Expert;
  onSelectPerson?: (personId: string) => void;
}): JSX.Element {
  const counts = CONTRIBUTION_KEYS.map((key) => ({ key, value: expert.contribution_counts[key] })).filter(
    (entry): entry is { key: ContributionKey; value: number } => typeof entry.value === 'number',
  );

  return (
    <li className="ppl-expert list__item">
      <div className="ppl-expert__head">
        <span className="ppl-expert__rank" aria-hidden="true">
          #{expert.rank}
        </span>
        <div className="row__grow">
          <p className="ppl-expert__name strong">
            {onSelectPerson ? (
              <button
                type="button"
                className="ppl-expert__link"
                onClick={() => onSelectPerson(expert.person_id)}
              >
                {expert.name}
              </button>
            ) : (
              expert.name
            )}
          </p>
          <p className="muted small">
            {expert.title ? expert.title : 'Title not available from the backend'}
            {expert.team_name ? <> · {expert.team_name}</> : null}
          </p>
        </div>
        <div className="cluster">
          <Badge tone="neutral">Rank {expert.rank}</Badge>
          {expert.is_official_owner ? (
            <Badge tone="ok" dot title="Recorded as the official owner of this system.">
              Listed owner
            </Badge>
          ) : (
            <Badge
              tone="neutral"
              outline
              title="Has recorded contributions, but is not the official owner of this system."
            >
              Not the listed owner
            </Badge>
          )}
        </div>
      </div>

      <div className="ppl-score">
        <span className="muted tiny">Contribution score</span>
        <Meter value={expert.score} label={`Contribution score for ${expert.name}`} />
        <span className="muted tiny">
          {expert.total_contributions} recorded contribution
          {expert.total_contributions === 1 ? '' : 's'}
        </span>
      </div>

      <div>
        <span className="ppl-subhead">Contribution breakdown</span>
        {counts.length === 0 ? (
          <p className="muted small">No contribution breakdown was returned for this person.</p>
        ) : (
          <div className="ppl-counts">
            {counts.map((entry) => (
              <div className="ppl-count" key={entry.key}>
                <span className="ppl-count__value">{entry.value}</span>
                <span className="muted tiny">{contributionLabel(entry.key)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Section title="Evidence of contribution">
        {expert.evidence.length === 0 ? (
          <p className="muted small">No individual evidence items were returned for this person.</p>
        ) : (
          <ul className="ppl-evidence list">
            {expert.evidence.map((item, index) => (
              <li className="ppl-evidence__item list__item" key={`${item.source_id}-${index}`}>
                <div className="cluster">
                  <Badge tone="neutral">{sourceTypeMeta(item.type).label}</Badge>
                  <span className="strong">{item.title}</span>
                  <span className="muted tiny" title={item.at}>
                    {formatDate(item.at)}
                  </span>
                </div>
                {item.why ? <p className="small ppl-evidence__why">{item.why}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Why this person ranks here">
        <p className="small ppl-text">{expert.ranking_explanation || UNAVAILABLE}</p>
      </Section>

      <Callout tone="warning" title="Limitations">
        {expert.limitations || UNAVAILABLE}
      </Callout>

      <Section title="Uncertainty">
        {expert.uncertainty.length === 0 ? (
          <p className="muted small">The backend listed no specific uncertainties for this ranking.</p>
        ) : (
          <ul className="ppl-uncertainty">
            {expert.uncertainty.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        )}
      </Section>
    </li>
  );
}

function RecommendedContact({
  contact,
  onSelectPerson,
}: {
  contact: NonNullable<ExpertsResponse['recommended_contact']>;
  onSelectPerson?: (personId: string) => void;
}): JSX.Element {
  return (
    <div className="ppl-recommended">
      <p className="ppl-recommended__eyebrow">Recommended contact</p>
      <p className="ppl-recommended__name strong">
        {onSelectPerson ? (
          <button
            type="button"
            className="ppl-expert__link"
            onClick={() => onSelectPerson(contact.person_id)}
          >
            {contact.name}
          </button>
        ) : (
          contact.name
        )}
      </p>
      <p className="small">{contact.why}</p>
      {contact.ranking_explanation ? (
        <p className="muted small">{contact.ranking_explanation}</p>
      ) : null}
      {contact.uncertainty && contact.uncertainty.length > 0 ? (
        <ul className="ppl-uncertainty small">
          {contact.uncertainty.map((text, index) => (
            <li key={index}>{text}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
