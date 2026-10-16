/**
 * Application data layer.
 *
 * One hook owns every backend read and write, so no component fetches and no
 * component has to reason about loading/error/empty states individually.
 *
 * Rules encoded here:
 *  - the real backend is seeded before the first graph read (see `connect`)
 *  - a write is only reflected after the backend confirmed it, and a review the
 *    server treated as a no-op is reported as a no-op, never as a change
 *  - the backend's own `impacts` are the authoritative propagation result; the
 *    frontend does not recompute propagation from the graph
 *  - mock mode is never upgraded to look like live data
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { connect, DEMO_SCENARIOS, TripwireApiError, type ApiConnection, type SourceDetailLike } from '../api';
import type {
  Alert,
  AlertStatus,
  DecisionDetail,
  DecisionSummary,
  DemoState,
  Explanation,
  FactDetail,
  GraphResponse,
  HealthResponse,
  HistoryResponse,
  NodeType,
  PersonDetail,
  ProvenanceStep,
  PropagationDecision,
  TimelineResponse,
  TriggerEventResponse,
} from '../api/types';
import { affectedNodeIds, indexNodes, pathHighlight, type PathHighlight } from '../lib/graph';
import { toDayStartIso, toDateInputValue } from '../lib/format';
import { useMutation, useResource, type Resource } from './useResource';

export interface PathSelection {
  highlight: PathHighlight | null;
  label: string;
  /** Where the chain came from — the UI labels the difference. */
  origin: 'trigger' | 'explanation' | 'manual' | null;
}

/** The outcome of a review action, including the case where nothing changed. */
export interface ReviewNotice {
  alertId: string;
  kind: 'changed' | 'noop' | 'failed';
  message: string;
}

