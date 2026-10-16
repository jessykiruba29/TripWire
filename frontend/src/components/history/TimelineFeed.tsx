/**
 * TimelineFeed — a compact, reverse-chronological activity feed of `TimelineEntry`.
 *
 * Presentational only: it never fetches and never invents entries. Grouping is by
 * calendar day, truncation is explicit and honest ("showing the most recent N of M").
 */

import type { TimelineEntry } from '../../api/types';
import { formatDateTime, formatDay, formatRelative, toDateInputValue, truncate } from '../../lib/format';
import { sourceTypeMeta } from '../../lib/vocabulary';
import { Badge, EmptyState, ErrorState, LoadingState, SkeletonRows } from '../common';
import './history.css';

const DEFAULT_LIMIT = 30;

function humaniseKind(kind: string): string {
  return kind.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function itemTime(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
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
    <button
      type="button"
      className="chip chip--button mono"
      title={`Select entity ${id}`}
      onClick={() => onSelectEntity(id)}
    >
      {id}
    </button>
  );
}

export function TimelineFeed({
  entries,
  loading,
  error,
  onSelectEntity,
  emptyTitle,
  limit = DEFAULT_LIMIT,
}: {
  entries: TimelineEntry[];
  loading?: boolean;
  error?: { message: string; code?: string; status?: number } | null;
  onSelectEntity?: (entityId: string) => void;
  emptyTitle?: string;
  limit?: number;
}): JSX.Element {
  if (error) {
    return <ErrorState title="Could not load the timeline" error={error} />;
  }

  if (loading && entries.length === 0) {
    return <SkeletonRows rows={5} />;
  }

  const effectiveLimit = Math.max(0, limit);
  const sorted = [...entries].sort((a, b) => itemTime(b.at) - itemTime(a.at));
  const visible = sorted.slice(0, effectiveLimit);
  const hiddenCount = sorted.length - visible.length;

  if (visible.length === 0) {
    return (
      <EmptyState title={emptyTitle ?? 'No recorded activity'}>
        <p>No timeline entries were returned by the backend for this view.</p>
      </EmptyState>
    );
  }

  // Preserve the reverse-chronological order while grouping into calendar days.
  const groups: Array<{ key: string; heading: string; headingTitle: string; entries: TimelineEntry[] }> = [];
  for (const entry of visible) {
    const key = toDateInputValue(entry.at) || 'unknown-day';
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, heading: formatDay(entry.at), headingTitle: formatDateTime(entry.at), entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }

  return (
    <div className="hist-timeline">
      {loading ? <LoadingState label="Refreshing timeline…" /> : null}

      {hiddenCount > 0 ? (
        <p className="tiny muted hist-timeline__truncation" role="status">
          Showing the most recent {visible.length} of {sorted.length} entries.
        </p>
      ) : null}

      {groups.map((group) => (
        <section key={group.key} className="hist-timeline__day" aria-label={group.headingTitle}>
          <h4 className="hist-timeline__day-heading" title={group.headingTitle}>
            {group.heading}
          </h4>
          <ul className="list list--divided">
            {group.entries.map((entry, index) => (
              <li key={`${entry.at}-${entry.kind}-${index}`} className="list__item list__item--pad">
                <div className="hist-entry">
                  <div className="row row--between row--wrap">
                    <div className="cluster">
                      <time className="hist-entry__at tiny mono" dateTime={entry.at} title={formatDateTime(entry.at)}>
                        {formatRelative(entry.at)}
                      </time>
                      <Badge tone="neutral">{humaniseKind(entry.kind)}</Badge>
                      {entry.source_type ? (
                        <Badge tone="info" outline>
                          {sourceTypeMeta(entry.source_type).label}
                        </Badge>
                      ) : null}
                    </div>
                    {entry.entity_ids.length > 0 ? (
                      <div className="cluster hist-entry__ids">
                        {entry.entity_ids.map((id) => (
                          <EntityChip key={id} id={id} onSelectEntity={onSelectEntity} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <p className="small hist-entry__summary">{truncate(entry.summary, 260)}</p>
                  <p className="tiny muted">
                    Actor: {entry.actor ? entry.actor : 'Not available from the backend'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
