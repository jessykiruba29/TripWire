/**
 * API client for the REAL Tripwire backend (FastAPI on :8000).
 *
 * Kept deliberately separate from `client.ts`, which speaks to the reference
 * engine and is correct for that engine. Mixing the two would mean one of them
 * silently lied about the other's contract. Both expose the same method names so
 * `index.ts` can select between them.
 *
 * Differences this file encodes (all verified live — see
 * docs/FRONTEND_BACKEND_MAPPING.md):
 *   - entity ids contain ":" and MUST be URL-encoded in path segments
 *   - the store starts empty: `POST /api/demo/seed` must run before reads
 *   - the trigger takes a scenario id, not free text
 *   - there is no `/api/decisions` list, no `/api/people`, no `/api/timeline`;
 *     those are derived from `/api/graph`, which is the same source of truth
 *   - alert review is `POST /api/alerts/{id}/review` with `actor_id`
 *   - `/api/experts` resolves its target from a free-text `q`
 */

import { TripwireApiError, type QueryParams, type Transport } from './transport';
import * as adapt from './adapter';
import type {
  RawAlert,
  RawAlertHistory,
  RawAlertList,
  RawDemoState,
  RawDecisionExplanation,
  RawExpertsResponse,
  RawFactExplanation,
  RawGraph,
  RawHealth,
  RawHistoryBelief,
  RawHistoryChanges,
  RawIngestAdapters,
  RawNode,
  RawPathsResponse,
  RawSearchResponse,
  RawSourceDetail,
  RawSourceList,
  RawTriggerResponse,
} from './backendTypes';
import type {
  Alert,
  AlertStatus,
  AlertsResponse,
  DecisionDetail,
  DecisionSummary,
  DemoState,
  EventSummary,
  Explanation,
  FactDetail,
  GraphPath,
  GraphResponse,
  HealthResponse,
  HistoryResponse,
  IntegrationsResponse,
  NodeType,
  PersonDetail,
  PersonSummary,
  ProjectSummary,
  ProvenanceStep,
  SearchResult,
  SourceRecord,
  SourceType,
  SystemSummary,
  TeamSummary,
  TimelineResponse,
  TriggerEventResponse,
  AssumptionSummary,
} from './types';

/** Demo scenarios the backend accepts. Verified from /api/dataset/scenarios. */
export const DEMO_SCENARIOS = [
  'frankfurt_compliance_revoked',
  'frankfurt_compliance_revoked_unverified',
  'pricing_rate_renewal_2027',
  'additive_edge_cache_provider',
  'ambiguous_edge_cache_region',
  'unrelated_mobile_theme_change',
] as const;

export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

/** The trigger accepted the free-text brief back when the UI was written. */
const LEGACY_TEXT_TO_SCENARIO: Array<{ match: RegExp; scenario: DemoScenario }> = [
  { match: /frankfurt.*(lost|losing|lose|revok|no longer).*(compliance|certif)/i, scenario: 'frankfurt_compliance_revoked' },
  { match: /frankfurt/i, scenario: 'frankfurt_compliance_revoked' },
];

