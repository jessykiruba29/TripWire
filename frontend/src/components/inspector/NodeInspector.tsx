/**
 * Inspector for one graph entity.
 *
 * Answers the question a judge will ask first: "why is this thing connected to
 * that thing?" Every relationship is listed with its edge type AND the meaning of
 * that edge type, so the connection is explained rather than merely drawn.
 */

import { useMemo } from 'react';
import type { DecisionDetail, FactDetail, GraphNode, GraphResponse, PersonDetail } from '../../api/types';
import { groupByEdgeType, indexNodes, neighboursOf, type PathHighlight } from '../../lib/graph';
import { describeBitemporal, formatDateTime, formatDate, truncate } from '../../lib/format';
import {
  EDGE_TYPE_META,
  NODE_STATE_META,
  NODE_TYPE_META,
  decisionStatusMeta,
  edgeLabel,
  nodeTypeLabel,
} from '../../lib/vocabulary';
import {
  Badge,
  EmptyState,
  KeyValue,
  Meter,
  Panel,
  PanelBody,
  PanelHead,
  Section,
  SkeletonRows,
} from '../common';
import { IconLink } from '../common/Icons';
import './inspector.css';

export interface NodeInspectorProps {
  node: GraphNode | null;
  graph: GraphResponse | null;
  highlight: PathHighlight | null;
  pathLabel?: string;
  onSelect: (id: string | null) => void;
  onOpenSource?: (sourceId: string) => void;
  factDetail?: FactDetail | null;
  decisionDetail?: DecisionDetail | null;
  personDetail?: PersonDetail | null;
  loadingDetail?: boolean;
  onShowExplanation?: (decisionId: string) => void;
  onShowProvenance?: (factId: string) => void;
}

