/**
 * Tripwire application shell.
 *
 * Layout intent: the graph is the centre of the product, the decisions and the
 * explanation sit directly under it so the causal story reads top-to-bottom
 * without scrolling sideways, and the right rail holds the deeper detail
 * (inspection, evidence, people, history, alerts) on demand.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { indexNodes } from './lib/graph';
import { useTripwire } from './state/useTripwire';
import { Badge, Callout, ErrorState, Panel, PanelBody, PanelHead, Tabs, type TabItem } from './components/common';
import { IconDoc, IconHistory, IconLink, IconUser } from './components/common/Icons';
import { AppHeader, TripwireMark } from './components/layout/AppHeader';
import { ScenarioPanel, type StoryStepId } from './components/demo/ScenarioPanel';
import { GraphPanel } from './components/graph/GraphPanel';
import { DecisionPanel } from './components/decisions/DecisionPanel';
import { ExplanationPanel } from './components/explanation/ExplanationPanel';
import { NodeInspector } from './components/inspector/NodeInspector';
import { SourceCard, SourceList } from './components/evidence/SourceEvidence';
import { ProvenanceChain } from './components/evidence/ProvenanceChain';
import { ExpertPanel } from './components/people/ExpertPanel';
import { HistoryPanel } from './components/history/HistoryPanel';
import { TimelineFeed } from './components/history/TimelineFeed';
import { AlertReviewPanel } from './components/alerts/AlertReviewPanel';
import './styles/app.css';

type RailTab = 'inspect' | 'evidence' | 'people' | 'history' | 'alerts';

export function App() {
  const tw = useTripwire();
  const [tab, setTab] = useState<RailTab>('inspect');
  const [reloadBusy, setReloadBusy] = useState(false);
  const scenarioRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<HTMLDivElement | null>(null);
  const railPanelRef = useRef<HTMLDivElement | null>(null);

  const nodeIndex = useMemo(() => indexNodes(tw.graph.data?.nodes ?? []), [tw.graph.data]);

  /* ------------------------------------------------------------- actions */

  const scrollTo = (ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    ref.current?.focus?.();
  };

  const handleRunScenario = useCallback(async () => {
    const text = tw.demoState.data?.storyline.trigger_text ?? '';
    scrollTo(scenarioRef);
    await tw.triggerDemo({
      scenario: tw.scenario ?? undefined,
      text: text || undefined,
      channel: 'slack',
    });
  }, [tw]);

  const handleReset = useCallback(async () => {
    await tw.resetDemo();
    setTab('inspect');
  }, [tw]);

  const handleSelect = useCallback(
    (id: string | null) => {
      tw.selectNode(id);
      if (id) setTab('inspect');
    },
    [tw],
  );

  const handleExplain = useCallback(
    async (decisionId: string) => {
      await tw.showExplanation(decisionId);
      setTab('inspect');
    },
    [tw],
  );

  const handleOpenSource = useCallback(
    (sourceId: string) => {
      tw.openSource(sourceId);
      setTab('evidence');
      railPanelRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' });
    },
    [tw],
  );

  const handleStep = useCallback(
    (step: StoryStepId) => {
      switch (step) {
        case 'event': {
          const sourceId = tw.lastTrigger?.source?.id ?? tw.lastTrigger?.event.source_id;
          if (sourceId) handleOpenSource(sourceId);
          break;
        }
        case 'contradiction': {
          const factId = tw.lastTrigger?.extraction?.contradicted_fact?.id;
          if (factId) {
            tw.selectNode(factId);
            setTab('evidence');
          }
          break;
        }
        case 'propagation': {
          setTab('inspect');
          scrollTo(graphRef);
          break;
        }
        case 'path': {
          scrollTo(graphRef);
          break;
        }
        case 'review': {
          const decisionId = tw.lastTrigger?.propagation.decisions[0]?.id ?? tw.demoState.data?.storyline.decision_id;
          if (decisionId) await_void(tw.showExplanation(decisionId));
          setTab('inspect');
          break;
        }
        case 'expert': {
          setTab('people');
          break;
        }
        case 'history': {
          setTab('history');
          break;
        }
      }
    },
    [tw, handleOpenSource],
  );

  const handleReload = useCallback(async () => {
    setReloadBusy(true);
    tw.reloadAll();
    await new Promise((resolve) => setTimeout(resolve, 350));
    setReloadBusy(false);
  }, [tw]);

  /* ------------------------------------------------------------- evidence */

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

  /* ---------------------------------------------------------------- boot */

  if (tw.connecting) {
    return (
      <div className="boot">
        <div className="boot__mark">
          <TripwireMark size={38} />
          <span className="boot__title">Tripwire</span>
        </div>
        <div className="loading-row">
          <span className="spinner" />
          <span>Resolving the backend connection…</span>
        </div>
      </div>
    );
  }

  if (tw.fatalError) {
    return (
      <div className="boot">
        <div className="boot__mark">
          <TripwireMark size={38} />
          <span className="boot__title">Tripwire</span>
        </div>
        <p className="boot__text">
          {tw.connection?.reason ??
            'Tripwire could not reach a backend and could not fall back to the in-browser reference engine.'}
        </p>
        <ErrorState
          title="No data source available"
          error={tw.fatalError}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  const railTabs: TabItem[] = [
    {
      id: 'inspect',
      label: (
        <>
          <IconLink size={13} /> Inspect
        </>
      ),
    },
    {
      id: 'evidence',
      label: (
        <>
          <IconDoc size={13} /> Evidence
        </>
      ),
      count: evidenceSources.length,
    },
    {
      id: 'people',
      label: (
        <>
          <IconUser size={13} /> People
        </>
      ),
    },
    {
      id: 'history',
      label: (
        <>
          <IconHistory size={13} /> History
        </>
      ),
    },
    { id: 'alerts', label: 'Alerts', count: tw.alerts.data?.alerts.length ?? 0 },
  ];

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to the main content
      </a>

      <AppHeader
        health={tw.health.data}
        connection={tw.connection}
        onReload={handleReload}
        reloadBusy={reloadBusy}
        onRunScenario={handleRunScenario}
        onReset={handleReset}
        resetBusy={tw.resetBusy}
        scenarioApplied={Boolean(tw.lastTrigger)}
      />

      <div className="app__body">
        <main className="app__main" id="main">
          <div ref={scenarioRef} tabIndex={-1} className="anchor-target" data-testid="scenario-panel">
            <ScenarioPanel
              demoState={tw.demoState.data}
              trigger={tw.lastTrigger}
              triggerBusy={tw.triggerBusy}
              triggerError={tw.triggerError}
              resetBusy={tw.resetBusy}
              resetError={tw.resetError}
              onTrigger={(input) => {
                void tw.triggerDemo(input);
              }}
              onReset={() => {
                void handleReset();
              }}
              onStep={(step) => {
                void handleStep(step);
              }}
              expertAvailable={Boolean(tw.experts.data && tw.experts.data.experts.length > 0)}
              historyAvailable={Boolean(tw.history.data)}
              isReal={tw.isReal}
              scenarioTrigger={Boolean(tw.capabilities?.scenarioTrigger)}
              scenarios={tw.demoScenarios.data ?? []}
              scenario={tw.scenario}
              onScenarioChange={tw.setScenario}
            />
          </div>

          {tw.demoState.error ? (
            <Callout tone="warning" title="Demo state is unavailable">
              {tw.demoState.error.message} The graph and decisions below may be stale.
            </Callout>
          ) : null}

          {tw.emptyBackend ? (
            <Callout tone="warning" title="The backend is reachable but returned no graph data">
              <p>
                The real backend answered <span className="mono">GET /api/graph</span> with 0 nodes. It reports{' '}
                <span className="mono">seeded: false</span> or the store was cleared. Run{' '}
                <span className="mono">POST /api/demo/seed</span> (or use Reset above) before the demo.
              </p>
            </Callout>
          ) : null}

          {tw.seededOnBoot ? (
            <Callout tone="info" title="Dataset seeded on startup">
              The backend store was empty, so the Northwind Labs dataset was seeded before the graph was read.
            </Callout>
          ) : null}

          <div ref={graphRef} tabIndex={-1} className="anchor-target" data-testid="graph-panel">
            <GraphPanel
              graph={tw.graph.data}
              loading={tw.graph.loading}
              error={tw.graph.error}
              onRetry={tw.graph.reload}
              selectedId={tw.selectedNodeId}
              highlight={tw.highlight}
              onSelect={handleSelect}
              pathLabel={tw.pathLabel}
            />
          </div>

          <div className="app__grid">
            <div data-testid="decision-panel">
              <DecisionPanel
              decisions={tw.decisions.data?.decisions ?? tw.affectedDecisions}
              trigger={tw.lastTrigger}
              loading={tw.decisions.loading}
              error={tw.decisions.error}
              onRetry={tw.decisions.reload}
              selectedId={tw.selectedNodeId}
              onSelectDecision={(id) => tw.selectNode(id)}
              onExplain={(id) => {
                void handleExplain(id);
              }}
                explanationDecisionId={tw.explanation.data?.decision_id ?? null}
                graphRevision={tw.graph.data?.revision}
              />
            </div>

            <div data-testid="explanation-panel">
              <ExplanationPanel
              explanation={tw.explanation.data}
              loading={tw.explanation.loading}
              error={tw.explanation.error}
              onRetry={tw.explanation.reload}
              nodeIndex={nodeIndex}
              highlight={tw.highlight}
              onSelect={(id) => tw.selectNode(id)}
              onFocusChain={() => scrollTo(graphRef)}
              onOpenSource={handleOpenSource}
                idleHeadline={
                  tw.lastTrigger ? 'Pick a decision to explain' : 'No decision is being explained yet'
                }
              />
            </div>
          </div>
        </main>

        <aside className="app__rail" aria-label="Detail panels">
          <div className="rail">
            <Tabs
              items={railTabs}
              active={tab}
              onChange={(id) => setTab(id as RailTab)}
              variant="rail"
              label="Detail panels"
            />
            <div
              className="rail__panel"
              ref={railPanelRef}
              role="tabpanel"
              id={`tabpanel-${tab}`}
              aria-labelledby={`tab-${tab}`}
              tabIndex={0}
            >
              {tab === 'inspect' ? (
                <NodeInspector
                  node={tw.selectedNode}
                  graph={tw.graph.data}
                  highlight={tw.highlight}
                  pathLabel={tw.pathLabel}
                  onSelect={handleSelect}
                  onOpenSource={handleOpenSource}
                  factDetail={tw.factDetail.data}
                  decisionDetail={tw.decisionDetail.data}
                  personDetail={tw.personDetail.data}
                  loadingDetail={
                    tw.factDetail.loading || tw.decisionDetail.loading || tw.personDetail.loading
                  }
                  onShowExplanation={(id) => {
                    void handleExplain(id);
                  }}
                  onShowProvenance={() => setTab('evidence')}
                />
              ) : null}

              {tab === 'evidence' ? (
                <div className="stack stack--loose">
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
                        emptyText="Trigger the scenario, or select a fact, to see the messages, tickets and documents behind it."
                        selectedSourceId={tw.selectedSourceId}
                        onSelect={(source) => tw.openSource(source.id)}
                      />
                    </PanelBody>
                  </Panel>

                  {selectedSource ? (
                    <SourceCard
                      source={selectedSource}
                      detail={tw.sourceDetail.data}
                      onSelectEntity={(id) => {
                        tw.selectNode(id);
                        setTab('inspect');
                      }}
                      onClose={tw.closeSource}
                    />
                  ) : null}

                  <ProvenanceChain
                    chain={tw.provenance.data?.chain ?? []}
                    factId={tw.provenance.data?.fact_id}
                    loading={tw.provenance.loading}
                    error={tw.provenance.error}
                  />
                </div>
              ) : null}

              {tab === 'people' ? (
                <div className="stack stack--loose">
                  <Panel>
                    <PanelHead
                      icon={<IconUser size={17} />}
                      title="Who has done the work"
                      subtitle={
                        tw.capabilities?.expertsQuery
                          ? 'Ranked on recorded contribution. The backend resolves the target from free text, so search for a system, project or topic.'
                          : 'Ranked on recorded contribution to the affected system.'
                      }
                    />
                    <PanelBody tight>
                      {tw.capabilities?.expertsQuery ? (
                        <label className="stack stack--tight">
                          <span className="tiny muted">Search for a system, project or decision</span>
                          <input
                            type="search"
                            className="app__select"
                            value={tw.expertsQuery}
                            onChange={(event) => tw.setExpertsQuery(event.target.value)}
                            placeholder="e.g. Frankfurt Hosting Partner"
                            aria-label="Search for who has worked on a system, project or decision"
                          />
                          <span className="tiny muted">
                            Sent as <span className="mono">GET /api/experts?q=…</span>
                          </span>
                        </label>
                      ) : (
                        <label className="stack stack--tight">
                          <span className="tiny muted">System to rank expertise for</span>
                          <select
                            className="app__select"
                            value={''}
                            onChange={() => undefined}
                            aria-label="System to rank expertise for"
                          >
                            <option value="">Default for the current scenario</option>
                            {(tw.systems.data?.systems ?? []).map((system) => (
                              <option key={system.id} value={system.id}>
                                {system.title}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </PanelBody>
                  </Panel>

                  <ExpertPanel
                    response={tw.experts.data}
                    loading={tw.experts.loading}
                    error={tw.experts.error}
                    onSelectPerson={(id) => {
                      tw.selectNode(id);
                      setTab('inspect');
                    }}
                  />
                </div>
              ) : null}

              {tab === 'history' ? (
                <div className="stack stack--loose">
                  <Panel>
                    <PanelHead
                      icon={<IconHistory size={17} />}
                      title="What the company believed, and when"
                      subtitle="Recorded-time history. Tripwire never re-stamps today's graph onto the past."
                    />
                  </Panel>
                  <HistoryPanel
                    history={tw.history.data}
                    asOf={tw.asOf}
                    onAsOfChange={tw.setAsOfDate}
                    minDate={tw.historyBounds.minDate}
                    maxDate={tw.historyBounds.maxDate}
                    onSelectEntity={(id) => {
                      tw.selectNode(id);
                      setTab('inspect');
                    }}
                    onResetToNow={tw.resetAsOf}
                    loading={tw.history.loading}
                    error={tw.history.error}
                  />
                  <TimelineFeed
                    entries={tw.timeline.data?.events ?? []}
                    loading={tw.timeline.loading}
                    error={tw.timeline.error}
                    onSelectEntity={(id) => {
                      tw.selectNode(id);
                      setTab('inspect');
                    }}
                    emptyTitle="No recorded activity"
                    limit={30}
                  />
                </div>
              ) : null}

              {tab === 'alerts' ? (
                <div className="stack stack--loose">
                  {tw.reviewNotice ? (
                    <Callout
                      tone={
                        tw.reviewNotice.kind === 'changed'
                          ? 'ok'
                          : tw.reviewNotice.kind === 'noop'
                            ? 'warning'
                            : 'critical'
                      }
                      title={
                        tw.reviewNotice.kind === 'changed'
                          ? 'Review recorded by the backend'
                          : tw.reviewNotice.kind === 'noop'
                            ? 'No change was made'
                            : 'Review not confirmed'
                      }
                    >
                      {tw.reviewNotice.message}
                    </Callout>
                  ) : null}
                  <AlertReviewPanel
                  response={tw.alerts.data}
                  loading={tw.alerts.loading}
                  error={tw.alerts.error}
                  onReview={(alertId, status, note) => {
                    void tw.reviewAlert(alertId, status, note);
                  }}
                  busyAlertId={tw.reviewBusyAlertId}
                  reviewError={tw.reviewError}
                  onSelectDecision={(id) => {
                    tw.selectNode(id);
                    setTab('inspect');
                  }}
                    onSelectEntity={(id) => {
                      tw.selectNode(id);
                      setTab('inspect');
                    }}
                  />
                </div>
              ) : null}

              {tab === 'inspect' && !tw.selectedNode ? (
                <div className="stack stack--tight" style={{ marginTop: 'var(--sp-4)' }}>
                  <Badge tone="neutral" outline>
                    Tip
                  </Badge>
                  <p className="tiny muted">
                    Select a node in the graph, or a decision above, to see its record and every relationship behind it.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Fire-and-forget an async handler from a click path without leaking a floating promise. */
function await_void(promise: Promise<unknown>): void {
  void promise;
}
