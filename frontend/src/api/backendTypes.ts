/**
 * The REAL backend's wire contract (FastAPI, `TripWire/backend`).
 *
 * Every field here was observed in a live response captured under
 * `.probe-live/` — nothing is inferred from documentation.
 *
 * Two things differ from the frontend's view models in ways that matter:
 *   1. `label` is the **node kind** ("Fact"), and `name` is the **display text**.
 *      `type` duplicates `label`. The adapter inverts these deliberately.
 *   2. Statuses are UPPER_SNAKE ("POTENTIALLY_STALE") and relationships are
 *      UPPERCASE ("SUPPORTED_BY").
 *
 * Nodes are intentionally permissive: the backend returns a different field set
 * per label (a Fact carries `valid_from`, an Alert carries `path_nodes`), and
 * inventing a closed union would misrepresent that.
 */

export interface RawStoreInfo {
  backend: string;
  ok: boolean;
  nodes: number;
  edges: number;
}

export interface RawHealth {
  status: string;
  store: RawStoreInfo;
  configured_backend: string;
  active_backend: string;
  seeded: boolean;
  llm_enabled: boolean;
  checked_at: string;
}

export interface RawDemoState {
  seeded: boolean;
  dataset: {
    name: string;
    version: string;
    storyline: string;
    expected_counts: Record<string, number>;
    actual_counts: Record<string, number>;
    matches_expected: Record<string, boolean>;
  };
  store: {
    configured_backend: string;
    active_backend: string;
    health: RawStoreInfo;
  };
  llm: { enabled: boolean; provider: string; model: string; note: string };
  counts: {
    nodes: number;
    edges: number;
    by_label: Record<string, number>;
    by_rel: Record<string, number>;
  };
  /** Verification-critical: lets the UI avoid hardcoding any entity id. */
  key_entities: Record<string, string>;
  alerts: { total: number; status_counts: Record<string, number> };
  history: {
    facts_total: number;
    facts_open_belief: number;
    facts_closed_belief: number;
    facts_invalidated: number;
    facts_contested: number;
    status_change_events: number;
  };
  config?: {
    store_backend?: string;
    store_fallback?: boolean;
    state_path?: string;
    falkordb?: { host: string; port: number; graph: string; username: string | null; password_configured: boolean };
    llm?: { provider: string; model: string; enabled: boolean; api_key_configured: boolean };
    limits?: { max_propagation_depth: number; verified_confidence_floor: number };
    environment?: string;
  };
}

/** A graph node. `label` is the kind; `name` is the display text. */
export interface RawNode {
  id: string;
  /** The KIND, e.g. "Fact". Not a display label. */
  label: string;
  /** Duplicates `label`. Kept because the backend sends it. */
  type?: string;
  /** The DISPLAY text, e.g. "Frankfurt Hosting Partner holds a current…". */
  name?: string;
  title?: string;
  statement?: string;
  summary?: string;
  reason?: string;
  status?: string | null;
  severity?: string | null;
  certainty?: string | null;
  certainty_status?: string | null;
  confidence?: number | null;
  review_status?: string | null;
  verified?: boolean | null;
  // fact fields
  subject_id?: string | null;
  subject_name?: string | null;
  attribute?: string | null;
  value?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  recorded_to?: string | null;
  recorded_at?: string | null;
  // decision fields
  decision_key?: string;
  made_at?: string | null;
  created_at?: string | null;
  previous_status?: string | null;
  stale_reason?: string | null;
  stale_since?: string | null;
  stale_cause_fact_id?: string | null;
  stale_certainty?: string | null;
  stale_alert_ids?: string[];
  last_evaluated_at?: string | null;
  // source fields
  source_system?: string | null;
  external_id?: string | null;
  doc_type?: string | null;
  document_type?: string | null;
  channel?: string | null;
  timestamp?: string | null;
  text?: string | null;
  author_id?: string | null;
  source_ref?: string | null;
  // alert fields
  dedupe_key?: string | null;
  old_fact_id?: string | null;
  new_fact_id?: string | null;
  entity_id?: string | null;
  entity_label?: string | null;
  entity_name?: string | null;
  trigger_assumption_id?: string | null;
  path_nodes?: string[];
  path_rels?: string[];
  source_refs?: string[];
  evidence_fact_ids?: string[];
  certainty_sources?: string[];
  occurrences?: number;
  notified_externally?: boolean;
  reviewers?: string[];
  reviewers_assigned_at?: string | null;
  review_note?: string | null;
  updated_at?: string | null;
  last_seen_at?: string | null;
  affected?: Array<{ entity_id: string; certainty?: string; reason?: string }>;
  [key: string]: unknown;
}

