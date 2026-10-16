/**
 * Tripwire API contract — the ONE place response shapes are declared.
 *
 * Derived from `docs/API_CONTRACT.md` and verified field-by-field against the
 * running reference backend (`mock-backend/`, mode `mock-backend`).
 *
 * Integration rule: if a real backend differs from this file, this file changes —
 * no component may parse a raw payload on its own.
 */

/* ------------------------------------------------------------------ vocabulary */

export type NodeType =
  | 'person'
  | 'team'
  | 'system'
  | 'project'
  | 'decision'
  | 'assumption'
  | 'fact'
  | 'message'
  | 'document'
  | 'event';

export const NODE_TYPES: NodeType[] = [
  'fact',
  'assumption',
  'decision',
  'project',
  'system',
  'person',
  'team',
  'message',
  'document',
  'event',
];

/**
 * Backend states, plus two that are computed in the frontend for the currently
 * inspected evidence path (`selected_path`, `unrelated`). The backend never sends
 * the frontend-computed pair.
 */
export type NodeState =
  | 'normal'
  | 'new_fact'
  | 'contradicted'
  | 'contradicted_replacement'
  | 'potentially_affected'
  | 'needs_review'
  | 'confirmed_stale'
  | 'dismissed'
  | 'resolved'
  | 'selected_path'
  | 'unrelated';

export type EdgeType =
  | 'employs'
  | 'member_of'
  | 'owns'
  | 'contributes_to'
  | 'works_on'
  | 'author_of'
  | 'documented_in'
  | 'supports'
  | 'contradicts'
  | 'depends_on'
  | 'assumes'
  | 'applies_to'
  | 'affects'
  | 'raised_for'
  | 'observed_by'
  | 'supersedes'
  | 'owns_decision'
  | 'escalates'
  | 'about'
  | 'part_of'
  | 'uses';

export type Impact = 'low' | 'medium' | 'high';

export type DecisionStatus =
  | 'active'
  | 'needs_review'
  | 'confirmed_stale'
  | 'superseded'
  | 'resolved'
  | 'potential'
  | 'investigate';

export type AlertStatus = 'NEW' | 'NEEDS_REVIEW' | 'CONFIRMED_STALE' | 'DISMISSED' | 'RESOLVED';

export type Severity = 'low' | 'medium' | 'high';

export type SourceType = 'slack_message' | 'ticket' | 'prd' | 'meeting_note';

export type ProvenanceKind =
  | 'original_source'
  | 'extracted_claim'
  | 'system_interpretation'
  | 'business_decision';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/* ------------------------------------------------------------------------ graph */

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  state: NodeState;
  summary: string;
  confidence: number | null;
  project_ids: string[];
  team_ids: string[];
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string | null;
  degree: number;
  source_ids: string[];
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label: string;
  confidence: number | null;
  properties: Record<string, unknown>;
}

export interface GraphStats {
  node_count: number;
  edge_count: number;
  by_type: Partial<Record<NodeType, number>>;
  by_state: Partial<Record<NodeState, number>>;
  total_matching?: number;
  total_nodes?: number;
  total_edges?: number;
}

export interface GraphResponse {
  revision: number;
  generated_at: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
  truncated: boolean;
}

/**
 * Edges inside a path are lighter than full graph edges: `/api/graph/path`
 * includes confidence/properties, but the propagation path returned by
 * `POST /api/demo/trigger-event` omits them.
 */
export interface PathEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label: string;
  confidence?: number | null;
  properties?: Record<string, unknown>;
}

/**
 * The shared path shape. `found`/`hops` are present on `/api/graph/path` and on
 * `explanation.path`, and absent on the propagation path of a triggered event —
 * there, the path is always the causal chain that was just computed.
 */
export interface PathLike {
  found?: boolean;
  from?: string;
  to?: string;
  nodes: string[];
  edges: PathEdge[];
  hops?: number;
  narration?: string[];
}

export interface GraphPath extends PathLike {
  found: boolean;
  from: string;
  to: string;
  hops: number;
  narration: string[];
}

/* ----------------------------------------------------------------------- health */