export function useTripwire() {
  /* ------------------------------------------------------------ connection */

  const [connection, setConnection] = useState<ApiConnection | null>(null);
  const [connectionError, setConnectionError] = useState<TripwireApiError | null>(null);
  const [connecting, setConnecting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    connect().then(
      (result) => {
        if (cancelled) return;
        setConnection(result);
        setConnecting(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        setConnectionError(
          error instanceof TripwireApiError
            ? error
            : new TripwireApiError(0, 'internal_error', String((error as Error)?.message ?? error)),
        );
        setConnecting(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const client = connection?.client ?? null;
  const capabilities = connection?.client.capabilities ?? null;
  const [dataVersion, setDataVersion] = useState(0);
  const bumpData = useCallback(() => setDataVersion((v) => v + 1), []);

  /* -------------------------------------------------------------- resources */

  const enabled = Boolean(client);
  const health = useResource<HealthResponse>(() => client!.health(), [client, dataVersion], enabled);
  const demoState = useResource<DemoState>(() => client!.demoState(), [client, dataVersion], enabled);
  const graph = useResource<GraphResponse>(() => client!.graph(), [client, dataVersion], enabled);
  const decisions = useResource<{ decisions: DecisionSummary[]; total: number }>(
    () => client!.decisions(),
    [client, dataVersion],
    enabled,
  );
  const alerts = useResource(() => client!.alerts(), [client, dataVersion], enabled);
  const timeline = useResource<TimelineResponse>(() => client!.timeline(40), [client, dataVersion], enabled);
  const systems = useResource(() => client!.systems(), [client, dataVersion], enabled);
  const demoScenarios = useResource<Array<{ id: string; description?: string }>>(
    async () => (client?.scenarios ? client.scenarios() : DEMO_SCENARIOS.map((id) => ({ id }))),
    [client],
    enabled,
  );

  /* -------------------------------------------------------------- selection */

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [path, setPath] = useState<PathSelection>({ highlight: null, label: '', origin: null });
  const [lastTrigger, setLastTrigger] = useState<TriggerEventResponse | null>(null);
  const [expertsQuery, setExpertsQuery] = useState<string | null>(null);
  const [scenario, setScenario] = useState<string | null>(null);

  const nodeIndex = useMemo(() => indexNodes(graph.data?.nodes ?? []), [graph.data]);
  const selectedNode = selectedNodeId ? nodeIndex.get(selectedNodeId) ?? null : null;
  const highlight = path.highlight;

  /* ---------------------------------------------------------------- details */

  const selectedType = selectedNode?.type ?? null;

  const [explanationDecisionId, setExplanationDecisionId] = useState<string | null>(null);

  const explanation = useResource<Explanation>(
    () => client!.explanation(explanationDecisionId!),
    [client, explanationDecisionId],
    enabled && Boolean(explanationDecisionId),
  );

  /**
   * Which fact the evidence chain should describe. Prefers an explicitly selected
   * fact, then the fact the current explanation is about.
   */
  const factOfInterestId = useMemo(() => {
    if (selectedType === 'fact' && selectedNodeId) return selectedNodeId;
    return explanation.data?.new_information?.fact_id ?? null;
  }, [selectedType, selectedNodeId, explanation.data]);

  const factDetail = useResource<FactDetail>(
    () => client!.fact(selectedNodeId!),
    [client, selectedNodeId],
    enabled && selectedType === 'fact',
  );

  const provenance = useResource<{ fact_id: string; chain: ProvenanceStep[] }>(
    () => client!.provenance(factOfInterestId!),
    [client, factOfInterestId],
    enabled && Boolean(factOfInterestId),
  );

  const decisionDetail = useResource<DecisionDetail>(
    () => client!.decision(selectedNodeId!),
    [client, selectedNodeId],
    enabled && selectedType === 'decision',
  );

  const personDetail = useResource<PersonDetail>(
    () => client!.person(selectedNodeId!),
    [client, selectedNodeId],
    enabled && selectedType === 'person',
  );

  const sourceDetail = useResource<SourceDetailLike>(
    () => client!.source(selectedSourceId!),
    [client, selectedSourceId],
    enabled && Boolean(selectedSourceId),
  );

  /* ----------------------------------------------------------------- history */

  const demoClock = demoState.data?.demo_clock ?? health.data?.time ?? new Date().toISOString();
  const [asOf, setAsOf] = useState<string>(() => toDateInputValue(new Date().toISOString()));
  const [asOfTouched, setAsOfTouched] = useState(false);

  useEffect(() => {
    if (!asOfTouched && demoClock) setAsOf(toDateInputValue(demoClock));
  }, [demoClock, asOfTouched]);

  const historyBounds = useMemo(() => {
    const stamps: string[] = [];
    for (const node of graph.data?.nodes ?? []) {
      if (node.valid_from) stamps.push(node.valid_from);
      if (node.recorded_at) stamps.push(node.recorded_at);
    }
    if (lastTrigger?.event.occurred_at) stamps.push(lastTrigger.event.occurred_at);
    if (lastTrigger?.event.recorded_at) stamps.push(lastTrigger.event.recorded_at);
    const times = stamps.map((s) => new Date(s).getTime()).filter((t) => Number.isFinite(t));
    if (times.length === 0) return { minDate: undefined, maxDate: undefined };
    return {
      minDate: toDateInputValue(new Date(Math.min(...times)).toISOString()),
      maxDate: toDateInputValue(new Date(Math.max(...times)).toISOString()),
    };
  }, [graph.data, lastTrigger]);

  const history = useResource<HistoryResponse>(
    () => client!.history({ at: toDayStartIso(asOf) }),
    [client, asOf, dataVersion],
    enabled && Boolean(asOf),
  );

  /* ------------------------------------------------------------ expert target */

  /**
   * The real backend resolves an expert target from free text. Prefer an explicit
   * search, then a system selected in the UI, then the system the event touched.
   */
  const defaultExpertsQuery = useMemo(() => {
    if (lastTrigger) {
      const systemImpact = lastTrigger.entity_impacts?.find(
        (impact) => nodeIndex.get(impact.id)?.type === 'system',
      );
      if (systemImpact) return systemImpact.label;
      const assumptionId = lastTrigger.propagation.assumptions[0]?.id;
      const fromAssumption = assumptionId
        ? graph.data?.edges.find((edge) => edge.source === assumptionId || edge.target === assumptionId)
        : undefined;
      const peerId = fromAssumption
        ? fromAssumption.source === assumptionId
          ? fromAssumption.target
          : fromAssumption.source
        : undefined;
      const peer = peerId ? nodeIndex.get(peerId) : undefined;
      if (peer?.type === 'system') return peer.label;
    }
    if (selectedNode?.type === 'system') return selectedNode.label;
    const graphNodes = graph.data?.nodes ?? [];
    const attention = affectedNodeIds(graphNodes);
    const systemsByName = graphNodes.filter((node) => node.type === 'system');
    for (const system of systemsByName) {
      const connects = (graph.data?.edges ?? []).some(
        (edge) =>
          (edge.source === system.id && attention.has(edge.target)) ||
          (edge.target === system.id && attention.has(edge.source)),
      );
      if (connects) return system.label;
    }
    return systemsByName[0]?.label ?? '';
  }, [lastTrigger, graph.data, selectedNode, nodeIndex]);

  const effectiveExpertsQuery = expertsQuery ?? defaultExpertsQuery;

  /** The reference engine takes a system id rather than free text. */
  const defaultSystemId = useMemo(() => {
    const graphNodes = graph.data?.nodes ?? [];
    if (selectedNode?.type === 'system') return selectedNode.id;
    if (lastTrigger) {
      const linked = lastTrigger.extraction?.linked_entities ?? [];
      const systemId = linked.find((id) => nodeIndex.get(id)?.type === 'system');
      if (systemId) return systemId;
    }
    const attention = affectedNodeIds(graphNodes);
    for (const system of graphNodes.filter((node) => node.type === 'system')) {
      const connects = (graph.data?.edges ?? []).some(
        (edge) =>
          (edge.source === system.id && attention.has(edge.target)) ||
          (edge.target === system.id && attention.has(edge.source)),
      );
      if (connects) return system.id;
    }
    return undefined;
  }, [graph.data, selectedNode, lastTrigger, nodeIndex]);

  const usesQuery = Boolean(capabilities?.expertsQuery);

  const experts = useResource(
    () =>
      client!.experts(usesQuery ? { q: effectiveExpertsQuery, limit: 5 } : { system_id: defaultSystemId, limit: 5 }),
    [client, effectiveExpertsQuery, usesQuery, defaultSystemId, dataVersion],
    enabled && (usesQuery ? Boolean(effectiveExpertsQuery) : true),
  );

  /* --------------------------------------------------------------- mutations */

  const trigger = useMutation();
  const reset = useMutation();
  const review = useMutation();
  const [reviewBusyAlertId, setReviewBusyAlertId] = useState<string | null>(null);
  const [reviewNotice, setReviewNotice] = useState<ReviewNotice | null>(null);

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    if (!nodeId) setSelectedSourceId(null);
  }, []);

  const openSource = useCallback((sourceId: string) => {
    setSelectedSourceId(sourceId);
    setSelectedNodeId(sourceId);
  }, []);

  const closeSource = useCallback(() => setSelectedSourceId(null), []);

  const showExplanation = useCallback(async (decisionId: string) => {
    setExplanationDecisionId(decisionId);
    setSelectedNodeId(decisionId);
  }, []);

  // When an explanation arrives, promote its path to the highlighted chain.
  useEffect(() => {
    const data = explanation.data;
    if (!data || data.decision_id !== explanationDecisionId) return;
    const computed = pathHighlight(graph.data?.nodes ?? [], graph.data?.edges ?? [], data.path);
    if (!computed) return;
    setPath({ highlight: computed, label: data.headline, origin: 'explanation' });
  }, [explanation.data, explanationDecisionId, graph.data]);

  const clearPath = useCallback(() => setPath({ highlight: null, label: '', origin: null }), []);

  /**
   * Trigger the demo event.
   *
   * The real backend takes a scenario id; the reference engine takes free text. Both
   * are supplied so one call works against either, without the UI branching on mode.
   */
  const triggerDemo = useCallback(
    async (input: { scenario?: string; text?: string; channel?: string } = {}) => {
      if (!client || trigger.busy) return null;
      setReviewNotice(null);

      const result = await trigger.run(() =>
        client.triggerEvent({
          scenario: input.scenario ?? scenario ?? undefined,
          text: input.text,
          channel: input.channel ?? 'slack',
        }),
      );
      if (!result) return null;

      setLastTrigger(result);

      const computed = pathHighlight(graph.data?.nodes ?? [], graph.data?.edges ?? [], result.path);
      setPath({
        highlight: computed,
        label: result.explanation?.headline ?? result.event.summary,
        origin: 'trigger',
      });

      const newFactId = result.extraction?.new_fact?.id;
      if (newFactId) setSelectedNodeId(newFactId);

      // Prefer the backend's own idea of which decision needs a human.
      const primary =
        result.propagation.decisions.find((decision) => decision.requires_investigation) ??
        result.propagation.decisions[0];
      if (primary) setExplanationDecisionId(primary.id);

      bumpData();
      return result;
    },
    [client, trigger, graph.data, bumpData, scenario],
  );

  const resetDemo = useCallback(async () => {
    if (!client || reset.busy) return null;
    const result = await reset.run(() => client.resetDemo());
    if (!result) return null;
    setLastTrigger(null);
    setPath({ highlight: null, label: '', origin: null });
    setSelectedNodeId(null);
    setSelectedSourceId(null);
    setExplanationDecisionId(null);
    setExpertsQuery(null);
    setReviewNotice(null);
    setAsOfTouched(false);
    if (result.demo_state) demoState.set(result.demo_state);
    bumpData();
    return result;
  }, [client, reset, demoState, bumpData]);

  /**
   * Apply a review transition.
   *
   * The backend answers a same-status review with a receipt but changes nothing —
   * verified live. That case is reported as a no-op so the UI cannot imply a change
   * the server did not make.
   */
  const reviewAlert = useCallback(
    async (alertId: string, status: AlertStatus, note: string) => {
      if (!client || review.busy) return null;

      const previous = alerts.data?.alerts.find((alert) => alert.id === alertId)?.status ?? null;
      setReviewBusyAlertId(alertId);
      setReviewNotice(null);

      const result = await review.run(() =>
        client.reviewAlert(alertId, { status, note, actor: 'demo-operator' }),
      );
      setReviewBusyAlertId(null);

      if (!result) {
        setReviewNotice({
          alertId,
          kind: 'failed',
          message: 'The backend did not confirm this review, so nothing has been changed here.',
        });
        return null;
      }

      if (previous && result.status === previous) {
        setReviewNotice({
          alertId,
          kind: 'noop',
          message: `The backend accepted the request but the alert is still ${result.status}, so no transition was recorded. Nothing was changed.`,
        });
      } else {
        setReviewNotice({
          alertId,
          kind: 'changed',
          message: `${previous ?? 'unknown'} → ${result.status}, confirmed by the backend.`,
        });
      }

      // Only now do we show the server's state: no optimistic update.
      alerts.set({
        ...(alerts.data ?? { alerts: [] as Alert[], total: 0, by_status: {} }),
        alerts: (alerts.data?.alerts ?? []).map((alert) => (alert.id === result.id ? result : alert)),
      });
      bumpData();
      return result;
    },
    [client, review, alerts, bumpData],
  );

  const setAsOfDate = useCallback((value: string) => {
    setAsOfTouched(true);
    setAsOf(value);
  }, []);

  const resetAsOf = useCallback(() => setAsOfTouched(false), []);

  const reloadAll = useCallback(() => {
    bumpData();
    health.reload();
    demoState.reload();
    graph.reload();
    decisions.reload();
    alerts.reload();
    timeline.reload();
    history.reload();
  }, [bumpData, health, demoState, graph, decisions, alerts, timeline, history]);

  /* ------------------------------------------------------------------ derived */

  const affectedDecisions = useMemo(() => {
    const list = decisions.data?.decisions ?? [];
    return [...list].sort((a, b) => {
      const rank = (decision: DecisionSummary) =>
        decision.status === 'confirmed_stale'
          ? 3
          : decision.status === 'needs_review'
            ? 2
            : decision.review_state === 'investigate'
              ? 1
              : 0;
      const diff = rank(b) - rank(a);
      if (diff !== 0) return diff;
      return (b.impact_weight ?? 0) - (a.impact_weight ?? 0);
    });
  }, [decisions.data]);

  /** The backend's authoritative propagation result, straight from the trigger. */
  const entityImpacts: PropagationDecision[] = lastTrigger?.entity_impacts ?? [];

  /** Entities the backend flagged for a human, for graph highlighting. */
  const flaggedImpactIds = useMemo(
    () => new Set(entityImpacts.filter((impact) => impact.requires_investigation).map((impact) => impact.id)),
    [entityImpacts],
  );

  const runtimes: Resource<unknown>[] = [health, demoState, graph, decisions, alerts, timeline];

  /** True once the backend is reachable but reported no data at all. */
  const emptyBackend = Boolean(
    connection?.resolvedMode === 'live' && graph.data && graph.data.nodes.length === 0,
  );

  return {
    /* connection */
    connection,
    connecting,
    connectionError,
    client,
    capabilities,
    isMock: connection?.resolvedMode === 'mock',
    isReal: connection?.resolvedMode === 'live',
    seededOnBoot: connection?.seededOnBoot ?? false,
    /* resources */
    health,
    demoState,
    graph,
    decisions,
    alerts,
    timeline,
    systems,
    history,
    demoScenarios,
    factDetail,
    provenance,
    decisionDetail,
    personDetail,
    sourceDetail,
    explanation,
    experts,
    /* selection */
    selectedNode,
    selectedNodeId,
    selectedSourceId,
    highlight,
    pathLabel: path.label,
    pathOrigin: path.origin,
    lastTrigger,
    entityImpacts,
    flaggedImpactIds,
    asOf,
    historyBounds,
    expertsQuery: effectiveExpertsQuery,
    scenario: scenario ?? null,
    /* derived */
    affectedDecisions,
    demoClock,
    bootstrapping: connecting || runtimes.some((resource) => resource.loading && !resource.data),
    fatalError: connectionError ?? health.error ?? null,
    emptyBackend,
    /* actions */
    selectNode,
    openSource,
    closeSource,
    showExplanation,
    clearPath,
    triggerDemo,
    resetDemo,
    reviewAlert,
    reloadAll,
    setAsOfDate,
    resetAsOf,
    setExpertsQuery,
    setScenario,
    /* mutation state */
    triggerBusy: trigger.busy,
    triggerError: trigger.error,
    resetBusy: reset.busy,
    resetError: reset.error,
    reviewBusyAlertId,
    reviewError: review.error,
    reviewNotice,
  };
}

export type Tripwire = ReturnType<typeof useTripwire>;

/** Kept for components that referenced the old local alias. */
export type SourceDetailPayload = SourceDetailLike;
export type { NodeType };