export interface RawEdge {
  id: string;
  source: string;
  target: string;
  /** UPPERCASE relationship name, e.g. "SUPPORTED_BY". */
  rel?: string;
  type?: string;
  at?: string | null;
  certainty?: string | null;
  confidence?: number | null;
  reason?: string | null;
  props?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RawGraph {
  nodes: RawNode[];
  edges: RawEdge[];
  meta: {
    node_count: number;
    edge_count: number;
    total_nodes: number;
    total_edges: number;
    truncated: boolean;
    focus?: string | null;
    depth?: number | null;
  };
}

/* ------------------------------------------------------------------- alerts */

export interface RawAlert {
  id: string;
  label: string;
  type?: string;
  name?: string;
  status: string;
  severity: string;
  certainty?: string | null;
  confidence?: number | null;
  title?: string;
  summary?: string;
  reason?: string;
  dedupe_key?: string;
  old_fact_id?: string | null;
  new_fact_id?: string | null;
  entity_id?: string | null;
  entity_label?: string | null;
  entity_name?: string | null;
  attribute?: string | null;
  trigger_assumption_id?: string | null;
  path_nodes?: string[];
  path_rels?: string[];
  source_refs?: string[];
  evidence_fact_ids?: string[];
  certainty_sources?: string[];
  determined_by?: string[];
  created_at?: string;
  recorded_at?: string;
  updated_at?: string;
  occurrences?: number;
  review_status?: string | null;
  notified_externally?: boolean;
  certainty_status?: string | null;
  reviewers?: string[];
  reviewers_assigned_at?: string | null;
  previous_status?: string | null;
  review_note?: string | null;
  last_seen_at?: string | null;
  affected?: Array<{ entity_id: string; certainty?: string; reason?: string }>;
  [key: string]: unknown;
}

export interface RawAlertList {
  total: number;
  count: number;
  limit: number;
  offset: number;
  status_counts: Record<string, number>;
  alerts: RawAlert[];
}

export interface RawAlertTransition {
  event_id: string;
  event_type: string;
  at: string;
  from_status: string | null;
  to_status: string;
  actor_id: string;
  summary?: string;
  note?: string | null;
}

export interface RawAlertHistory {
  alert_id: string;
  status: string;
  history: RawAlertTransition[];
  previous_status?: string | null;
  created_at?: string;
  updated_at?: string;
  occurrences?: number;
}

/* -------------------------------------------------- contradiction / trigger */

export interface RawConflictCandidate {
  kind: string;
  existing_fact_id?: string | null;
  new_fact_id?: string;
  attribute?: string | null;
  existing_value?: string | null;
  new_value?: string | null;
  severity?: string;
  confidence?: number | null;
  rationale?: string;
  review_status?: string | null;
  explicit_rule?: string | null;
  llm_assisted?: boolean;
  temporal_overlap?: boolean | null;
  contradicts?: boolean;
  already_recorded?: boolean;
  /** present on non-contradiction kinds: additive / temporal / unverified / ambiguous / unrelated */
  related_fact_id?: string | null;
  [key: string]: unknown;
}

export interface RawContradictionReport {
  new_fact_id?: string;
  new_claim?: {
    fact_id: string;
    subject_id?: string;
    subject_name?: string;
    attribute?: string;
    value?: string;
    polarity?: number;
    valid_from?: string | null;
    valid_to?: string | null;
    recorded_at?: string | null;
    recorded_to?: string | null;
    confidence?: number | null;
    verified?: boolean;
    status?: string;
    source_id?: string | null;
    statement?: string;
  };
  contradiction_found: boolean;
  considered?: number;
  llm_used?: boolean;
  summary?: {
    contradiction?: number;
    unverified?: number;
    ambiguous?: number;
    temporal?: number;
    additive?: number;
    unrelated?: number;
  };
  notes?: string[];
  candidates?: RawConflictCandidate[];
  primary?: RawConflictCandidate | null;
  detected?: boolean;
}

export interface RawAlternateEvidence {
  assumption_id: string;
  assumption_name?: string;
  fact_id: string;
  fact_name?: string;
  fact_value?: string;
  value?: string;
  fact_status?: string;
  status?: string;
  fact_confidence?: number | null;
  source_id?: string | null;
  source_count?: number;
  why_survives?: string;
}

export interface RawPath {
  nodes: string[];
  rels: string[];
  length: number;
  steps?: Array<{
    src: string;
    rel: string;
    dst: string;
    src_name?: string;
    dst_name?: string;
    src_label?: string;
    dst_label?: string;
    props?: Record<string, unknown>;
  }>;
  narrative?: string;
}

export interface RawReviewer {
  person_id: string;
  person_name: string;
  rank?: number;
  reason?: string;
  normalized_score?: number;
}

export interface RawImpact {
  entity_id: string;
  entity_label: string;
  entity_name: string;
  status_before: string;
  status_after: string;
  flagged: boolean;
  certainty: string;
  depth: number;
  reason: string;
  has_alternate_evidence?: boolean;
  alternate_evidence?: RawAlternateEvidence[];
  paths?: RawPath[];
  alert?: {
    alert_id: string;
    status: string;
    created?: boolean;
    certainty?: string;
    severity?: string;
    confidence?: number | null;
    title?: string;
    summary?: string;
    reviewers?: string[];
  } | null;
  reviewers?: RawReviewer[];
  [key: string]: unknown;
}

export interface RawTriggerResponse {
  event: {
    triggered_at: string;
    scenario?: string | null;
    actor_id?: string | null;
    applied?: boolean;
    llm_enabled?: boolean;
    [key: string]: unknown;
  };
  assertion?: {
    fact_id: string;
    created: boolean;
    fact: RawNode;
    source_id?: string | null;
    author_id?: string | null;
  } | null;
  contradiction: RawContradictionReport;
  /** Ids of entities whose status the engine actually wrote. */
  applied: string[];
  contradiction_edges: RawEdge[];
  staleness: {
    source_fact_id: string;
    applied_at: string;
    impact_count: number;
    decision_count: number;
    project_count: number;
    impacts: RawImpact[];
    notes: string[];
  };
  propagation: {
    source_fact_id: string;
    source_fact_name: string;
    source_fact_status: string;
    source_fact_verified: boolean;
    evaluated_at: string;
    max_depth: number;
    assumptions: string[];
    seed_decisions: string[];
    counts: {
      assumptions: number;
      seed_decisions: number;
      affected_total: number;
      affected_decisions: number;
      affected_projects: number;
      confirmed: number;
      potential: number;
    };
    affected: Array<{
      entity_id: string;
      entity_name: string;
      entity_label: string;
      seed_decision_id: string;
      depth: number;
      certainty: string;
      status_before: string;
      status_after: string;
      contributing_assumptions: string[];
      contributing_facts: string[];
      alternate_evidence: RawAlternateEvidence[];
      has_alternate_evidence: boolean;
      reason: string;
      hops?: number;
      paths: RawPath[];
    }>;
    notes: string[];
  };
  impacts: RawImpact[];
  alert_ids: string[];
}

/* --------------------------------------------------------------- decisions */

export interface RawDecisionExplanation {
  found: boolean;
  decision_id?: string | null;
  decision?: RawNode | null;
  status?: string | null;
  previous_status?: string | null;
  stale_reason?: string | null;
  stale_since?: string | null;
  review_status?: string | null;
  why_flagged?: string;
  confidence?: number | null;
  assumption_count?: number;
  dependencies: Array<{
    assumption_id: string;
    name: string;
    statement?: string;
    status?: string;
    confidence?: number | null;
    edge_recorded_at?: string | null;
    facts: Array<{
      fact_id: string;
      found?: boolean;
      name?: string;
      statement?: string;
      value?: string;
      attribute?: string;
      subject_id?: string;
      subject_name?: string;
      status?: string;
      confidence?: number | null;
      verified?: boolean;
      valid_from?: string | null;
      valid_to?: string | null;
      recorded_at?: string | null;
      recorded_to?: string | null;
      sources?: RawSourceRef[];
      edge_recorded_at?: string | null;
    }>;
  }>;
  evidence_paths: Array<{ from_fact_id: string; assumption_id: string; path: RawPath }>;
  alerts: Array<{
    alert_id: string;
    status: string;
    severity?: string;
    certainty?: string;
    confidence?: number | null;
    summary?: string;
    created_at?: string;
    reason?: string;
  }>;
  alternate_evidence: RawAlternateEvidence[];
  people: Array<{ person_id: string; person_name: string; relation: string; detail?: string }>;
  missing: string[];
  generated_at: string;
}

export interface RawSourceRef {
  source_id: string;
  label?: string;
  name?: string;
  doc_type?: string | null;
  timestamp?: string | null;
  source_ref?: string | null;
  url?: string | null;
  author_id?: string | null;
  author_name?: string | null;
  channel?: string | null;
  confidence?: number | null;
  excerpt?: string | null;
}

export interface RawFactExplanation {
  found: boolean;
  fact_id?: string | null;
  fact?: RawNode | null;
  provenance?: (RawSourceRef & {
    found?: boolean;
    statement?: string;
    value?: string;
    attribute?: string;
    status?: string;
    confidence?: number | null;
    verified?: boolean;
    valid_from?: string | null;
    valid_to?: string | null;
    recorded_at?: string | null;
    recorded_to?: string | null;
    sources?: RawSourceRef[];
  }) | null;
  contradictions: Array<{
    new_fact_id: string;
    new_fact_name?: string;
    new_value?: string;
    other_fact_id: string;
    other_fact_name?: string;
    other_value?: string;
    kind: string;
    status?: string;
    confidence?: number | null;
    review_status?: string | null;
    at?: string;
    rule?: string;
    rationale?: string;
  }>;
  contradiction_count?: number;
  supporting_assumptions: Array<{ assumption_id: string; name: string }>;
  affected_entities: Array<{
    entity_id: string;
    entity_name: string;
    entity_label: string;
    reason?: string;
    at?: string;
    alert_id?: string | null;
  }>;
  missing: string[];
  generated_at: string;
}

/* ----------------------------------------------------------------- experts */

/** One recorded contribution to an artifact, as returned by `GET /api/experts`. */
export interface RawContribution {
  person_id?: string;
  person_name?: string;
  artifact_id?: string;
  artifact_label?: string;
  artifact_name?: string;
  contribution_type?: string;
  source_ref?: string;
  weight?: number;
  relevance?: number;
  recency?: number;
  quality?: number;
  score?: number;
  timestamp?: string;
  note?: string;
  [key: string]: unknown;
}

export interface RawExpert {
  rank: number;
  person_id: string;
  person_name: string;
  role?: string;
  team_name?: string;
  score: number;
  normalized_score?: number;
  contribution_counts?: Record<string, number>;
  contribution_total?: number;
  systems?: Array<{ id?: string; name?: string } | string>;
  projects?: Array<{ id?: string; name?: string } | string>;
  is_official_owner?: boolean;
  official_owner_of?: string[];
  shadow_signal?: boolean;
  reason?: string;
  uncertainty?: string | string[] | null;
  evidence_refs?: string[];
  /**
   * Verified shape from `GET /api/experts`. The artifact fields are `artifact_*`
   * and the action is `contribution_type` — there is no `label` or `source_id`,
   * which is why reading those crashed the expert panel.
   */
  contributions?: RawContribution[];
  [key: string]: unknown;
}

export interface RawExpertsResponse {
  query?: string | null;
  experts: RawExpert[];
  target_id?: string | null;
  target_label?: string | null;
  target_name?: string | null;
  method?: string;
  notes?: string[];
  related_targets?: Array<{ id?: string; name?: string; label?: string } | string>;
  official_owners?: Array<{
    person_id: string;
    person_name: string;
    official_role?: string;
    team_name?: string;
    owns?: string;
    owns_name?: string;
  }>;
  hidden_experts?: RawExpert[];
}

/* ------------------------------------------------------------------ sources */

export interface RawSource {
  id: string;
  label: string;
  type?: string;
  name?: string;
  source_system?: string | null;
  external_id?: string | null;
  doc_type?: string | null;
  document_type?: string | null;
  title?: string | null;
  text?: string | null;
  channel?: string | null;
  timestamp?: string | null;
  recorded_at?: string | null;
  source_ref?: string | null;
  confidence?: number | null;
  status?: string | null;
  author_id?: string | null;
  [key: string]: unknown;
}

export interface RawSourceList {
  total: number;
  count: number;
  limit: number;
  offset: number;
  sources: RawSource[];
}

export interface RawSourceDetail {
  source: RawSource;
  states?: RawNode[];
  states_count?: number;
}

/* ------------------------------------------------------------------ history */

export interface RawHistoryBelief {
  at: string;
  label?: string;
  total: number;
  facts: RawNode[];
}

export interface RawHistoryValid {
  at: string;
  total: number;
  facts: RawNode[];
  subject_id?: string | null;
  attribute?: string | null;
}

export interface RawHistoryChanges {
  since: string;
  facts: Array<{
    fact_id: string;
    name?: string;
    recorded_at?: string;
    statement?: string;
    status?: string;
    source_id?: string | null;
  }>;
  fact_count: number;
  events: Array<{
    event_id: string;
    event_type: string;
    recorded_at: string;
    summary?: string;
    actor_id?: string | null;
  }>;
  event_count: number;
}

/* --------------------------------------------------------------------- misc */

export interface RawSearchResponse {
  query?: string;
  total: number;
  results: RawNode[];
}

export interface RawIngestAdapters {
  available: boolean;
  adapters: Array<{
    name: string;
    source_system: string;
    produces_label?: string;
    default_doc_type?: string | null;
    description?: string;
    integration_type?: string;
    integration_note?: string;
    input_shape?: Record<string, string>;
  }>;
  message?: string | null;
}

export interface RawPathsResponse {
  found: boolean;
  source?: RawNode | null;
  target?: RawNode | null;
  path_count?: number;
  paths: RawPath[];
  reason?: string;
  generated_at?: string;
}

export interface RawResetResponse {
  status?: string;
  seeded?: boolean;
  [key: string]: unknown;
}

export interface RawSeedResponse {
  seeded?: boolean;
  counts?: Record<string, number>;
  [key: string]: unknown;
}

/** Node kinds emitted by the backend. */
export const RAW_LABELS = [
  'Person',
  'Team',
  'System',
  'Project',
  'Decision',
  'Assumption',
  'Fact',
  'Message',
  'Document',
  'Event',
  'Alert',
] as const;

export type RawLabel = (typeof RAW_LABELS)[number];