export interface HealthCounts {
  people: number;
  teams: number;
  systems: number;
  projects: number;
  decisions: number;
  assumptions: number;
  facts: number;
  sources: number;
  events: number;
  alerts: number;
  nodes: number;
  edges: number;
}

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  time: string;
  /** Rendered verbatim in the UI so fixtures can never pass as a live system. */
  mode: string;
  dataset: {
    name: string;
    seeded_at: string;
    demo_clock?: string;
    revision: number;
    deterministic?: boolean;
  };
  counts: HealthCounts;
  source_counts_by_type?: Partial<Record<SourceType, number>>;
}

/* ------------------------------------------------------------------- demo state */

export interface Storyline {
  fact_id: string;
  new_fact_id?: string;
  assumption_id: string;
  decision_id: string;
  partner_id?: string;
  trigger_text: string;
}

export interface DemoState {
  phase: 'baseline' | 'event_applied';
  event_applied: boolean;
  revision: number;
  demo_clock: string;
  seeded_at: string;
  last_event: EventSummary | null;
  reset_available: boolean;
  counts: {
    nodes: number;
    edges: number;
    alerts_open: number;
    decisions_needing_review: number;
  };
  storyline: Storyline;
  thresholds?: { requires_investigation: number; uncertain_floor: number; method: string };

  /* ---- exposed only by the real backend; absent in reference/mock mode ---- */

  /** Backend-provided entity ids, so the UI never hardcodes an id. */
  key_entities?: Record<string, string>;
  /** Node counts per backend label ("Fact", "Decision", …). */
  by_label?: Record<string, number>;
  /** Edge counts per backend relationship ("SUPPORTED_BY", …). */
  by_rel?: Record<string, number>;
  dataset?: { name: string; version: string; storyline: string; matches_expected: Record<string, boolean> };
  llm?: { enabled: boolean; provider: string; model: string; note: string };
  history_summary?: Record<string, number>;
}

export interface EventSummary {
  id: string;
  type: string;
  summary: string;
  occurred_at: string;
  recorded_at: string;
  actor: string;
  source_id: string;
  raw_text: string;
  fact_ids?: string[];
  applied?: boolean;
}

/* ----------------------------------------------------------------------- sources */

export interface SourceRecord {
  id: string;
  type: SourceType;
  title: string;
  external_id?: string | null;
  author_id?: string | null;
  author_name?: string;
  timestamp: string;
  recorded_at?: string;
  text: string;
  excerpt?: string;
  simulated: boolean;
  operator_entry?: boolean;
  entity_ids?: string[];
  fact_ids?: string[];
  metadata?: Record<string, unknown>;
}

export interface ProvenanceStep {
  kind: ProvenanceKind;
  ref_id: string;
  label: string;
  actor?: string | null;
  at?: string;
  text?: string;
  simulated?: boolean;
  /** Present on `system_interpretation` steps: what Tripwire derived. */
  method?: string;
  confidence?: number | null;
  note?: string;
}

/* ------------------------------------------------------------------------- facts */

export interface FactSummary {
  id: string;
  statement: string;
  label?: string;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string | null;
  superseded_at?: string | null;
  belief?: string;
  current_state?: string;
  confidence: number | null;
}

export interface FactDetail {
  fact: GraphNode;
  statement: string;
  kind: string;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string | null;
  superseded_at: string | null;
  validity: string;
  confidence: number | null;
  sources: SourceRecord[];
  supports: Array<{ id: string; label: string }>;
  contradicted_by: GraphNode[];
  contradicts: GraphNode[];
  affects_decisions: DecisionSummary[];
  recorded_time_note?: string;
}

/* --------------------------------------------------------------------- decisions */

export interface DecisionSummary {
  id: string;
  title: string;
  status: DecisionStatus | string;
  owner_id: string | null;
  owner_name?: string;
  project_ids: string[];
  system_ids: string[];
  created_at: string;
  recorded_at: string;
  assumption_ids: string[];
  open_alert_count: number;
  review_state: string;
  confidence: number | null;
  graph_state?: NodeState;
  impact_weight?: number;
}

