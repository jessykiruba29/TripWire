/**
 * Runtime mode resolution — the single place the app decides where its data comes from.
 *
 *   VITE_API_MODE=live  → the real FastAPI backend. A failure is SHOWN, never masked.
 *   VITE_API_MODE=mock  → the in-browser reference engine. Always clearly labelled.
 *   VITE_API_MODE=auto  → probe the real backend; fall back to the reference engine and say why.
 *   (default: auto)
 *
 * Rules encoded here:
 *  - mock data is never presented as live company data, and real mode never silently
 *    degrades into mock data (that is why `live` does not fall back)
 *  - the real backend's store starts empty, so seeding happens BEFORE any graph read
 *  - the two clients stay separate implementations behind one interface
 */

import { createTripwireClient, type TripwireClient } from './client';
import {
  createRealTripwireClient,
  DEMO_SCENARIOS,
  type RealTripwireClient,
} from './realClient';
import { createEngineTransport, createHttpTransport, TripwireApiError, type Transport } from './transport';
import type {
  Alert,
  AlertStatus,
  AlertsResponse,
  DecisionDetail,
  DecisionSummary,
  DemoState,
  FactDetail,
  GraphResponse,
  HealthResponse,
  HistoryResponse,
  IntegrationsResponse,
  PersonDetail,
  PersonSummary,
  ProvenanceStep,
  SearchResult,
  SourceRecord,
  SystemSummary,
  TimelineResponse,
  TriggerEventResponse,
  ExpertsResponse,
} from './types';

export const DEFAULT_API_BASE_URL = 'http://localhost:8000';

export type RequestedMode = 'live' | 'mock' | 'auto';
export type ResolvedMode = 'live' | 'mock';

/** Which optional capabilities the active client actually supports. */
export interface ClientCapabilities {
  /** Trigger takes a scenario id rather than free text. */
  scenarioTrigger: boolean;
  /** Alert review returns a receipt and must be re-read. */
  reviewReceipt: boolean;
  /** Expert search uses a free-text `q`. */
  expertsQuery: boolean;
  /** A dedicated ingestion endpoint exists and is verified. */
  ingest: boolean;
  /** The backend can seed its own dataset. */
  selfSeed: boolean;
  /** Node `label` is the kind and `name` is the display text. */
  kindIsLabel: boolean;
}

export interface SourceDetailLike {
  source: SourceRecord;
  supports_facts?: Array<{ id: string; label: string }>;
  supports_assumptions?: Array<{ id: string; label: string }>;
  supports_decisions?: Array<{ id: string; title: string }>;
  linked_entities?: Array<{ id: string; type: import('./types').NodeType; label: string }>;
  provenance?: ProvenanceStep[];
}

interface GraphQueryLike {
  types?: string[];
  project_id?: string;
  status?: string;
  include_sources?: boolean;
  focus_id?: string;
  depth?: number;
  q?: string;
  limit?: number;
}

interface ExpertsQueryLike {
  q?: string;
  system_id?: string;
  limit?: number;
  for_alert_id?: string;
}

interface SourcesQueryLike {
  type?: string;
  q?: string;
  project_id?: string;
  author_id?: string;
  entity_id?: string;
  limit?: number;
}

/**
 * The surface `useTripwire` consumes. Both clients implement it; neither knows
 * about the other. Declared as methods so TypeScript checks them bivariantly,
 * which is what lets two genuinely different clients satisfy one interface.
 */
export interface AppClient {
  readonly kind: 'reference' | 'real';
  readonly baseUrl: string;
  readonly capabilities: ClientCapabilities;

  health(): Promise<HealthResponse>;
  demoState(): Promise<DemoState>;
  graph(query?: GraphQueryLike): Promise<GraphResponse>;
  decisions(): Promise<{ decisions: DecisionSummary[]; total: number }>;
  explanation(decisionId: string): Promise<import('./types').Explanation>;
  decision(decisionId: string): Promise<DecisionDetail>;
  alerts(query?: { status?: AlertStatus; decision_id?: string; limit?: number; offset?: number }): Promise<AlertsResponse>;
  reviewAlert(id: string, input: { status: AlertStatus; actor?: string; note?: string }): Promise<Alert>;
  alertHistory?(id: string): Promise<Array<{ at: string; from: string | null; to: string; actor: string; note: string }>>;
  fact(factId: string): Promise<FactDetail>;
  provenance(factId: string): Promise<{ fact_id: string; chain: ProvenanceStep[] }>;
  sources(query?: SourcesQueryLike): Promise<{ sources: SourceRecord[]; total: number }>;
  source(sourceId: string): Promise<SourceDetailLike>;
  history(query?: { at?: string; entity_id?: string; from?: string; to?: string }): Promise<HistoryResponse>;
  timeline(limit?: number): Promise<TimelineResponse>;
  people(): Promise<{ people: PersonSummary[]; total: number }>;
  person(personId: string): Promise<PersonDetail>;
  experts(query?: ExpertsQueryLike): Promise<ExpertsResponse>;
  systems(): Promise<{ systems: SystemSummary[] }>;
  integrations(): Promise<IntegrationsResponse>;
  search?(q: string, limit?: number): Promise<{ results: SearchResult[]; total?: number }>;

  /** Real backend only: makes sure the dataset exists before anything reads it. */
  ensureSeeded?(): Promise<{ seeded: boolean; didSeed: boolean }>;
  /** Real backend only: the demo event ids it accepts. */
  scenarios?(): Promise<Array<{ id: string; description?: string }>>;