export function NodeInspector({
  node,
  graph,
  highlight,
  pathLabel,
  onSelect,
  onOpenSource,
  factDetail,
  decisionDetail,
  personDetail,
  loadingDetail,
  onShowExplanation,
  onShowProvenance,
}: NodeInspectorProps) {
  const nodeIndex = useMemo(() => indexNodes(graph?.nodes ?? []), [graph]);

  const links = useMemo(
    () => (node ? neighboursOf(node.id, graph?.edges ?? [], nodeIndex) : []),
    [node, graph, nodeIndex],
  );
  const grouped = useMemo(() => groupByEdgeType(links), [links]);

  if (!node) {
    return (
      <Panel>
        <PanelBody>
          <EmptyState title="Nothing selected" icon={<IconLink size={26} />}>
            <p>Select a node to inspect its summary and connections.</p>
          </EmptyState>
        </PanelBody>
      </Panel>
    );
  }

  const typeMeta = NODE_TYPE_META[node.type];
  const stateMeta = NODE_STATE_META[node.state];
  const onPath = highlight?.nodeIds.has(node.id) ?? false;
  const narration = onPath ? relevantNarration(highlight, node.id) : [];

  return (
    <Panel className="node-inspector">
      <PanelHead
        title={
          <span className="insp__title">
            <span
              className={`legend__swatch legend__swatch--${typeMeta.shape}`}
              style={{ background: typeMeta.hex }}
              aria-hidden="true"
            />
            {node.label}
          </span>
        }
        subtitle={
          <span className="cluster">
            <Badge tone="neutral">{nodeTypeLabel(node.type)}</Badge>
            {node.state !== 'normal' ? (
              <Badge tone={stateMeta.tone} dot title={stateMeta.description}>
                {stateMeta.label}
              </Badge>
            ) : null}
            {onPath ? <Badge tone="brand">On inspected chain</Badge> : null}
          </span>
        }
      />

      <PanelBody>
        <div className="stack">
          <p className="small">{node.summary || 'No summary was recorded for this entity.'}</p>

          <KeyValue
            rows={[
              { k: 'Connections', v: <span className="mono">{node.degree ?? links.length}</span> },
              {
                k: 'Confidence',
                v: node.confidence === null ? <span className="muted">Not recorded</span> : (
                  <Meter value={node.confidence} label={`Confidence in ${node.label}`} />
                ),
              },
            ]}
          />

          <details className="insp__details">
            <summary>Connections &amp; full record <span>{links.length}</span></summary>
            <div className="insp__details-body">

          {node.type === 'fact' ? (
            <p className="tiny muted">{describeBitemporal(node.valid_from, node.recorded_at)}</p>
          ) : null}

          {node.project_ids.length || node.team_ids.length ? (
            <div className="cluster">
              {node.project_ids.map((id) => (
                <button key={id} type="button" className="chip chip--button" onClick={() => onSelect(id)}>
                  {nodeIndex.get(id)?.label ?? id}
                </button>
              ))}
              {node.team_ids.map((id) => (
                <button key={id} type="button" className="chip chip--button" onClick={() => onSelect(id)}>
                  {nodeIndex.get(id)?.label ?? id}
                </button>
              ))}
            </div>
          ) : null}

          {narration.length > 0 ? (
            <div className="callout callout--info">
              <span className="callout__icon">
                <IconLink size={16} />
              </span>
              <div className="callout__body">
                <span className="callout__title">Why this entity is on the highlighted chain</span>
                <ol className="insp__narration">
                  {narration.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ol>
                {pathLabel ? <p className="tiny muted">{pathLabel}</p> : null}
              </div>
            </div>
          ) : null}

          {loadingDetail ? <SkeletonRows rows={2} /> : null}

          {/* ------------------------------------------------- type-specific */}

          {node.type === 'decision' && decisionDetail ? (
            <Section title="Decision record">
              <KeyValue
                rows={[
                  { k: 'Status', v: <Badge tone={decisionStatusMeta(decisionDetail.decision.status).tone}>{decisionStatusMeta(decisionDetail.decision.status).label}</Badge> },
                  { k: 'Owner', v: decisionDetail.people.find((p) => p.role === 'decision_owner')?.name ?? decisionDetail.decision.owner_id ?? '—' },
                  { k: 'Created', v: formatDateTime(decisionDetail.decision.created_at) },
                ]}
              />
              {decisionDetail.history.length > 0 ? (
                <ul className="list list--divided">
                  {decisionDetail.history.map((entry, index) => (
                    <li key={index} className="list__item list__item--pad">
                      <div className="row row--between">
                        <span className="small">{entry.summary}</span>
                        <span className="tiny muted nowrap">{formatDateTime(entry.at)}</span>
                      </div>
                      <span className="tiny muted">Recorded by {entry.actor}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {onShowExplanation ? (
                <button type="button" className="btn btn--sm" onClick={() => onShowExplanation(node.id)}>
                  Explain this decision
                </button>
              ) : null}
            </Section>
          ) : null}

          {node.type === 'fact' && factDetail ? (
            <Section title="Fact record">
              <p className="quote">{factDetail.statement}</p>
              <KeyValue
                rows={[
                  { k: 'Validity', v: <Badge tone={factDetail.validity === 'contradicted' ? 'critical' : 'neutral'}>{factDetail.validity}</Badge> },
                  { k: 'Superseded', v: factDetail.superseded_at ? formatDateTime(factDetail.superseded_at) : 'Not superseded' },
                  { k: 'Carries', v: factDetail.supports.length > 0 ? factDetail.supports.map((a) => a.label).join(', ') : 'No assumption depends on it' },
                ]}
              />
              {factDetail.recorded_time_note ? <p className="tiny muted">{factDetail.recorded_time_note}</p> : null}
              {factDetail.affects_decisions.length > 0 ? (
                <div className="stack stack--tight">
                  <span className="tiny muted">Decisions this fact reaches</span>
                  <div className="cluster">
                    {factDetail.affects_decisions.map((decision) => (
                      <button
                        key={decision.id}
                        type="button"
                        className="chip chip--button"
                        onClick={() => onSelect(decision.id)}
                        title={decision.title}
                      >
                        {truncate(decision.title, 42)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {onShowProvenance ? (
                <button type="button" className="btn btn--sm" onClick={() => onShowProvenance(node.id)}>
                  Show evidence chain
                </button>
              ) : null}
            </Section>
          ) : null}

          {node.type === 'person' && personDetail ? (
            <Section title="Demonstrated contributions">
              <p className="tiny muted">{personDetail.profile_note}</p>
              <div className="grid-2">
                <div>
                  <span className="tiny muted">Systems</span>
                  <div className="cluster">
                    {personDetail.systems.length > 0
                      ? personDetail.systems.map((s) => (
                          <button key={s.id} type="button" className="chip chip--button" onClick={() => onSelect(s.id)}>
                            {s.title}
                          </button>
                        ))
                      : <span className="tiny muted">None recorded</span>}
                  </div>
                </div>
                <div>
                  <span className="tiny muted">Projects</span>
                  <div className="cluster">
                    {personDetail.projects.length > 0
                      ? personDetail.projects.map((p) => (
                          <button key={p.id} type="button" className="chip chip--button" onClick={() => onSelect(p.id)}>
                            {p.title}
                          </button>
                        ))
                      : <span className="tiny muted">None recorded</span>}
                  </div>
                </div>
              </div>
              <ul className="list list--divided">
                {personDetail.contributions.slice(0, 8).map((contribution) => (
                  <li key={contribution.source_id} className="list__item list__item--pad">
                    <button
                      type="button"
                      className="insp__contribution"
                      onClick={() => onOpenSource?.(contribution.source_id)}
                    >
                      <span className="small">{contribution.title}</span>
                      <span className="tiny muted nowrap">{formatDate(contribution.at)}</span>
                    </button>
                    {contribution.why ? <span className="tiny muted">{contribution.why}</span> : null}
                  </li>
                ))}
              </ul>
              {personDetail.contributions.length > 8 ? (
                <p className="tiny muted">
                  Showing the 8 most recent of {personDetail.contributions.length} recorded contributions.
                </p>
              ) : null}
            </Section>
          ) : null}

          {(node.type === 'message' || node.type === 'document') && onOpenSource ? (
            <Section title="Source record">
              <p className="tiny muted">
                This node is a source record. Open it to read the verbatim text and see which facts, assumptions and
                decisions it supports.
              </p>
              <button type="button" className="btn btn--sm" onClick={() => onOpenSource(node.id)}>
                Open source record
              </button>
            </Section>
          ) : null}

          {/* --------------------------------------------------- relationships */}

          <Section title={`Relationships (${links.length})`}>
            {grouped.length === 0 ? (
              <p className="small muted">No relationships recorded for this entity.</p>
            ) : (
              <div className="stack stack--tight">
                {grouped.map((group) => (
                  <div key={group.type} className="insp__group">
                    <div className="insp__group-head">
                      <span className="insp__edge-name">{edgeLabel(group.type)}</span>
                      <span className="tiny muted">{EDGE_TYPE_META[group.type]?.description ?? ''}</span>
                    </div>
                    <ul className="list">
                      {group.links.slice(0, 12).map((link) => {
                        const meta = link.node ? NODE_TYPE_META[link.node.type] : null;
                        const onChain = link.node ? highlight?.nodeIds.has(link.node.id) ?? false : false;
                        return (
                          <li key={link.edge.id} className="list__item">
                            <button
                              type="button"
                              className="insp__link"
                              onClick={() => link.node && onSelect(link.node.id)}
                              disabled={!link.node}
                            >
                              <span className="insp__dir" aria-hidden="true">
                                {link.direction === 'out' ? '→' : '←'}
                              </span>
                              {meta ? (
                                <span
                                  className={`legend__swatch legend__swatch--${meta.shape}`}
                                  style={{ background: meta.hex }}
                                  aria-hidden="true"
                                />
                              ) : null}
                              <span className="insp__link-label">{link.node?.label ?? 'Unknown entity'}</span>
                              <span className="cluster">
                                {onChain ? <Badge tone="brand">Chain</Badge> : null}
                                {link.node && link.node.state !== 'normal' ? (
                                  <Badge tone={NODE_STATE_META[link.node.state].tone}>
                                    {NODE_STATE_META[link.node.state].label}
                                  </Badge>
                                ) : null}
                                <span className="tiny faint">{link.node ? nodeTypeLabel(link.node.type) : ''}</span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {group.links.length > 12 ? (
                      <p className="tiny muted">…and {group.links.length - 12} more of this kind.</p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {node.source_ids.length > 0 ? (
            <Section title={`Backing sources (${node.source_ids.length})`}>
              <div className="cluster">
                {node.source_ids.map((id) => (
                  <button key={id} type="button" className="chip chip--button" onClick={() => onOpenSource?.(id)}>
                    {id}
                  </button>
                ))}
              </div>
            </Section>
          ) : null}
            </div>
          </details>
        </div>
      </PanelBody>

    </Panel>
  );
}

/** Narration lines from the highlighted chain that mention this node. */
function relevantNarration(highlight: PathHighlight | null, nodeId: string): string[] {
  if (!highlight) return [];
  return highlight.narration.filter((line) => line.includes(nodeId));
}