export interface AssumptionSummary {
  id: string;
  label: string;
  statement?: string;
  status: string;
  confidence: number | null;
  supported_by: string[];
  contradicted_by: string[];
  alternate_evidence?: AlternateEvidence[];
  decision_ids?: string[];
  state?: NodeState;
}

export interface AlternateEvidence {
  fact_id: string;
  summary?: string;
  effect: string;
  factor?: number;
  note?: string;
}

export interface DecisionPerson {
  id: string;
  name: string;
  role: string;
  reason: string;
  team_name?: string;
  rank?: number;
  is_official_owner?: boolean;
  uncertainty?: string;
}

export interface DecisionHistoryEntry {
  at: string;
  kind: string;
  summary: string;
  actor: string;
}

export interface DecisionDetail {
  decision: DecisionSummary;
  description?: string;
  assumptions: Array<{
    id: string;
    label: string;
    status: string;
    confidence: number | null;
    supported_by: string[];
    contradicted_by: string[];
    statement?: string;
  }>;
  supporting_facts: GraphNode[];
  contradicted_facts: GraphNode[];
  projects: Array<{ id: string; title: string }>;
  systems: Array<{ id: string; title: string }>;
  people: DecisionPerson[];
  sources: SourceRecord[];
  history: DecisionHistoryEntry[];
  alerts: Alert[];
  /** Relations the backend cannot establish. Rendered, never hidden. */
  unavailable: string[];
}

export interface Explanation {
  decision_id: string;
  headline: string;
  why_flagged: string[];
  /**
   * Null at the baseline revision: with no contradiction affecting the decision,
   * the backend reports a headline explaining exactly that, and these three
   * relations are null (with `unavailable: ["contradiction_path"]`).
   */
  new_information: { fact_id: string; summary: string; recorded_at: string; source_id?: string } | null;
  challenged_fact: {
    id: string;
    label: string;
    statement?: string;
    valid_from: string | null;
    valid_to: string | null;
    recorded_at?: string | null;
    superseded_at?: string | null;
    state?: NodeState;
  } | null;
  connecting_assumption: {
    id: string;
    label: string;
    statement?: string;
    status: string;
    confidence: number | null;
    alternate_evidence?: AlternateEvidence[];
  } | null;
  path: PathLike;
  supporting_sources: SourceRecord[];
  alternate_evidence: AlternateEvidence[];
  uncertainty: string[];
  suggested_investigators: Array<{
    id: string;
    name: string;
    role: string;
    reason: string;
    team_name?: string;
    uncertainty?: string;
  }>;
  generated_by: string;
  generated_at: string;
  unavailable?: string[];
}

/* ------------------------------------------------------------------------ alerts */

export interface AlertHistoryEntry {
  at: string;
  from: AlertStatus | null;
  to: AlertStatus;
  actor: string;
  note: string;
}

export interface Alert {
  id: string;
  status: AlertStatus;
  severity: Severity;
  title: string;
  what_changed: string;
  contradicted_fact_id: string | null;
  new_fact_id: string | null;
  assumption_ids: string[];
  decision_ids: string[];
  project_ids: string[];
  confidence: number | null;
  requires_investigation: boolean;
  why: string;
  path?: GraphPath | PathLike | null;
  source_ids: string[];
  people?: DecisionPerson[];
  event?: { id: string; occurred_at: string; recorded_at: string; actor: string } | null;
  history: AlertHistoryEntry[];
  created_at: string;
  updated_at: string;
  thresholds?: { requires_investigation: number; method: string };
  kind?: string;
  review_status_label?: string;
}

export interface AlertsResponse {
  alerts: Alert[];
  total: number;
  by_status: Partial<Record<AlertStatus, number>>;
  allowed_transitions?: Partial<Record<AlertStatus, AlertStatus[]>>;
  empty_reason?: string | null;
}

/* ------------------------------------------------------------------------ people */

export interface PersonSummary {
  id: string;
  name: string;
  team_id: string | null;
  team_name?: string;
  title?: string;
  official_owner_of: string[];
  contribution_count: number;
  project_ids: string[];
  system_ids: string[];
}

export interface Contribution {
  source_id: string;
  type: SourceType;
  title: string;
  at: string;
  why?: string;
}