  triggerEvent(input: {
    scenario?: string;
    text?: string;
    channel?: string;
    actor_id?: string;
  }): Promise<TriggerEventResponse>;
  resetDemo(): Promise<{ status: string; revision?: number; demo_state?: DemoState }>;
}

export interface ApiConnection {
  client: AppClient;
  requestedMode: RequestedMode;
  resolvedMode: ResolvedMode;
  baseUrl: string;
  /** Why we ended up here — rendered in the mode banner. */
  reason: string;
  probeError: TripwireApiError | null;
  /** Set when a real connection had to seed the store on this boot. */
  seededOnBoot: boolean;
}

/** Reference-engine client, wrapped with its capabilities. */
export function wrapReferenceClient(client: TripwireClient): AppClient {
  return Object.assign(client, {
    kind: 'reference' as const,
    capabilities: {
      scenarioTrigger: false,
      reviewReceipt: false,
      expertsQuery: false,
      ingest: true,
      selfSeed: false,
      kindIsLabel: false,
    } satisfies ClientCapabilities,
  }) as unknown as AppClient;
}

/** Real-backend client, wrapped with its capabilities. */
export function wrapRealClient(client: RealTripwireClient): AppClient {
  const base = client as unknown as AppClient;
  return Object.assign(base, {
    kind: 'real' as const,
    capabilities: {
      scenarioTrigger: true,
      reviewReceipt: true,
      expertsQuery: true,
      // `/api/ingest` exists as an adapter listing, but its write contract was
      // never verified against the running server, so ingestion stays off.
      ingest: false,
      selfSeed: true,
      kindIsLabel: true,
    } satisfies ClientCapabilities,
  });
}

function readEnv(): { mode: RequestedMode; baseUrl: string; latencyMs: number } {
  const env = import.meta.env ?? {};
  const raw = (env.VITE_API_MODE ?? 'auto').toLowerCase();
  const mode: RequestedMode = raw === 'live' || raw === 'mock' ? raw : 'auto';
  const latency = Number(env.VITE_MOCK_LATENCY_MS ?? '0');
  return {
    mode,
    baseUrl: env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL,
    latencyMs: Number.isFinite(latency) && latency > 0 ? latency : 0,
  };
}

export interface ConnectOptions {
  requestedMode?: RequestedMode;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  mockLatencyMs?: number;
  /** Skip the automatic seed probe (used by tests that assert on seed ordering). */
  autoSeed?: boolean;
}

/**
 * Resolve the transport. Never throws: a failed live probe degrades to the
 * reference engine only in `auto` mode, and always with an explicit reason.
 */
export async function connect(options: ConnectOptions = {}): Promise<ApiConnection> {
  const env = readEnv();
  const requestedMode = options.requestedMode ?? env.mode;
  const baseUrl = options.baseUrl ?? env.baseUrl;
  const mockLatencyMs = options.mockLatencyMs ?? env.latencyMs;

  if (requestedMode === 'mock') {
    const transport: Transport = createEngineTransport({ latencyMs: mockLatencyMs });
    return {
      client: wrapReferenceClient(createTripwireClient(transport)),
      requestedMode,
      resolvedMode: 'mock',
      baseUrl,
      reason: 'VITE_API_MODE=mock — using the deterministic reference engine in the browser.',
      probeError: null,
      seededOnBoot: false,
    };
  }

  const liveTransport = createHttpTransport({ baseUrl, fetchImpl: options.fetchImpl });
  const liveClient = createRealTripwireClient(liveTransport, { autoSeed: options.autoSeed ?? true });

  try {
    const health = await liveClient.health();

    // Seed BEFORE anything reads the graph: the real store starts empty, and a
    // graph read against an empty store would render a blank app.
    let seededOnBoot = false;
    if ((options.autoSeed ?? true) && !health.counts.nodes) {
      const seed = await liveClient.ensureSeeded();
      seededOnBoot = seed.didSeed;
    }

    return {
      client: wrapRealClient(liveClient),
      requestedMode,
      resolvedMode: 'live',
      baseUrl,
      reason: `Connected to the Tripwire backend at ${baseUrl} (store: ${health.mode}).`,
      probeError: null,
      seededOnBoot,
    };
  } catch (error) {
    const probeError = error instanceof TripwireApiError ? error : null;

    if (requestedMode === 'live') {
      // Explicit live mode never substitutes fixtures. The failure is shown.
      return {
        client: wrapRealClient(liveClient),
        requestedMode,
        resolvedMode: 'live',
        baseUrl,
        reason: `VITE_API_MODE=live but the backend at ${baseUrl} did not respond.`,
        probeError,
        seededOnBoot: false,
      };
    }

    const transport: Transport = createEngineTransport({ latencyMs: mockLatencyMs });
    return {
      client: wrapReferenceClient(createTripwireClient(transport)),
      requestedMode,
      resolvedMode: 'mock',
      baseUrl,
      reason: `No backend at ${baseUrl} — falling back to the in-browser reference engine. Nothing shown is live company data.`,
      probeError,
      seededOnBoot: false,
    };
  }
}

export { DEMO_SCENARIOS, createTripwireClient };
export type { TripwireClient, RealTripwireClient };
export { TripwireApiError } from './transport';
export * from './types';
