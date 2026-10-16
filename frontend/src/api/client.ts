/**
 * The one typed client. Every component talks to `TripwireClient`; nothing else
 * touches a URL or a raw payload.
 */

import type {
  Alert,
  AlertStatus,
  AlertsResponse,
  AssumptionSummary,
  DecisionDetail,
  DecisionSummary,
  DemoState,
  EventSummary,
  ExpertsResponse,
  Explanation,
  FactDetail,
  GraphPath,
  GraphResponse,
  HistoryResponse,
  IngestResponse,
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
} from './types';
import type { QueryParams, Transport } from './transport';

export interface GraphQuery {
  types?: NodeType[] | string[];
  project_id?: string;
  status?: string;
  include_sources?: boolean;
  focus_id?: string;
  depth?: number;
  q?: string;
  limit?: number;
}

export interface GraphPathQuery {
  from: string;
  to: string;
}

export interface TriggerEventInput {
  text: string;
  channel?: 'slack' | 'ticket' | 'prd' | 'meeting_note' | 'manual';
  source_author_id?: string;
  occurred_at?: string;
  external_id?: string;
}

export interface ReviewStatusInput {
  status: AlertStatus;
  actor?: string;
  note?: string;
}

export interface IngestInput {
  source_type: SourceType;
  title?: string;
  text: string;
  author_id?: string;
  occurred_at?: string;
  external_id?: string;
  metadata?: Record<string, unknown>;
}

function csv(value: string[] | undefined): string | undefined {
  return value && value.length > 0 ? value.join(',') : undefined;
}

export function createTripwireClient(transport: Transport) {
  const get = <T>(path: string, query?: QueryParams) => transport.request<T>('GET', path, { query });
  const post = <T>(path: string, body?: unknown) => transport.request<T>('POST', path, { body });

  return {
    transport,
    baseUrl: transport.label,

    /* runtime */
    health: () => get<import('./types').HealthResponse>('/api/health'),

    /* demo control */
    demoState: () => get<DemoState>('/api/demo/state'),
    triggerEvent: (input: TriggerEventInput) =>
      post<TriggerEventResponse>('/api/demo/trigger-event', {
        channel: 'slack',
        ...input,
      }),
    resetDemo: () => post<{ status: string; revision: number; demo_state: DemoState }>('/api/demo/reset'),

    /* graph */
    graph: (query: GraphQuery = {}) =>
      get<GraphResponse>('/api/graph', {
        types: csv(query.types),
        project_id: query.project_id,
        status: query.status,
        include_sources: query.include_sources,
        focus_id: query.focus_id,
        depth: query.depth,
        q: query.q,
        limit: query.limit,
      }),
    graphPath: ({ from, to }: GraphPathQuery) => get<GraphPath>('/api/graph/path', { from, to }),

    /* decisions */
    decisions: () => get<{ decisions: DecisionSummary[]; total: number }>('/api/decisions'),
    decision: (id: string) => get<DecisionDetail>(`/api/decisions/${encodeURIComponent(id)}`),
    explanation: (id: string) => get<Explanation>(`/api/decisions/${encodeURIComponent(id)}/explanation`),

    /* alerts */
    alerts: (query: { status?: AlertStatus; decision_id?: string; project_id?: string } = {}) =>
      get<AlertsResponse>('/api/alerts', query),
    alert: (id: string) => get<Alert>(`/api/alerts/${encodeURIComponent(id)}`),
    /**
     * Contract §5 specifies `200` for an accepted transition; the reference engine
     * currently answers `201`. Any 2xx is treated as success (documented in
     * docs/INTEGRATION_NOTES.md), because HTTP semantics are ambiguous here.
     */
    reviewAlert: (id: string, input: ReviewStatusInput) =>
      post<Alert>(`/api/alerts/${encodeURIComponent(id)}/review-status`, input),

    /* facts & provenance */
    facts: (query: { q?: string; state?: string } = {}) =>
      get<{ facts: import('./types').FactDetail[] | import('./types').GraphNode[]; total?: number }>('/api/facts', query),
    fact: (id: string) => get<FactDetail>(`/api/facts/${encodeURIComponent(id)}`),
    provenance: (id: string) =>
      get<{ fact_id: string; chain: ProvenanceStep[] }>(`/api/facts/${encodeURIComponent(id)}/provenance`),

    /* sources */
    sources: (
      query: { type?: SourceType; q?: string; project_id?: string; author_id?: string; entity_id?: string; limit?: number } = {},
    ) =>
      get<{ sources: SourceRecord[]; total: number; by_type?: Partial<Record<SourceType, number>> }>(
        '/api/sources',
        query,
      ),
    source: (id: string) =>
      get<{
        source: SourceRecord;
        supports_facts: Array<{ id: string; label: string }>;
        supports_assumptions: Array<{ id: string; label: string }>;
        supports_decisions: Array<{ id: string; title: string }>;
        linked_entities: Array<{ id: string; type: NodeType; label: string }>;
        provenance: ProvenanceStep[];
      }>(`/api/sources/${encodeURIComponent(id)}`),

    /* bi-temporal history */
    history: (query: { at?: string; entity_id?: string; from?: string; to?: string } = {}) =>
      get<HistoryResponse>('/api/history', query),
    timeline: (limit = 40) => get<TimelineResponse>('/api/timeline', { limit }),

    /* people & expertise */
    people: () => get<{ people: PersonSummary[]; total: number }>('/api/people'),
    person: (id: string) => get<PersonDetail>(`/api/people/${encodeURIComponent(id)}`),
    experts: (query: { system_id?: string; limit?: number; for_alert_id?: string } = {}) =>
      get<ExpertsResponse>('/api/experts', query),

    /* lookups */
    projects: () => get<{ projects: ProjectSummary[] }>('/api/projects'),
    systems: () => get<{ systems: SystemSummary[] }>('/api/systems'),
    teams: () => get<{ teams: TeamSummary[] }>('/api/teams'),
    assumptions: () => get<{ assumptions: AssumptionSummary[] }>('/api/assumptions'),
    events: () => get<{ events: EventSummary[] }>('/api/events'),

    /* ingestion */
    ingest: (input: IngestInput) => post<IngestResponse>('/api/ingest', input),
    integrations: () => get<IntegrationsResponse>('/api/ingest/integrations'),

    /* search */
    search: (q: string, limit = 10) => get<{ results: SearchResult[]; total?: number }>('/api/search', { q, limit }),
  };
}

export type TripwireClient = ReturnType<typeof createTripwireClient>;