export interface PersonDetail {
  person: PersonSummary;
  contributions: Contribution[];
  systems: Array<{ id: string; title: string }>;
  projects: Array<{ id: string; title: string }>;
  decisions: Array<{ id: string; title: string; role?: string }>;
  profile_note?: string;
}

export interface Expert {
  person_id: string;
  name: string;
  team_id: string | null;
  team_name?: string;
  title?: string;
  score: number;
  rank: number;
  is_official_owner: boolean;
  contribution_counts: Partial<Record<
    | 'tickets_authored'
    | 'tickets_resolved'
    | 'messages'
    | 'documents'
    | 'meeting_notes'
    | 'decisions_touched',
    number
  >>;
  total_contributions: number;
  evidence: Contribution[];
  ranking_explanation: string;
  uncertainty: string[];
  limitations: string;
}

export interface ExpertsResponse {
  system_id: string | null;
  system_label?: string;
  experts: Expert[];
  method: string;
  weights?: Record<string, number>;
  excluded: Array<{ person_id: string; name?: string; reason: string }>;
  for_alert_id?: string | null;
  alert_context?: string | null;
  recommended_contact?: {
    person_id: string;
    name: string;
    why: string;
    ranking_explanation?: string;
    uncertainty?: string[];
  } | null;

  /* ---- exposed only by the real backend ---- */

  /** Ranked contributors who are NOT the listed owner — the shadow org chart. */
  hidden_experts?: Expert[];
  /** Who the org chart says owns it, for contrast with the ranked list. */
  official_owners?: Array<{
    person_id: string;
    person_name: string;
    official_role?: string;
    team_name?: string;
    owns?: string;
  }>;
}

/* ------------------------------------------------------------------ history/time */

export interface HistoryFact {
  id: string;
  statement?: string;
  label?: string;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string | null;
  superseded_at: string | null;
  belief: 'believed_true' | 'believed_false' | 'unknown_yet' | 'later_contradicted' | string;
  current_state?: NodeState;
  confidence: number | null;
}

export interface HistoryChange {
  at: string;
  kind: string;
  entity_id: string;
  summary: string;
  actor: string;
}

export interface HistoryDecision {
  id: string;
  title: string;
  status_at_time: string;
  status_now: string;
  created_at: string;
  review_state_now?: string;
}

export interface HistoryResponse {
  as_of: string;
  mode: string;
  demo_clock?: string;
  seeded_at?: string;
  event_applied?: boolean;
  event_recorded_at?: string | null;
  facts: HistoryFact[];
  changes: HistoryChange[];
  timeline: TimelineEntry[];
  decisions: HistoryDecision[];
  notes?: string[];
}

export interface TimelineEntry {
  at: string;
  recorded_at?: string;
  kind: string;
  summary: string;
  entity_ids: string[];
  source_ids?: string[];
  actor: string;
  source_type?: SourceType;
}

export interface TimelineResponse {
  events: TimelineEntry[];
  total?: number;
  demo_clock?: string;
  seeded_at?: string;
}

/* ------------------------------------------------------------------------- misc */

export interface ProjectSummary {
  id: string;
  title: string;
  status?: string;
  team_id?: string | null;
  system_ids?: string[];
  decision_ids?: string[];
  assumption_ids?: string[];
  source_count?: number;
}

export interface SystemSummary {
  id: string;
  title: string;
  owner_id?: string | null;
  owner_name?: string;
  project_ids?: string[];
  fact_ids?: string[];
  criticality?: string;
}

export interface TeamSummary {
  id: string;
  name: string;
  person_ids?: string[];
  project_ids?: string[];
}

export interface SearchResult {
  id: string;
  type: NodeType;
  label: string;
  subtitle?: string;
  score: number;
  state?: NodeState;
}

export interface IntegrationDescriptor {
  id: string;
  label?: string;
  available: boolean;
  mechanism: string;
  accepted_types?: SourceType[];
  accepted_files?: string[];
  note: string;
}

export interface IntegrationsResponse {
  integrations: IntegrationDescriptor[];
  supported_source_types: SourceType[];
  extractor: string;
  honest_note: string;
}

