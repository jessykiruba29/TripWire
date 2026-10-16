/**
 * Provenance chain: how Tripwire got from a recorded source to a business decision.
 *
 * The four levels are ordered by `PROVENANCE_KIND_META[kind].order`, so the chain can
 * never drift out of step with the shared vocabulary. The distinction the product
 * cares about most — a `system_interpretation` is a machine conclusion, not something
 * a person said — is carried by the badge, the tinted body and an explicit sentence,
 * never by colour alone.
 */

import type { ProvenanceStep } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { provenanceKindMeta } from '../../lib/vocabulary';
import { Badge, EmptyState, ErrorState, LoadingState, Meter, Section, SimulatedTag } from '../common';
import './evidence.css';

const UNAVAILABLE = 'Not available from the backend';

export function ProvenanceChain({
  chain,
  factId,
  loading,
  error,
}: {
  chain: ProvenanceStep[];
  factId?: string;
  loading?: boolean;
  error?: { message: string; code?: string; status?: number } | null;
}): JSX.Element {
  if (loading) {
    return <LoadingState label="Loading provenance chain…" />;
  }

  if (error) {
    return <ErrorState title="Provenance could not be loaded" error={error} />;
  }

  if (chain.length === 0) {
    return (
      <EmptyState title="No provenance chain">
        No provenance steps were returned{factId ? ` for ${factId}` : ''}.
      </EmptyState>
    );
  }

  const ordered = [...chain].sort(
    (a, b) => provenanceKindMeta(a.kind).order - provenanceKindMeta(b.kind).order,
  );

  return (
    <Section title={factId ? `Provenance · ${factId}` : 'Provenance'}>
      <ol
        className="ev-chain"
        aria-label="Provenance chain, ordered from original source to business decision"
      >
        {ordered.map((step, index) => (
          <ProvenanceStepItem key={`${step.kind}-${index}`} step={step} />
        ))}
      </ol>
    </Section>
  );
}

function ProvenanceStepItem({ step }: { step: ProvenanceStep }): JSX.Element {
  const meta = provenanceKindMeta(step.kind);
  const machineDerived = step.kind === 'system_interpretation';

  return (
    <li className={`ev-step ev-step--${step.kind}${machineDerived ? ' ev-step--machine' : ''}`}>
      <span className="ev-step__marker" aria-hidden="true">
        {meta.order}
      </span>

      <div className="ev-step__body">
        <div className="ev-step__head">
          <Badge tone={meta.tone}>
            Level {meta.order} of 4 · {meta.label}
          </Badge>
          {machineDerived ? (
            <Badge tone="warning" outline title="Derived by Tripwire from the extracted claim.">
              Machine-derived conclusion
            </Badge>
          ) : null}
          {step.simulated === true ? <SimulatedTag simulated /> : null}
        </div>

        <p className="ev-step__desc muted small">{meta.description}</p>
        <p className="ev-step__label strong">{step.label}</p>

        {step.text ? (
          <blockquote className="quote ev-verbatim">{step.text}</blockquote>
        ) : step.note ? (
          <p className="ev-step__note muted small">{step.note}</p>
        ) : null}

        {machineDerived ? (
          <p className="ev-step__machine-note small">
            This is Tripwire&rsquo;s derived conclusion. It was not written by a person.
          </p>
        ) : null}

        <p className="ev-step__meta muted tiny">
          <span>
            {machineDerived ? 'Derived by' : 'Actor'}: {step.actor ? step.actor : UNAVAILABLE}
          </span>
          <span title={step.at}>{formatDateTime(step.at)}</span>
          {step.method ? <span className="mono">{step.method}</span> : null}
          <span className="mono" title={step.ref_id}>
            {step.ref_id}
          </span>
        </p>

        {typeof step.confidence === 'number' ? (
          <div className="ev-step__confidence">
            <Meter value={step.confidence} label={`${meta.label} confidence`} />
          </div>
        ) : null}
      </div>
    </li>
  );
}
