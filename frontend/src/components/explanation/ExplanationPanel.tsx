/**
 * The explanation panel: the exact chain from the changed fact to the affected
 * decision, in the backend's own words.
 *
 * This is the heart of the product, so it leans hard on the backend's narration
 * and never softens uncertainty: `uncertainty`, `alternate_evidence` and
 * `unavailable` are rendered as first-class content.
 */

import type { Explanation, GraphNode, PathLike } from '../../api/types';
import { formatDateTime, formatPercent } from '../../lib/format';
import { EDGE_TYPE_META, NODE_STATE_META, NODE_TYPE_META, edgeLabel, nodeTypeLabel } from '../../lib/vocabulary';
import type { PathHighlight } from '../../lib/graph';
import {
  Badge,
  Button,
  Callout,
  Chip,
  EmptyState,
  ErrorState,
  Meter,
  Panel,
  PanelBody,
  PanelFoot,
  PanelHead,
  Section,
  SkeletonRows,
} from '../common';
import { IconAlert, IconArrowRight, IconBolt, IconInfo, IconLink } from '../common/Icons';
import './explanation.css';

export interface ExplanationPanelProps {
  explanation: Explanation | null;
  loading: boolean;
  error: { message: string; code?: string; status?: number } | null;
  onRetry: () => void;
  nodeIndex: Map<string, GraphNode>;
  highlight: PathHighlight | null;
  onSelect: (id: string) => void;
  onFocusChain?: () => void;
  onOpenSource: (sourceId: string) => void;
  idleHeadline?: string;
  idleText?: string;
}