/* ------------------------------------------------------------- event propagation */

export interface PropagationDecision {
  id: string;
  label: string;
  status: string;
  impact: Impact;
  confidence: number | null;
  requires_investigation: boolean;
  directly_relevant?: boolean;
  relevance_factor?: number;
  alternate_evidence: AlternateEvidence[];
  assumption_ids: string[];
  reason: string;

  /* ---- exposed only by the real backend ---- */

  /** "confirmed" | "potential" — the backend's own certainty, not a UI guess. */
  certainty?: string;
  status_before?: string;
  status_after?: string;
  /** Hops from the changed fact; 0 means the decision itself assumed it. */
  depth?: number;
  reviewers?: Array<{ person_id: string; person_name: string; rank?: number; reason?: string; normalized_score?: number }>;
  paths?: PathLike[];
}

export interface PropagationItem {
  id: string;
  label: string;
  impact?: Impact;
  reason?: string;
  status?: string;
  confidence?: number;
  requires_investigation?: boolean;
  alternate_evidence?: AlternateEvidence[];
}

export interface TriggerEventResponse {
  already_applied: boolean;
  event: EventSummary;
  source?: SourceRecord;
  extraction?: {
    method: string;
    confidence: number;
    new_fact: GraphNode;
    contradicted_fact: GraphNode;
    linked_entities: string[];
    claims: Array<{
      id: string;
      text: string;
      kind: string;
      confidence: number;
      needs_review: boolean;
      reason?: string;
      linked_entity_ids?: string[];
      materialised_fact_id?: string | null;
    }>;
    unparsed: string[];
  };
  propagation: {
    assumptions: Array<{
      id: string;
      label: string;
      relation: string;
      confidence: number;
      status?: string;
      alternate_evidence: AlternateEvidence[];
    }>;
    decisions: PropagationDecision[];
    projects: PropagationItem[];
    systems: PropagationItem[];
    not_affected: PropagationItem[];
    uncertain: PropagationItem[];
  };
  path: PathLike;
  alerts: Alert[];
  /** Fetched separately against the real backend; null until it lands. */
  explanation: Explanation | null;
  graph_revision: number;
  uncertainty: string[];

  /* ---- exposed only by the real backend ---- */

  /**
   * One row per entity the engine evaluated, including ones it deliberately did
   * NOT flag. This is the backend's own propagation answer; the UI no longer
   * recomputes it.
   */
  entity_impacts?: PropagationDecision[];
  /** Engine provenance, surfaced so the demo can show it is not hand-waved. */
  audit?: {
    applied_entity_ids: string[];
    source_fact_id: string;
    source_fact_status: string;
    source_fact_verified: boolean;
    max_depth: number;
    counts?: {
      assumptions: number;
      seed_decisions: number;
      affected_total: number;
      affected_decisions: number;
      affected_projects: number;
      confirmed: number;
      potential: number;
    };
    notes: string[];
    contradiction_summary?: {
      contradiction?: number;
      unverified?: number;
      ambiguous?: number;
      temporal?: number;
      additive?: number;
      unrelated?: number;
    };
    contradiction_candidates?: Array<{
      kind: string;
      existing_fact_id: string | null;
      new_fact_id: string | null;
      attribute: string | null;
      existing_value: string | null;
      new_value: string | null;
      confidence: number | null;
      rule: string | null;
      rationale: string;
      llm_assisted: boolean;
      already_recorded: boolean;
    }>;
    llm_used: boolean;
    scenario: string | null;
  };
}

export interface IngestResponse {
  status: string;
  source: SourceRecord;
  extraction: {
    method: string;
    claims: Array<{
      id: string;
      kind: string;
      text: string;
      confidence: number;
      needs_review: boolean;
      reason: string;
      linked_entity_ids: string[];
      materialised_fact_id: string | null;
    }>;
    linked_entity_ids: string[];
    unmatched_terms: string[];
  };
  graph_delta: { nodes_added: GraphNode[]; edges_added: GraphEdge[]; revision: number };
  impact: { alerts_created: Alert[]; note: string };
}