export interface RealTriggerInput {
  /** Preferred: a scenario id the backend documents. */
  scenario?: string;
  /** Legacy free text; mapped to a scenario or rejected with a clear error. */
  text?: string;
  channel?: string;
  actor_id?: string;
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

function labelOf(node: RawNode): string {
  return adapt.displayName(node);
}

function isLabel(node: RawNode, label: string): boolean {
  return String(node.label ?? '').toLowerCase() === label.toLowerCase();
}

export interface RealClientOptions {
  /** Seed automatically when the store is empty (default true). */
  autoSeed?: boolean;
  /** Default `since` for the activity feed when none is supplied. */
  defaultSince?: string;
}

export function createRealTripwireClient(transport: Transport, options: RealClientOptions = {}) {
  const { autoSeed = true } = options;

  const get = <T>(path: string, query?: QueryParams) => transport.request<T>('GET', path, { query });
  const post = <T>(path: string, body?: unknown) => transport.request<T>('POST', path, { body });

  /** Graph payloads are needed by several derived methods; cache per call chain. */
  async function fetchGraph(query?: QueryParams): Promise<RawGraph> {
    return get<RawGraph>('/api/graph', query);
  }

  async function fromGraph(label: string, query?: QueryParams): Promise<RawNode[]> {
    const graph = await fetchGraph(query);
    return (graph.nodes ?? []).filter((node) => isLabel(node, label));
  }

  let seedChecked = false;

  return {
    transport,
    baseUrl: transport.label,
    /** True for the real backend; the UI uses this to label the mode. */
    kind: 'real' as const,

    /* ------------------------------------------------------------- runtime */

    health: async (): Promise<HealthResponse> => adapt.adaptHealth(await get<RawHealth>('/api/health')),

    /**
     * The real store starts empty. Every read path that matters calls this first,
     * so the boot sequence cannot render an empty graph by accident.
     */
    ensureSeeded: async (): Promise<{ seeded: boolean; didSeed: boolean }> => {
      const health = await get<RawHealth>('/api/health');
      if (health.seeded) {
        seedChecked = true;
        return { seeded: true, didSeed: false };
      }
      if (!autoSeed) return { seeded: false, didSeed: false };
      await post('/api/demo/seed', {});
      seedChecked = true;
      return { seeded: true, didSeed: true };
    },

    /* --------------------------------------------------------- demo control */

    demoState: async (): Promise<DemoState> => {
      if (autoSeed && !seedChecked) await (async () => {
        const health = await get<RawHealth>('/api/health');
        if (!health.seeded) await post('/api/demo/seed', {});
        seedChecked = true;
      })();
      const raw = await get<RawDemoState>('/api/demo/state');
      return adapt.adaptDemoState(raw);
    },

    /**
     * The scenario list. Verified live: each entry keys its id as `name`
     * (not `id` or `scenario`), with a `description` that documents the expected
     * behaviour — including the restraint cases that raise no alert.
     */
    scenarios: async (): Promise<Array<{ id: string; description?: string }>> => {
      const raw = await get<{
        total?: number;
        scenarios?: Array<{ name?: string; id?: string; scenario?: string; description?: string; title?: string }>;
      }>('/api/dataset/scenarios');
      return (raw.scenarios ?? [])
        .map((item) => ({
          id: item.name ?? item.id ?? item.scenario ?? '',
          description: item.description ?? item.title,
        }))
        .filter((item) => item.id.length > 0);
    },

    /**
     * Trigger the event. Real payload is `{scenario}`; free text is mapped for
     * backwards compatibility and rejected clearly when it cannot be mapped.
     */
    triggerEvent: async (input: RealTriggerInput): Promise<TriggerEventResponse> => {
      let scenario = input.scenario;
      if (!scenario && input.text) {
        const match = LEGACY_TEXT_TO_SCENARIO.find((entry) => entry.match.test(input.text ?? ''));
        scenario = match?.scenario;
      }
      if (!scenario) {
        throw new TripwireApiError(
          422,
          'scenario_required',
          `The real backend triggers demo events by scenario id, and the supplied text could not be mapped to one. Valid ids: ${DEMO_SCENARIOS.join(', ')}.`,
          { valid_scenarios: [...DEMO_SCENARIOS] },
        );
      }

      const raw = await post<RawTriggerResponse>('/api/demo/trigger-event', {
        scenario,
        ...(input.actor_id ? { actor_id: input.actor_id } : {}),
      });

      // The trigger response has no graph snapshot; fetch one so "unaffected" can
      // be derived from the graph rather than guessed.
      let rawNodes: RawNode[] = [];
      try {
        rawNodes = (await fetchGraph()).nodes ?? [];
      } catch {
        rawNodes = [];
      }

      const view = adapt.adaptTrigger(raw, { graphNodes: rawNodes });

      // Alerts and the full explanation are separate reads on this backend.
      const topDecision = view.propagation.decisions.find((decision) => decision.requires_investigation);
      const [alerts, explanation] = await Promise.all([
        get<RawAlertList>('/api/alerts').then(adapt.adaptAlertList).catch(() => null),
        topDecision
          ? get<RawDecisionExplanation>(`/api/decisions/${enc(topDecision.id)}/explanation`)
              .then((raw_) => adapt.adaptExplanation(raw_))
              .catch(() => null)
          : Promise.resolve(null),
      ]);

      return {
        ...view,
        alerts: alerts?.alerts ?? [],
        explanation,
      };
    },

    resetDemo: async (): Promise<{ status: string; revision: number; demo_state: DemoState }> => {
      await post('/api/demo/reset', {});
      seedChecked = false;
      const demoState = await (async () => {
        await post('/api/demo/seed', {});
        seedChecked = true;
        return adapt.adaptDemoState(await get<RawDemoState>('/api/demo/state'));
      })();
      return { status: 'reset', revision: demoState.revision, demo_state: demoState };
    },

    /* --------------------------------------------------------------- graph */

    graph: async (query: {
      types?: NodeType[] | string[];
      focus_id?: string;
      depth?: number;
      q?: string;
      limit?: number;
      include_sources?: boolean;
    } = {}): Promise<GraphResponse> => {
      const raw = await fetchGraph({
        around: query.focus_id,
        depth: query.depth,
        node_limit: query.limit,
      });
      const adapted = adapt.adaptGraph(raw);
      return {
        revision: raw.meta?.node_count ?? adapted.nodes.length,
        generated_at: new Date().toISOString(),
        nodes: adapted.nodes,
        edges: adapted.edges,
        stats: {
          node_count: raw.meta?.node_count ?? adapted.nodes.length,
          edge_count: raw.meta?.edge_count ?? adapted.edges.length,
          by_type: {},
          by_state: {},
          total_nodes: raw.meta?.total_nodes,
          total_edges: raw.meta?.total_edges,
        },
        truncated: Boolean(raw.meta?.truncated),
      };
    },

    /**
     * `/api/paths` returns every route between two entities (4 for the demo pair).
     * The first is often a bare `STALED` edge the engine wrote; the *explanatory*
     * route is the one that passes through the assumption. That one is preferred,
     * because an alert whose path skips the assumption explains nothing.
     * All candidates stay available via `pathsBetween`.
     */
    /**
     * `/api/paths` returns every route between two entities (4 for the demo pair).
     * `paths[0]` is often a bare `STALED` edge the engine wrote, and one route is
     * structurally invalid, so candidates are **validated** before use and the
     * explanatory route (the one through the assumption) is preferred.
     *
     * Invalid routes are reported through `pathReport`, never rewritten into
     * something that looks valid.
     */
    graphPath: async ({ from, to }: { from: string; to: string }): Promise<GraphPath> => {
      const raw = await get<RawPathsResponse>('/api/paths', { source: from, target: to });
      const valid = (raw.paths ?? []).filter((path) => adapt.validatePath(path).valid);
      const explanatory = valid.find(
        (path) => path.rels?.includes('SUPPORTED_BY') && path.rels?.includes('ASSUMES'),
      );
      const chosen = explanatory ?? valid[0];
      return adapt.adaptGraphPath(chosen ? { ...raw, paths: [chosen] } : { ...raw, paths: [] }, from, to);
    },

    /** Every candidate route with a validity verdict, for diagnostics and the UI. */
    pathsBetween: async (from: string, to: string) => {
      const raw = await get<RawPathsResponse>('/api/paths', { source: from, target: to });
      return {
        report: adapt.summarisePaths(raw.paths),
        paths: (raw.paths ?? []).map((path) => ({
          nodes: path.nodes,
          rels: path.rels,
          length: path.length,
          narrative: path.narrative ?? '',
          valid: adapt.validatePath(path).valid,
          invalidReason: adapt.validatePath(path).reason,
        })),
      };
    },

    /* ----------------------------------------------------------- decisions */

    /** Derived from the graph: the real backend has no decisions list endpoint. */
    decisions: async (): Promise<{ decisions: DecisionSummary[]; total: number }> => {
      const nodes = await fromGraph('Decision');
      const decisions = adapt.adaptDecisionList(nodes);
      return { decisions, total: decisions.length };
    },

    decision: async (id: string): Promise<DecisionDetail> => {
      const raw = await get<RawDecisionExplanation>(`/api/decisions/${enc(id)}/explanation`);
      if (!raw.found) {
        throw new TripwireApiError(404, 'not_found', `Decision ${id} was not found in the graph.`, { id });
      }
      const graph = await fetchGraph();
      const adapted = adapt.adaptGraph(graph);
      const decisionNode = adapted.byId.get(id) ?? null;

      const sources: SourceRecord[] = (raw.dependencies ?? []).flatMap((dependency) =>
        dependency.facts.flatMap((fact) => (fact.sources ?? []).map(adapt.adaptSourceRef)),
      );

      const assumptions: AssumptionSummary[] = (raw.dependencies ?? []).map((dependency) => ({
        id: dependency.assumption_id,
        label: dependency.name,
        statement: dependency.statement ?? '',
        status: String(dependency.status ?? 'unknown').toLowerCase(),
        confidence: dependency.confidence ?? null,
        supported_by: dependency.facts.map((fact) => fact.fact_id),
        contradicted_by: [],
        state: 'normal',
      }));

      return adapt.adaptDecisionDetail(raw, decisionNode, sources, assumptions);
    },

    explanation: async (id: string): Promise<Explanation> => {
      const raw = await get<RawDecisionExplanation>(`/api/decisions/${enc(id)}/explanation`);
      if (!raw.found) {
        throw new TripwireApiError(404, 'not_found', `No explanation available for decision ${id}.`, { id });
      }
      const graph = await fetchGraph();
      const adapted = adapt.adaptGraph(graph);
      return adapt.adaptExplanation(raw, adapted.byId);
    },

    /* -------------------------------------------------------------- alerts */

    alerts: async (query: { status?: AlertStatus; limit?: number; offset?: number } = {}): Promise<AlertsResponse> => {
      const raw = await get<RawAlertList>('/api/alerts', {
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      });
      return adapt.adaptAlertList(raw);
    },

    alert: async (id: string): Promise<Alert> => adapt.adaptAlert(await get<RawAlert>(`/api/alerts/${enc(id)}`)),

    alertHistory: async (id: string) =>
      adapt.adaptAlertHistory(await get<RawAlertHistory>(`/api/alerts/${enc(id)}/history`)),

    /**
     * POST, not GET, and the actor field is `actor_id`.
     *
     * The endpoint answers with a transition receipt
     * (`{alert_id, status, previous_status, updated_at, reviewed_by, review_note, affected}`),
     * NOT an Alert — verified live. Re-reads the alert afterwards so the UI shows
     * the server's real state rather than a locally stitched-together object.
     */
    reviewAlert: async (
      id: string,
      input: { status: AlertStatus; actor?: string; note?: string },
    ): Promise<Alert> => {
      const receipt = await post<{
        alert_id: string;
        status: string;
        previous_status?: string | null;
        updated_at?: string;
        reviewed_by?: string | null;
        review_note?: string | null;
      }>(`/api/alerts/${enc(id)}/review`, {
        status: input.status,
        actor_id: input.actor ?? 'demo-operator',
        note: input.note ?? '',
      });

      const confirmedId = receipt?.alert_id ?? id;
      try {
        return adapt.adaptAlert(await get<RawAlert>(`/api/alerts/${enc(confirmedId)}`));
      } catch {
        // Fall back to what the receipt actually told us — never invent the rest.
        return {
          ...adapt.adaptAlert({ id: confirmedId, label: 'Alert', status: receipt.status, severity: 'medium' }),
          status: receipt.status as AlertStatus,
          updated_at: receipt.updated_at ?? '',
        };
      }
    },

    /* --------------------------------------------------------------- facts */

    fact: async (id: string): Promise<FactDetail> => {
      const raw = await get<RawFactExplanation>(`/api/facts/${enc(id)}/explanation`);
      if (!raw.found) {
        throw new TripwireApiError(404, 'not_found', `Fact ${id} was not found.`, { id });
      }
      return adapt.adaptFactExplanation(raw).detail;
    },

    /** No dedicated endpoint: the chain is part of the fact explanation. */
    provenance: async (id: string): Promise<{ fact_id: string; chain: ProvenanceStep[] }> => {
      const raw = await get<RawFactExplanation>(`/api/facts/${enc(id)}/explanation`);
      if (!raw.found) {
        throw new TripwireApiError(404, 'not_found', `Fact ${id} was not found.`, { id });
      }
      const { chain } = adapt.adaptFactExplanation(raw);
      return { fact_id: raw.fact_id ?? id, chain };
    },

    /* ------------------------------------------------------------- sources */

    sources: async (
      query: { type?: SourceType; q?: string; limit?: number; offset?: number; author_id?: string } = {},
    ): Promise<{ sources: SourceRecord[]; total: number }> => {
      const raw = await get<RawSourceList>('/api/sources', {
        limit: query.limit ?? 50,
        offset: query.offset,
        author_id: query.author_id,
      });
      return { sources: (raw.sources ?? []).map(adapt.adaptSource), total: raw.total ?? 0 };
    },

    source: async (id: string) => {
      const raw = await get<RawSourceDetail>(`/api/sources/${enc(id)}`);
      const adapted = adapt.adaptSourceDetail(raw);
      return {
        source: adapted.source,
        supports_facts: adapted.states.map((state) => ({ id: state.id, label: state.label })),
        supports_assumptions: [] as Array<{ id: string; label: string }>,
        supports_decisions: [] as Array<{ id: string; title: string }>,
        linked_entities: adapted.states.map((state) => ({ id: state.id, type: state.type, label: state.label })),
      };
    },

    /* ------------------------------------------------------------- history */

    history: async (query: { at?: string } = {}): Promise<HistoryResponse> => {
      const at = query.at ?? '2026-02-01T00:00:00Z';
      const [belief, changes] = await Promise.all([
        get<RawHistoryBelief>('/api/history/belief', { at }).catch(() => null),
        get<RawHistoryChanges>('/api/history/changes', { since: at }).catch(() => null),
      ]);
      const decisions = await fromGraph('Decision')
        .then((nodes) =>
          nodes.map((node) => ({
            id: node.id,
            title: labelOf(node),
            status_at_time: String(node.previous_status ?? 'ACTIVE'),
            status_now: String(node.status ?? 'ACTIVE'),
            created_at: node.created_at ?? '',
            review_state_now: node.review_status ?? undefined,
          })),
        )
        .catch(() => []);
      return adapt.adaptHistory(belief, changes, decisions);
    },

    timeline: async (limit = 40): Promise<TimelineResponse> => {
      const raw = await get<RawHistoryChanges>('/api/history/changes', { since: '2025-01-01T00:00:00Z' }).catch(
        () => null,
      );
      const adapted = adapt.adaptTimeline(raw);
      return { ...adapted, events: adapted.events.slice(0, limit) };
    },

    /* --------------------------------------------------- people / entities */

    /**
     * No people endpoint. Derived from the graph, and contributions are counted
     * from AUTHORED edges — real recorded data, not a guess.
     */
    people: async (): Promise<{ people: PersonSummary[]; total: number }> => {
      const graph = await fetchGraph();
      const adapted = adapt.adaptGraph(graph);
      const people = adapted.nodes
        .filter((node) => node.type === 'person')
        .map((node) => ({
          id: node.id,
          name: node.label,
          team_id: null,
          official_owner_of: adapted.edges
            .filter((edge) => edge.type === 'owns' && edge.source === node.id)
            .map((edge) => edge.target),
          contribution_count: adapted.edges.filter(
            (edge) =>
            edge.source === node.id &&
            ['authored', 'made', 'resolved', 'reviews'].includes(String(edge.type)),
          ).length,
          project_ids: [],
          system_ids: [],
        }));
      return { people, total: people.length };
    },

    person: async (id: string): Promise<PersonDetail> => {
      const graph = await fetchGraph();
      const adapted = adapt.adaptGraph(graph);
      const node = adapted.byId.get(id);
      if (!node) throw new TripwireApiError(404, 'not_found', `Person ${id} was not found.`, { id });

      const authored = adapted.edges.filter((edge) => edge.source === id);
      const contributions = authored
        .map((edge) => {
          const target = adapted.byId.get(edge.target);
          return {
            source_id: edge.target,
            type: (target?.type ?? 'document') as SourceType,
            title: target?.label ?? edge.target,
            at: (edge.properties?.at as string) ?? target?.recorded_at ?? '',
            why: edge.label ? `Recorded as ${String(edge.label).toLowerCase().replace(/_/g, ' ')}` : undefined,
          };
        })
        .slice(0, 60);

      return {
        person: {
          id: node.id,
          name: node.label,
          team_id: null,
          official_owner_of: adapted.edges
            .filter((edge) => edge.type === 'owns' && edge.source === id)
            .map((edge) => edge.target),
          contribution_count: contributions.length,
          project_ids: [],
          system_ids: [],
        },
        contributions,
        systems: [],
        projects: [],
        decisions: adapted.edges
          .filter((edge) => edge.target === id && String(edge.type) === 'made')
          .map((edge) => ({ id: edge.source, title: adapted.byId.get(edge.source)?.label ?? edge.source })),
        profile_note:
          'Derived from recorded graph relationships. The real backend has no dedicated person endpoint, so this view is reconstructed from AUTHORED / MADE / OWNS edges.',
      };
    },

    /**
     * The real backend resolves an expert target from free text, so a system id is
     * turned into its display name first.
     */
    experts: async (query: { q?: string; system_id?: string; limit?: number } = {}): Promise<
      ReturnType<typeof adapt.adaptExperts>
    > => {
      let q = query.q;
      if (!q && query.system_id) {
        const graph = await fetchGraph();
        const adapted = adapt.adaptGraph(graph);
        q = adapted.byId.get(query.system_id)?.label ?? query.system_id;
      }
      const raw = await get<RawExpertsResponse>('/api/experts', { q, limit: query.limit ?? 5 });
      return adapt.adaptExperts(raw);
    },

    expertsByQuery: async (q: string, limit = 5) =>
      adapt.adaptExperts(await get<RawExpertsResponse>('/api/experts', { q, limit })),

    /* ------------------------------------------------------- derived lists */

    projects: async (): Promise<{ projects: ProjectSummary[] }> => ({
      projects: (await fromGraph('Project')).map((node) => ({
        id: node.id,
        title: labelOf(node),
        status: node.status ?? undefined,
      })),
    }),

    systems: async (): Promise<{ systems: SystemSummary[] }> => ({
      systems: (await fromGraph('System')).map((node) => ({
        id: node.id,
        title: labelOf(node),
        criticality: node.status ?? undefined,
      })),
    }),

    teams: async (): Promise<{ teams: TeamSummary[] }> => ({
      teams: (await fromGraph('Team')).map((node) => ({ id: node.id, name: labelOf(node) })),
    }),

    assumptions: async (): Promise<{ assumptions: AssumptionSummary[] }> => ({
      assumptions: (await fromGraph('Assumption')).map(adapt.adaptAssumption),
    }),

    events: async (): Promise<{ events: EventSummary[] }> => ({
      events: (await fromGraph('Event')).map((node) => ({
        id: node.id,
        type: String(node.event_type ?? node.name ?? 'event'),
        summary: node.summary ?? node.name ?? '',
        occurred_at: node.timestamp ?? node.recorded_at ?? '',
        recorded_at: node.recorded_at ?? '',
        actor: node.actor_id ? String(node.actor_id) : 'system',
        source_id: '',
        raw_text: node.summary ?? '',
      })),
    }),

    /* --------------------------------------------------------------- misc */

    search: async (q: string, limit = 10): Promise<{ results: SearchResult[]; total?: number }> => {
      const raw = await get<RawSearchResponse>('/api/search', { q, limit });
      return {
        results: (raw.results ?? []).slice(0, limit).map((node) => ({
          id: node.id,
          type: adapt.toNodeType(node.label),
          label: labelOf(node),
          subtitle: node.summary ?? node.status ?? undefined,
          score: 1,
          state: adapt.toNodeState(node),
        })),
        total: raw.total,
      };
    },

    integrations: async (): Promise<IntegrationsResponse> => {
      const raw = await get<RawIngestAdapters>('/api/ingest/adapters');
      return {
        integrations: (raw.adapters ?? []).map((adapter) => ({
          id: adapter.name,
          label: adapter.description,
          available: Boolean(raw.available),
          mechanism: adapter.integration_type ?? 'documented-record',
          note: adapter.integration_note ?? '',
        })),
        supported_source_types: (raw.adapters ?? [])
          .map((adapter) => (adapter.default_doc_type ?? adapter.name) as SourceType)
          .filter(Boolean),
        extractor: 'deterministic rules (LLM disabled in this environment)',
        honest_note:
          raw.message ??
          'These are documented input adapters, not live provider integrations. Nothing is pulled from Slack or a ticketing system automatically.',
      };
    },
  };
}

export type RealTripwireClient = ReturnType<typeof createRealTripwireClient>;
