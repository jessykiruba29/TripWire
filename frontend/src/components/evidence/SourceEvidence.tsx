/**
 * Evidence panels: a list of recorded sources, and the full detail of one source.
 *
 * Every value rendered here is taken verbatim from `SourceRecord`. Nothing is
 * inferred, summarised or filled in: when the backend omits a field the panel says
 * so out loud instead of quietly inventing a plausible value.
 */

import type { NodeType, SourceRecord } from '../../api/types';
import { describeBitemporal, formatDateTime, formatRelative } from '../../lib/format';
import { nodeTypeLabel, sourceTypeMeta } from '../../lib/vocabulary';
import {
  Badge,
  Chip,
  CloseButton,
  EmptyState,
  KeyValue,
  Panel,
  PanelBody,
  PanelHead,
  Section,
  SimulatedTag,
} from '../common';
import './evidence.css';

/** Shown wherever the backend did not supply a value. Never replaced with a guess. */
const UNAVAILABLE = 'Not available from the backend';

/* ------------------------------------------------------------------------ list */

export function SourceList({
  sources,
  title = 'Evidence sources',
  emptyTitle = 'No sources',
  emptyText = 'No source records were returned for this selection.',
  selectedSourceId = null,
  onSelect,
}: {
  sources: SourceRecord[];
  title?: string;
  emptyTitle?: string;
  emptyText?: string;
  selectedSourceId?: string | null;
  onSelect?: (source: SourceRecord) => void;
}): JSX.Element {
  return (
    <Section title={title}>
      {sources.length === 0 ? (
        <EmptyState title={emptyTitle}>{emptyText}</EmptyState>
      ) : (
        <ul className="ev-sources list">
          {sources.map((source) => (
            <li className="ev-sources__item list__item" key={source.id}>
              {onSelect ? (
                <button
                  type="button"
                  className="ev-sources__row"
                  aria-pressed={selectedSourceId === source.id}
                  onClick={() => onSelect(source)}
                >
                  <SourceRowBody source={source} />
                </button>
              ) : (
                <div className="ev-sources__row ev-sources__row--static">
                  <SourceRowBody source={source} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SourceRowBody({ source }: { source: SourceRecord }): JSX.Element {
  const typeMeta = sourceTypeMeta(source.type);
  const excerpt = source.excerpt && source.excerpt.trim().length > 0 ? source.excerpt : source.text;

  return (
    <>
      <div className="ev-sources__head">
        <Badge tone="neutral">{typeMeta.label}</Badge>
        <span className="ev-sources__title strong">{source.title || 'Untitled source'}</span>
        <span className="ev-sources__time muted tiny nowrap" title={formatDateTime(source.timestamp)}>
          {formatRelative(source.timestamp)}
        </span>
      </div>
      <p className="ev-sources__byline muted small">
        {source.author_name ? source.author_name : UNAVAILABLE}
      </p>
      <p className="ev-sources__excerpt quote clamp-2">{excerpt}</p>
      <div className="ev-sources__foot">
        <SimulatedTag simulated={source.simulated} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------------ card */

type SourceDetail = {
  supports_facts?: Array<{ id: string; label: string }>;
  supports_assumptions?: Array<{ id: string; label: string }>;
  supports_decisions?: Array<{ id: string; title: string }>;
  linked_entities?: Array<{ id: string; type: NodeType; label: string }>;
};

export function SourceCard({
  source,
  detail = null,
  onSelectEntity,
  onClose,
}: {
  source: SourceRecord;
  /** optional extra context from GET /api/sources/{id} */
  detail?: SourceDetail | null;
  onSelectEntity?: (id: string) => void;
  onClose?: () => void;
}): JSX.Element {
  const typeMeta = sourceTypeMeta(source.type);
  const hasDistinctRecordedAt = Boolean(source.recorded_at && source.recorded_at !== source.timestamp);
  const bitemporal = hasDistinctRecordedAt
    ? describeBitemporal(source.timestamp, source.recorded_at)
    : null;

  return (
    <Panel className="ev-card">
      <PanelHead
        title={source.title || 'Untitled source'}
        subtitle={typeMeta.label}
        actions={onClose ? <CloseButton onClick={onClose} label="Close source detail" /> : undefined}
      />
      <PanelBody>
        <div className="stack">
          <div className="cluster">
            <Badge tone="neutral">{typeMeta.label}</Badge>
            <SimulatedTag simulated={source.simulated} />
            {source.operator_entry ? <Badge tone="info">Operator entry</Badge> : null}
            {source.external_id ? <Chip title="External reference">{source.external_id}</Chip> : null}
          </div>

          <KeyValue
            rows={[
              { k: 'Author', v: source.author_name ? source.author_name : UNAVAILABLE },
              {
                k: 'True in the world',
                v: <span title={source.timestamp}>{formatDateTime(source.timestamp)}</span>,
              },
              {
                k: 'Known to Tripwire',
                v: source.recorded_at ? (
                  <span title={source.recorded_at}>{formatDateTime(source.recorded_at)}</span>
                ) : (
                  UNAVAILABLE
                ),
              },
            ]}
          />

          {bitemporal ? <p className="ev-card__bitemporal muted small">{bitemporal}</p> : null}

          <Section title="Verbatim text">
            {source.text ? (
              <blockquote className="quote ev-verbatim">{source.text}</blockquote>
            ) : (
              <p className="muted small">{UNAVAILABLE}</p>
            )}
          </Section>

          {detail ? <LinkedEntities detail={detail} onSelectEntity={onSelectEntity} /> : null}
        </div>
      </PanelBody>
    </Panel>
  );
}

/* ----------------------------------------------------------------- linked entities */

function LinkedEntities({
  detail,
  onSelectEntity,
}: {
  detail: SourceDetail;
  onSelectEntity?: (id: string) => void;
}): JSX.Element {
  const groups: Array<{
    key: string;
    label: string;
    items: Array<{ id: string; label: string; type?: NodeType }>;
  }> = [];

  if (detail.supports_facts && detail.supports_facts.length > 0) {
    groups.push({ key: 'facts', label: 'Supported facts', items: detail.supports_facts });
  }
  if (detail.supports_assumptions && detail.supports_assumptions.length > 0) {
    groups.push({ key: 'assumptions', label: 'Supported assumptions', items: detail.supports_assumptions });
  }
  if (detail.supports_decisions && detail.supports_decisions.length > 0) {
    groups.push({
      key: 'decisions',
      label: 'Supported decisions',
      items: detail.supports_decisions.map((decision) => ({ id: decision.id, label: decision.title })),
    });
  }
  if (detail.linked_entities && detail.linked_entities.length > 0) {
    groups.push({
      key: 'entities',
      label: 'Linked entities',
      items: detail.linked_entities.map((entity) => ({
        id: entity.id,
        label: entity.label,
        type: entity.type,
      })),
    });
  }

  return (
    <Section title="Linked entities">
      {groups.length === 0 ? (
        <p className="muted small">No linked entities were returned for this source.</p>
      ) : (
        <div className="stack stack--tight">
          {groups.map((group) => (
            <div className="ev-links__group" key={group.key}>
              <span className="ev-links__label">{group.label}</span>
              <div className="ev-links__items">
                {group.items.map((item) => (
                  <EntityChip
                    key={`${group.key}-${item.id}`}
                    id={item.id}
                    label={item.label}
                    typeLabel={item.type ? nodeTypeLabel(item.type) : undefined}
                    onSelect={onSelectEntity}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function EntityChip({
  id,
  label,
  typeLabel,
  onSelect,
}: {
  id: string;
  label: string;
  typeLabel?: string;
  onSelect?: (id: string) => void;
}): JSX.Element {
  const content = (
    <>
      {typeLabel ? <span className="ev-chip__type">{typeLabel}</span> : null}
      <span>{label}</span>
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        className="chip chip--button ev-chip"
        onClick={() => onSelect(id)}
        title={`Open ${label}`}
      >
        {content}
      </button>
    );
  }

  return <span className="chip ev-chip">{content}</span>;
}