export function ExplanationPanel({
  explanation,
  loading,
  error,
  onRetry,
  nodeIndex,
  highlight,
  onSelect,
  onFocusChain,
  onOpenSource,
  idleHeadline = 'No decision is being explained yet',
  idleText = 'Trigger the Frankfurt scenario, or pick any decision and choose Explain, to see the chain from the changed fact to the decision it puts at risk.',
}: ExplanationPanelProps) {
  if (loading && !explanation) {
    return (
      <Panel>
        <PanelHead title="Why this decision is flagged" icon={<IconBolt size={17} />} />
        <PanelBody>
          <div className="stack">
            <div className="loading-row">
              <span className="spinner" />
              <span>Tracing the chain from the new fact to the decision…</span>
            </div>
            <SkeletonRows rows={4} />
          </div>
        </PanelBody>
      </Panel>
    );
  }

  if (error) {
    return (
      <Panel>
        <PanelHead title="Why this decision is flagged" icon={<IconBolt size={17} />} />
        <PanelBody>
          <ErrorState title="Could not build the explanation" error={error} onRetry={onRetry} />
        </PanelBody>
      </Panel>
    );
  }

  if (!explanation) {
    return (
      <Panel>
        <PanelHead title="Why this decision is flagged" icon={<IconBolt size={17} />} />
        <PanelBody>
          <EmptyState title={idleHeadline} icon={<IconLink size={26} />}>
            <p>{idleText}</p>
          </EmptyState>
        </PanelBody>
      </Panel>
    );
  }

  /**
   * At the baseline revision the backend answers honestly that nothing is
   * challenging the decision: `new_information` and `challenged_fact` come back
   * null. That is a real state and it gets a real screen, not a broken chain.
   */
  if (!explanation.new_information || !explanation.challenged_fact) {
    return (
      <Panel>
        <PanelHead
          icon={<IconInfo size={17} />}
          title="Nothing is challenging this decision"
          subtitle={explanation.headline}
          actions={<Chip title="Decision">{explanation.decision_id}</Chip>}
        />
        <PanelBody>
          <div className="stack stack--loose">
            <Callout tone="ok" title="No contradiction reaches this decision at the current revision">
              <p>
                No changed fact reaches this decision through the assumptions it depends on. That is the recorded state
                of the graph — it is not a guarantee that the real-world assumptions still hold.
              </p>
            </Callout>

            {explanation.uncertainty.length > 0 ? (
              <Callout tone="info" title="Stated uncertainty">
                <ul className="expl__list">
                  {explanation.uncertainty.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}

            {explanation.supporting_sources.length > 0 ? (
              <Section title={`Sources on record for this decision (${explanation.supporting_sources.length})`}>
                <ul className="list list--divided">
                  {explanation.supporting_sources.map((source) => (
                    <li key={source.id} className="list__item list__item--pad">
                      <button type="button" className="expl__source" onClick={() => onOpenSource(source.id)}>
                        <span className="row__grow">
                          <span className="small strong">{source.title}</span>
                          <span className="tiny muted">
                            {' '}
                            · {source.author_name ?? 'unknown author'} · {formatDateTime(source.timestamp)}
                          </span>
                        </span>
                        {source.simulated ? <Badge tone="warning">Simulated</Badge> : null}
                      </button>
                      <p className="quote small">{source.excerpt ?? source.text}</p>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {explanation.unavailable && explanation.unavailable.length > 0 ? (
              <Callout tone="neutral" title="Not available from the backend">
                <ul className="expl__list">
                  {explanation.unavailable.map((item, index) => (
                    <li key={index}>{item.replace(/_/g, ' ')}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}
          </div>
        </PanelBody>
        <PanelFoot>
          <IconInfo size={12} />
          <span>
            Generated by <span className="mono">{explanation.generated_by}</span> at{' '}
            {formatDateTime(explanation.generated_at)}. Trigger the Frankfurt scenario to see what changes when a fact
            is contradicted.
          </span>
        </PanelFoot>
      </Panel>
    );
  }

  const path: PathLike = explanation.path;
  const newInfo = explanation.new_information;
  const oldFact = explanation.challenged_fact;
  const assumption = explanation.connecting_assumption;

  return (
    <Panel>
      <PanelHead
        icon={<IconBolt size={17} />}
        title="Why this decision is flagged"
        subtitle={explanation.headline}
        actions={
          <>
            <Chip title="Decision being explained">{explanation.decision_id}</Chip>
            {onFocusChain ? (
              <Button size="sm" variant="ghost" onClick={onFocusChain}>
                Focus chain in graph
              </Button>
            ) : null}
          </>
        }
      />

      <PanelBody>
        <div className="stack stack--loose">
          {/* ------------------------------------------------------ the chain */}

          <Section title="Evidence chain, fact by fact">
            <ChainDiagram
              path={path}
              nodeIndex={nodeIndex}
              highlight={highlight}
              onSelect={onSelect}
            />
          </Section>

          {/* ----------------------------------------------------- why flagged */}

          {explanation.why_flagged.length > 0 ? (
            <Section title="Why the backend flagged it">
              <ol className="expl__reasons">
                {explanation.why_flagged.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ol>
            </Section>
          ) : null}

          {/* -------------------------------------------------- what changed */}

          <Section title="What changed, and what it replaced">
            <div className="expl__compare">
              <div className="expl__compare-card expl__compare-card--new">
                <span className="section__title">New information</span>
                <p className="small strong">{nodeIndex.get(newInfo.fact_id)?.label ?? newInfo.fact_id}</p>
                <p className="small">{newInfo.summary}</p>
                <div className="cluster">
                  <Badge tone="info">New fact</Badge>
                  <Chip title="Fact id">{newInfo.fact_id}</Chip>
                  <span className="tiny muted nowrap">Recorded {formatDateTime(newInfo.recorded_at)}</span>
                </div>
                {newInfo.source_id ? (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenSource(newInfo.source_id as string)}>
                    Open the source message
                  </button>
                ) : null}
              </div>

              <div className="expl__arrow" aria-hidden="true">
                <IconArrowRight size={18} />
                <span className="tiny muted">contradicts</span>
              </div>

              <div className="expl__compare-card expl__compare-card--old">
                <span className="section__title">What it contradicts</span>
                <p className="small strong">{oldFact.label}</p>
                {oldFact.statement ? <p className="small quote">{oldFact.statement}</p> : null}
                <div className="cluster">
                  <Badge tone="critical">Contradicted</Badge>
                  <Chip title="Fact id">{oldFact.id}</Chip>
                </div>
                <span className="tiny muted">
                  Held as true from {formatDateTime(oldFact.valid_from)}
                  {oldFact.valid_to
                    ? ` until ${formatDateTime(oldFact.valid_to)}`
                    : ' — no validity window was recorded'}
                </span>
              </div>
            </div>
          </Section>

          {/* --------------------------------------------------- the assumption */}

          <Section title="The assumption that carries the risk">
            {assumption ? (
              <div className="expl__assumption">
                <div className="row row--between row--wrap">
                  <span className="strong">{assumption.label}</span>
                  <span className="cluster">
                    <Badge tone={assumption.status === 'challenged' ? 'warning' : 'neutral'}>
                      {assumption.status}
                    </Badge>
                    {assumption.confidence !== null ? (
                      <span className="expl__assumption-meter">
                        <Meter value={assumption.confidence} label="Confidence in the connecting assumption" />
                      </span>
                    ) : null}
                  </span>
                </div>
                {assumption.statement ? <p className="small muted">{assumption.statement}</p> : null}
                <button type="button" className="chip chip--button" onClick={() => onSelect(assumption.id)}>
                  {assumption.id}
                </button>
              </div>
            ) : (
              <p className="small muted">
                The backend did not report a single connecting assumption for this chain — the exposure is carried
                through more than one relationship.
              </p>
            )}
          </Section>

          {/* ------------------------------------------------------ uncertainty */}

          {explanation.uncertainty.length > 0 ? (
            <Callout tone="warning" title="What Tripwire does not know">
              <ul className="expl__list">
                {explanation.uncertainty.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </Callout>
          ) : (
            <Callout tone="info" title="No recorded uncertainty">
              The backend reported no open uncertainty for this chain. Absence of a stated caveat is not proof the
              conclusion is complete.
            </Callout>
          )}

          {/* ------------------------------------------------ alternate evidence */}

          {explanation.alternate_evidence.length > 0 ? (
            <Section title="Alternate evidence that must be weighed">
              <ul className="expl__list expl__list--cards">
                {explanation.alternate_evidence.map((item) => (
                  <li key={item.fact_id}>
                    <div className="row row--between row--wrap">
                      <button
                        type="button"
                        className="chip chip--button"
                        onClick={() => onSelect(item.fact_id)}
                      >
                        {item.fact_id}
                      </button>
                      <Badge tone="warning">{item.effect.replace(/_/g, ' ')}</Badge>
                    </div>
                    {item.summary ? <p className="small">{item.summary}</p> : null}
                    {item.note ? <p className="tiny muted">{item.note}</p> : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {/* ------------------------------------------------------ investigators */}

          {explanation.suggested_investigators.length > 0 ? (
            <Section title="Who should look at this">
              <ul className="list list--divided">
                {explanation.suggested_investigators.map((person) => (
                  <li key={person.id} className="list__item list__item--pad">
                    <div className="row row--between row--wrap">
                      <button type="button" className="expl__person" onClick={() => onSelect(person.id)}>
                        {person.name}
                      </button>
                      <Badge tone={person.role === 'decision_owner' ? 'info' : 'brand'}>{person.role.replace(/_/g, ' ')}</Badge>
                    </div>
                    <p className="tiny muted">{person.reason}</p>
                    {person.uncertainty ? (
                      <p className="tiny muted">
                        <IconAlert size={12} /> {person.uncertainty}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {/* ---------------------------------------------------------- sources */}

          {explanation.supporting_sources.length > 0 ? (
            <Section title={`Supporting sources (${explanation.supporting_sources.length})`}>
              <ul className="list list--divided">
                {explanation.supporting_sources.map((source) => (
                  <li key={source.id} className="list__item list__item--pad">
                    <button type="button" className="expl__source" onClick={() => onOpenSource(source.id)}>
                      <span className="row__grow">
                        <span className="small strong">{source.title}</span>
                        <span className="tiny muted">
                          {' '}
                          · {source.author_name ?? 'unknown author'} · {formatDateTime(source.timestamp)}
                        </span>
                      </span>
                      {source.simulated ? <Badge tone="warning">Simulated</Badge> : null}
                    </button>
                    <p className="quote small">{source.excerpt ?? source.text}</p>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {explanation.unavailable && explanation.unavailable.length > 0 ? (
            <Callout tone="neutral" title="Not available from the backend">
              <ul className="expl__list">
                {explanation.unavailable.map((item, index) => (
                  <li key={index}>{item.replace(/_/g, ' ')}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
        </div>
      </PanelBody>

      <PanelFoot>
        <IconInfo size={12} />
        <span>
          Generated by <span className="mono">{explanation.generated_by}</span> at{' '}
          {formatDateTime(explanation.generated_at)}. Confidence values come from the backend; the UI does not recompute
          them.
        </span>
      </PanelFoot>
    </Panel>
  );
}

/**
 * The chain, drawn as a vertical stepper: node → relationship → node.
 * Each relationship states its own meaning, so the connection is explained.
 */
function ChainDiagram({
  path,
  nodeIndex,
  highlight,
  onSelect,
}: {
  path: PathLike;
  nodeIndex: Map<string, GraphNode>;
  highlight: PathHighlight | null;
  onSelect: (id: string) => void;
}) {
  if (!path.nodes || path.nodes.length === 0) {
    return <p className="small muted">The backend returned no evidence path for this decision.</p>;
  }

  const edgesByPair = new Map<string, PathLike['edges'][number]>();
  for (const edge of path.edges ?? []) {
    edgesByPair.set(`${edge.source}->${edge.target}`, edge);
    edgesByPair.set(`${edge.target}->${edge.source}`, edge);
  }

  return (
    <div className="expl__chain">
      {path.nodes.map((id, index) => {
        const node = nodeIndex.get(id);
        const previous = index > 0 ? path.nodes[index - 1] : null;
        const edge = previous ? edgesByPair.get(`${previous}->${id}`) : undefined;
        const meta = node ? NODE_TYPE_META[node.type] : null;
        const stateMeta = node ? NODE_STATE_META[node.state] : null;

        return (
          <div key={id} className="expl__chain-step">
            {edge ? (
              <div className="expl__hop">
                <span className="expl__hop-line" aria-hidden="true" />
                <span className="expl__hop-label">
                  <span className="mono">{edgeLabel(edge.type, edge.label)}</span>
                  <span className="tiny muted">{EDGE_TYPE_META[edge.type]?.description ?? ''}</span>
                </span>
              </div>
            ) : index === 0 ? (
              <div className="expl__hop expl__hop--start">
                <span className="expl__hop-label tiny muted">
                  {path.narration && path.narration[0] ? 'Starting point' : 'Starting point'}
                </span>
              </div>
            ) : null}

            <button
              type="button"
              className="expl__chain-node"
              onClick={() => onSelect(id)}
              data-on-chain={highlight?.nodeIds.has(id) ? 'true' : undefined}
            >
              {meta ? (
                <span
                  className={`legend__swatch legend__swatch--${meta.shape}`}
                  style={{ background: meta.hex }}
                  aria-hidden="true"
                />
              ) : null}
              <span className="row__grow">
                <span className="expl__chain-label">{node?.label ?? id}</span>
                <span className="tiny muted">
                  {node ? nodeTypeLabel(node.type) : 'Entity not in the current graph view'} · <span className="mono">{id}</span>
                </span>
              </span>
              {stateMeta && node && node.state !== 'normal' ? (
                <Badge tone={stateMeta.tone}>{stateMeta.label}</Badge>
              ) : null}
              {node?.confidence !== null && node?.confidence !== undefined ? (
                <span className="tiny faint mono">{formatPercent(node.confidence)}</span>
              ) : null}
            </button>
          </div>
        );
      })}

      {path.narration && path.narration.length > 0 ? (
        <div className="expl__narration">
          <span className="section__title">In the backend's own words</span>
          <ol>
            {path.narration.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ol>
          {path.hops !== undefined ? (
            <span className="tiny muted">
              {path.hops} hop{path.hops === 1 ? '' : 's'} between the changed fact and the decision.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
