/**
 * Evidence & Provenance — the verbatim source records the backend used, the
 * selected artifact in full, and the provenance chain of the inspected fact.
 * Simulated records stay labelled as simulated.
 */

import { useMemo } from 'react';
import type { ShellContext } from '../App';
import { Callout, Panel, PanelBody, PanelHead } from '../components/common';
import { IconDoc } from '../components/common/Icons';
import { ProvenanceChain } from '../components/evidence/ProvenanceChain';
import { SourceCard, SourceList } from '../components/evidence/SourceEvidence';

export function EvidencePage({ ctx }: { ctx: ShellContext }) {
  const { tw } = ctx;

  const evidenceSources = useMemo(() => {
    const fromExplanation = tw.explanation.data?.supporting_sources ?? [];
    if (fromExplanation.length > 0) return fromExplanation;
    const fromFact = tw.factDetail.data?.sources ?? [];
    if (fromFact.length > 0) return fromFact;
    if (tw.lastTrigger?.source) return [tw.lastTrigger.source];
    return [];
  }, [tw.explanation.data, tw.factDetail.data, tw.lastTrigger]);

  const selectedSource = useMemo(() => {
    if (!tw.selectedSourceId) return null;
    return (
      evidenceSources.find((source) => source.id === tw.selectedSourceId) ??
      tw.sourceDetail.data?.source ??
      null
    );
  }, [tw.selectedSourceId, evidenceSources, tw.sourceDetail.data]);

  return (
    <div className="stack stack--loose evidence-page">
      <Panel>
        <PanelHead
          icon={<IconDoc size={17} />}
          title="Source evidence"
          subtitle="The verbatim records the backend used. Simulated records are labelled as such."
        />
        <PanelBody tight>
          <SourceList
            sources={evidenceSources}
            emptyTitle="No source records for the current selection"
            emptyText="Trigger a scenario in the Scenario Lab, or explain a decision, to see the messages, tickets and documents behind it."
            selectedSourceId={tw.selectedSourceId}
            onSelect={(source) => tw.openSource(source.id)}
          />
        </PanelBody>
      </Panel>

      {selectedSource ? (
        <SourceCard
          source={selectedSource}
          detail={tw.sourceDetail.data}
          onSelectEntity={ctx.inspectNode}
          onClose={tw.closeSource}
        />
      ) : null}

      <ProvenanceChain
        chain={tw.provenance.data?.chain ?? []}
        factId={tw.provenance.data?.fact_id}
        loading={tw.provenance.loading}
        error={tw.provenance.error}
      />

      {tw.factDetail.data ? (
        <Callout tone="info" title="Both time axes are kept apart">
          The inspected fact records when Tripwire <strong>believed</strong> it (recorded) separately
          from when it was claimed <strong>true in the world</strong> (valid). A future{' '}
          <span className="mono">valid_to</span> is a scheduled expiry, not a present invalidation.
        </Callout>
      ) : null}
    </div>
  );
}
