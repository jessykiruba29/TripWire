/**
 * Adapter: real backend wire format → the frontend's existing view models.
 *
 * This is the ONLY place that knows both vocabularies. Components keep consuming
 * `types.ts`, so no UI component had to be rewritten for the real backend.
 *
 * The two inversions handled here (see docs/FRONTEND_BACKEND_MAPPING.md §1.1):
 *   backend.label ("Fact")  → view.type  ("fact")
 *   backend.name  ("Frankfurt Hosting Partner holds…") → view.label
 *
 * Everything is a pure function: no fetching, no clock reads beyond an injectable
 * `now`, so the whole mapping is deterministic and unit-testable against captured
 * real payloads.
 */

import type {
  Alert,
  AlertHistoryEntry,
  AlertsResponse,
  AlternateEvidence,
  AssumptionSummary,
  DecisionDetail,
  DecisionSummary,
  DemoState,
  EventSummary,
  Expert,
  ExpertsResponse,
  Explanation,
  FactDetail,
  GraphEdge,
  GraphNode,
  GraphPath,
  HistoryFact,
  HistoryResponse,
  HistoryDecision,
  NodeState,
  NodeType,
  PathEdge,
  PathLike,
  ProvenanceStep,
  SourceRecord,
  SourceType,
  TimelineEntry,
  TimelineResponse,
  TriggerEventResponse,
  HealthResponse,
} from './types';

import type {
  RawAlert,
  RawAlertHistory,
  RawAlertList,
  RawDemoState,
  RawDecisionExplanation,
  RawEdge,
  RawExpert,
  RawExpertsResponse,
  RawFactExplanation,
  RawGraph,
  RawHealth,
  RawHistoryBelief,
  RawHistoryChanges,
  RawNode,
  RawPath,
  RawSource,
  RawSourceDetail,
  RawSourceRef,
  RawTriggerResponse,
} from './backendTypes';

/* ------------------------------------------------------------- vocabularies */

/**
 * Backend node kind ("Fact") → view type ("fact").
 *
 * The backend also emits `Alert` nodes, which have no equivalent in the view
 * vocabulary; they map to `event`, because an alert *is* a recorded signal about
 * a change rather than a knowledge entity in its own right.
 */
const KIND_TO_TYPE: Record<string, NodeType> = {
  person: 'person',
  team: 'team',
  system: 'system',
  project: 'project',
  decision: 'decision',
  assumption: 'assumption',
  fact: 'fact',
  message: 'message',
  document: 'document',
  doc: 'document',
  event: 'event',
  alert: 'event',
};

export function toNodeType(label: string | null | undefined): NodeType {
  const key = String(label ?? '').trim().toLowerCase();
  return KIND_TO_TYPE[key] ?? 'document';
}

/**
 * A fact has been superseded when its *record* was closed — `recorded_to`.
 *
 * `valid_to` alone is NOT evidence of contradiction: the seed dataset uses it for
 * scheduled expiry (a SOC 2 attestation valid until 2027, a rate hold until
 * 2027-01-01). Treating those as contradicted would have shown three healthy
 * facts as broken. Verified live: the superseded compliance fact has
 * `valid_to === recorded_to === 2026-02-20T08:15:00Z`, while the attestation has
 * `valid_to === 2027-03-31` and `recorded_to === null`.
 */
export function isClosedFact(node: RawNode): boolean {
  if (String(node.label ?? '').toLowerCase() !== 'fact') return false;
  return Boolean(node.recorded_to) || String(node.status ?? '').toUpperCase() === 'CONTRADICTED';
}

/**
 * Backend status → view state.
 *
 * A contradicted fact keeps `status: "ACTIVE"`, so the status flag alone is not
 * enough — `isClosedFact` covers that case.
 */
export function toNodeState(node: RawNode): NodeState {
  const status = String(node.status ?? '').toUpperCase();

  if (status === 'CONTRADICTED') return 'contradicted';
  if (status === 'CONFIRMED_STALE' || status === 'STALE') return 'confirmed_stale';
  if (status === 'DISMISSED') return 'dismissed';
  if (status === 'REVIEWED' || status === 'RESOLVED') return 'resolved';
  if (status === 'NEEDS_REVIEW') return 'needs_review';
  if (status === 'POTENTIALLY_STALE' || status === 'POTENTIAL') return 'potentially_affected';
  if (isClosedFact(node)) return 'contradicted';

  return 'normal';
}

/** Decision status for the decisions panel. */
export function toDecisionStatus(node: RawNode): string {
  const status = String(node.status ?? '').toUpperCase();
  const review = String(node.review_status ?? '').toUpperCase();
  if (status === 'STALE' || status === 'CONFIRMED_STALE') return 'confirmed_stale';
  if (status === 'POTENTIALLY_STALE' || status === 'POTENTIAL') {
    const certainty = String(node.certainty ?? node.stale_certainty ?? '').toUpperCase();
    if (review === 'NEEDS_REVIEW' || certainty !== 'CONFIRMED') return 'needs_review';
    return 'potential';
  }
  if (status === 'NEEDS_REVIEW') return 'needs_review';
  if (status === 'REVIEWED' || status === 'RESOLVED') return 'resolved';
  if (status === 'DISMISSED') return 'dismissed';
  return 'active';
}

/** "SUPPORTED_BY" → "supported_by". */
export function toEdgeType(rel: string | null | undefined): string {
  return String(rel ?? 'related_to').toLowerCase();
}

/** The display text for a node: `name`, falling back sensibly. */
export function displayName(node: RawNode): string {
  return (
    node.name ||
    node.title ||
    node.statement ||
    node.text ||
    node.summary ||
    node.id ||
    'Unnamed entity'
  );
}

/** A short human-readable form of an id like "fact:frankfurt-partner-…". */
export function readableId(id: string): string {
  const parts = String(id).split(':');
  const tail = parts.length > 1 ? parts.slice(1).join(':') : parts[0];
  return tail
    .replace(/^[0-9a-f]{8,}$/, (m) => m.slice(0, 8))
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function primaryText(node: RawNode | null | undefined): string {
  if (!node) return '';
  return node.summary || node.statement || node.reason || '';
}

/* --------------------------------------------------------------------- graph */

export function adaptGraphEdge(raw: RawEdge): GraphEdge {
  return {
    id: raw.id,
    source: raw.source,
    target: raw.target,
    type: toEdgeType(raw.rel ?? raw.type) as GraphEdge['type'],
    label: raw.rel ?? raw.type ?? 'related_to',
    confidence: raw.confidence ?? null,
    properties: {
      ...(raw.props ?? {}),
      ...(raw.at ? { at: raw.at } : {}),
      ...(raw.certainty ? { certainty: raw.certainty } : {}),
      ...(raw.reason ? { reason: raw.reason } : {}),
    },
  };
}

export function adaptGraphNode(raw: RawNode, edges: RawEdge[] = []): GraphNode {
  const degree = edges.reduce(
    (count, edge) => count + (edge.source === raw.id || edge.target === raw.id ? 1 : 0),
    0,
  );

  return {
    id: raw.id,
    type: toNodeType(raw.label),
    // INVERSION: `name` is the display text on this backend.
    label: displayName(raw),
    state: toNodeState(raw),
    summary: primaryText(raw),
    confidence: raw.confidence ?? null,
    project_ids: [],
    team_ids: [],
    valid_from: raw.valid_from ?? null,
    valid_to: raw.valid_to ?? null,
    recorded_at: raw.recorded_at ?? raw.timestamp ?? raw.created_at ?? null,
    degree,
    source_ids: raw.source_refs ?? (raw.source_ref ? [raw.source_ref] : []),
    properties: {
      backend_label: raw.label,
      status: raw.status ?? null,
      review_status: raw.review_status ?? null,
      certainty: raw.certainty ?? null,
      attribute: raw.attribute ?? null,
      value: raw.value ?? null,
      subject_id: raw.subject_id ?? null,
      subject_name: raw.subject_name ?? null,
      verified: raw.verified ?? null,
      recorded_to: raw.recorded_to ?? null,
      ...(raw.stale_reason ? { stale_reason: raw.stale_reason } : {}),
      ...(raw.stale_since ? { stale_since: raw.stale_since } : {}),
    },
  };
}

export interface AdaptedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
}

export function adaptGraph(raw: RawGraph): AdaptedGraph {
  const edges = (raw.edges ?? []).map(adaptGraphEdge);
  const nodes = (raw.nodes ?? []).map((node) => adaptGraphNode(node, raw.edges ?? []));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return { nodes, edges, byId };
}

/* ------------------------------------------------------------------ decisions */

export function adaptDecisionSummary(raw: RawNode): DecisionSummary {
  return {
    id: raw.id,
    title: displayName(raw),
    status: toDecisionStatus(raw),
    owner_id: null,
    owner_name: undefined,
    project_ids: [],
    system_ids: [],
    created_at: raw.created_at ?? raw.made_at ?? raw.recorded_at ?? '',
    recorded_at: raw.recorded_at ?? raw.created_at ?? '',
    assumption_ids: [],
    open_alert_count: raw.stale_alert_ids?.length ?? 0,
    review_state: String(raw.review_status ?? '').toLowerCase(),
    confidence: raw.confidence ?? null,
    graph_state: toNodeState(raw),
  };
}

/**
 * The real backend has no `/api/decisions` list endpoint. Decisions are derived
 * from the graph, which is the same source of truth — not invented here.
 */
export function adaptDecisionList(rawNodes: RawNode[]): DecisionSummary[] {
  return rawNodes
    .filter((node) => String(node.label).toLowerCase() === 'decision')
    .map(adaptDecisionSummary);
}

/* --------------------------------------------------------------------- alerts */

function pathFromParallelArrays(nodes: string[] = [], rels: string[] = []): PathLike {
  const edges: PathEdge[] = [];
  for (let i = 0; i < rels.length; i += 1) {
    const source = nodes[i];
    const target = nodes[i + 1];
    if (!source || !target) break;
    edges.push({
      id: `${source}->${target}#${rels[i]}`,
      source,
      target,
      type: toEdgeType(rels[i]) as PathEdge['type'],
      label: rels[i],
    });
  }
  return { nodes, edges };
}

export function adaptAlert(raw: RawAlert): Alert {
  const decisionIds: string[] = [];
  if (String(raw.entity_label ?? '').toLowerCase() === 'decision' && raw.entity_id) {
    decisionIds.push(raw.entity_id);
  }

  return {
    id: raw.id,
    status: raw.status as Alert['status'],
    severity: (raw.severity as Alert['severity']) ?? 'medium',
    title: raw.title ?? displayName(raw as unknown as RawNode),
    what_changed: raw.summary ?? '',
    contradicted_fact_id: raw.old_fact_id ?? null,
    new_fact_id: raw.new_fact_id ?? null,
    assumption_ids: raw.trigger_assumption_id ? [raw.trigger_assumption_id] : [],
    decision_ids: decisionIds,
    project_ids: String(raw.entity_label ?? '').toLowerCase() === 'project' && raw.entity_id ? [raw.entity_id] : [],
    confidence: raw.confidence ?? null,
    // "Flagged for review" means a human still has to look — never a verdict.
    requires_investigation: raw.status !== 'DISMISSED' && raw.status !== 'RESOLVED',
    why: raw.reason ?? raw.summary ?? '',
    path: pathFromParallelArrays(raw.path_nodes, raw.path_rels),
    source_ids: raw.source_refs ?? [],
    people: (raw.reviewers ?? []).map((personId) => ({
      id: personId,
      name: readableId(personId),
      role: 'reviewer',
      reason: 'Assigned as a reviewer by the backend.',
    })),
    event: null,
    history: [],
    created_at: raw.created_at ?? '',
    updated_at: raw.updated_at ?? raw.created_at ?? '',
    kind: raw.certainty ?? undefined,
    review_status_label: raw.review_status ?? undefined,
  };
}

export function adaptAlertList(raw: RawAlertList): AlertsResponse {
  const alerts = (raw.alerts ?? []).map(adaptAlert);
  return {
    alerts,
    total: raw.total ?? alerts.length,
    by_status: (raw.status_counts ?? {}) as AlertsResponse['by_status'],
  };
}

export function adaptAlertHistory(raw: RawAlertHistory): AlertHistoryEntry[] {
  return (raw.history ?? []).map((entry) => ({
    at: entry.at,
    from: (entry.from_status as AlertHistoryEntry['from']) ?? null,
    to: entry.to_status as AlertHistoryEntry['to'],
    actor: entry.actor_id ?? 'unknown',
    note: entry.note ?? entry.summary ?? '',
  }));
}

/* --------------------------------------------------------------- explanation */

function adaptRawPath(path: RawPath | undefined | null): PathLike {
  if (!path) return { nodes: [], edges: [] };
  return {
    nodes: path.nodes ?? [],
    edges: (path.rels ?? []).flatMap((rel, index) => {
      const source = path.nodes?.[index];
      const target = path.nodes?.[index + 1];
      if (!source || !target) return [];
      return [
        {
          id: `${source}->${target}#${rel}`,
          source,
          target,
          type: toEdgeType(rel) as PathEdge['type'],
          label: rel,
        } satisfies PathEdge,
      ];
    }),
    hops: typeof path.length === 'number' ? path.length : undefined,
    narration: path.narrative ? [path.narrative] : [],
  };
}

export function adaptSourceRef(ref: RawSourceRef): SourceRecord {
  return {
    id: ref.source_id,
    type: 'slack_message' as SourceType,
    title: ref.name ?? ref.source_ref ?? ref.source_id,
    external_id: ref.source_ref ?? null,
    author_id: ref.author_id ?? null,
    author_name: ref.author_name ?? (ref.author_id ? readableId(ref.author_id) : undefined),
    timestamp: ref.timestamp ?? '',
    recorded_at: ref.timestamp ?? undefined,
    text: ref.excerpt ?? '',
    excerpt: ref.excerpt ?? undefined,
    // The reference backend marks fixtures explicitly; the real backend serves
    // seeded records, so "simulated" is false and the UI says "Live record".
    simulated: false,
  };
}

/**
 * Real decision explanation → view `Explanation`.
 *
 * The backend's `why_flagged` is a newline-joined narrative; the view model wants
 * an array, so it is split here rather than in the component.
 */
export function adaptExplanation(
  raw: RawDecisionExplanation,
  nodeIndex?: Map<string, GraphNode>,
): Explanation {
  const whyFlagged = (raw.why_flagged ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const dependency = raw.dependencies?.[0];
  const facts = dependency?.facts ?? [];
  // The challenged fact is the one whose RECORD was closed (`recorded_to`), not
  // merely one with a scheduled `valid_to`. The new information is the one whose
  // record is still open.
  const closed = (fact: (typeof facts)[number]) => Boolean(fact.recorded_to);
  const challenged = facts.find(closed) ?? facts.find((fact) => Boolean(fact.valid_to)) ?? facts[0];
  const incoming = facts.find((fact) => !closed(fact) && !fact.valid_to) ?? facts.find((fact) => !closed(fact)) ?? facts[1] ?? facts[0];

  const supportingSources: SourceRecord[] = [];
  for (const fact of facts) {
    for (const ref of fact.sources ?? []) supportingSources.push(adaptSourceRef(ref));
  }

  const path = adaptRawPath(raw.evidence_paths?.[0]?.path);

  const label = (id: string | undefined, fallback?: string) =>
    (id ? nodeIndex?.get(id)?.label : undefined) ?? fallback ?? readableId(id ?? '');

  return {
    decision_id: raw.decision_id ?? raw.decision?.id ?? '',
    headline: whyFlagged[0] ?? primaryText(raw.decision ?? undefined) ?? 'No explanation was returned.',
    why_flagged: whyFlagged,
    new_information: incoming
      ? {
          fact_id: incoming.fact_id,
          summary: incoming.statement ?? incoming.name ?? '',
          recorded_at: incoming.recorded_at ?? '',
          source_id: undefined,
        }
      : null,
    challenged_fact: challenged
      ? {
          id: challenged.fact_id,
          label: challenged.name ?? label(challenged.fact_id),
          statement: challenged.statement,
          valid_from: challenged.valid_from ?? null,
          valid_to: challenged.valid_to ?? null,
          recorded_at: challenged.recorded_at ?? null,
          superseded_at: challenged.recorded_to ?? null,
          state: closed(challenged) ? 'contradicted' : 'normal',
        }
      : null,
    connecting_assumption: dependency
      ? {
          id: dependency.assumption_id,
          label: dependency.name,
          statement: dependency.statement,
          status: String(dependency.status ?? 'unknown').toLowerCase(),
          confidence: dependency.confidence ?? null,
          alternate_evidence: [],
        }
      : null,
    path,
    supporting_sources: dedupeSources(supportingSources),
    alternate_evidence: (raw.alternate_evidence ?? []).map(adaptAlternateEvidence),
    uncertainty: [
      ...(raw.missing ?? []).map((item) => `Not available from the backend: ${item}.`),
      ...(raw.review_status === 'CONFIRMED_STALE'
        ? []
        : [
            `This is a ${String(raw.status ?? 'possible').toLowerCase().replace(/_/g, ' ')} assessment with review status ${
              raw.review_status ?? 'unknown'
            }. Tripwire reports it for a human to confirm; it is not a verdict.`,
          ]),
    ],
    suggested_investigators: (raw.people ?? []).map((person) => ({
      id: person.person_id,
      name: person.person_name,
      role: String(person.relation ?? '').toLowerCase(),
      reason: person.detail ?? '',
    })),
    generated_by: 'backend explain service',
    generated_at: raw.generated_at,
    unavailable: raw.missing ?? [],
  };
}

function adaptAlternateEvidence(raw: {
  assumption_id?: string;
  fact_id: string;
  fact_name?: string;
  value?: string;
  fact_value?: string;
  status?: string;
  fact_status?: string;
  why_survives?: string;
}): AlternateEvidence {
  return {
    fact_id: raw.fact_id,
    summary: raw.fact_name,
    effect: String(raw.fact_status ?? raw.status ?? 'independent_support').toLowerCase(),
    note: raw.why_survives ?? `Value: ${raw.value ?? raw.fact_value ?? 'unknown'}`,
  };
}

function dedupeSources(sources: SourceRecord[]): SourceRecord[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.id)) return false;
    seen.add(source.id);
    return true;
  });
}

/* ---------------------------------------------------------------------- facts */

export function adaptFactExplanation(raw: RawFactExplanation): {
  detail: FactDetail;
  chain: ProvenanceStep[];
} {
  const factNode = raw.fact;
  const provenance = raw.provenance ?? null;

  const node: GraphNode = factNode
    ? adaptGraphNode(factNode)
    : {
        id: raw.fact_id ?? '',
        type: 'fact',
        label: provenance?.statement ?? raw.fact_id ?? 'Unknown fact',
        state: 'normal',
        summary: provenance?.statement ?? '',
        confidence: provenance?.confidence ?? null,
        project_ids: [],
        team_ids: [],
        valid_from: provenance?.valid_from ?? null,
        valid_to: provenance?.valid_to ?? null,
        recorded_at: provenance?.recorded_at ?? null,
        degree: 0,
        source_ids: [],
        properties: {},
      };

  const sources = dedupeSources((provenance?.sources ?? []).map(adaptSourceRef));
  const contradiction = raw.contradictions?.[0];

  const chain: ProvenanceStep[] = [];

  for (const source of sources.slice(0, 4)) {
    chain.push({
      kind: 'original_source',
      ref_id: source.id,
      label: source.title,
      actor: source.author_name ?? null,
      at: source.timestamp,
      text: source.excerpt ?? source.text,
      simulated: false,
    });
  }

  chain.push({
    kind: 'extracted_claim',
    ref_id: node.id,
    label: 'Recorded claim',
    at: provenance?.recorded_at ?? undefined,
    text: provenance?.statement ?? node.label,
    confidence: provenance?.confidence ?? null,
    method: 'deterministic extraction',
    note: provenance?.verified
      ? 'The backend marked this claim as verified against its source.'
      : 'The backend did not mark this claim as verified.',
  });

  if (contradiction) {
    chain.push({
      kind: 'system_interpretation',
      ref_id: contradiction.new_fact_id,
      label: `Contradiction detected (${contradiction.rule ?? 'rule'})`,
      at: contradiction.at ?? undefined,
      text: contradiction.rationale ?? '',
      confidence: contradiction.confidence ?? null,
      method: contradiction.kind,
      note: `Relationship recorded as ${contradiction.status ?? 'unverified'} — a machine conclusion, not a human statement.`,
    });

    chain.push({
      kind: 'business_decision',
      ref_id: contradiction.other_fact_id,
      label: 'Fact superseded in the graph',
      at: contradiction.at ?? undefined,
      text: `"${contradiction.other_value ?? 'previous'}" → "${contradiction.new_value ?? 'new'}"`,
      note: 'The earlier fact is preserved with a closed validity window; nothing is overwritten.',
    });
  }

  const detail: FactDetail = {
    fact: node,
    statement: provenance?.statement ?? node.label,
    kind: String(raw.fact?.label ?? 'Fact'),
    valid_from: provenance?.valid_from ?? null,
    valid_to: provenance?.valid_to ?? null,
    recorded_at: provenance?.recorded_at ?? null,
    superseded_at: provenance?.recorded_to ?? null,
    validity:
      provenance?.valid_to && provenance.valid_to !== '' ? 'contradicted' : raw.contradictions?.length ? 'converging' : 'current',
    confidence: provenance?.confidence ?? null,
    sources,
    supports: (raw.supporting_assumptions ?? []).map((assumption) => ({
      id: assumption.assumption_id,
      label: assumption.name,
    })),
    contradicted_by: (raw.contradictions ?? []).map((item) =>
      adaptGraphNode({
        id: item.new_fact_id,
        label: 'Fact',
        name: item.new_fact_name,
        statement: item.new_fact_name,
        value: item.new_value,
        status: item.status,
        confidence: item.confidence ?? null,
      }),
    ),
    contradicts: (raw.contradictions ?? []).map((item) =>
      adaptGraphNode({
        id: item.other_fact_id,
        label: 'Fact',
        name: item.other_fact_name,
        statement: item.other_fact_name,
        value: item.other_value,
      }),
    ),
    affects_decisions: (raw.affected_entities ?? [])
      .filter((entity) => String(entity.entity_label).toLowerCase() === 'decision')
      .map((entity) =>
        adaptDecisionSummary({
          id: entity.entity_id,
          label: 'Decision',
          name: entity.entity_name,
          status: 'POTENTIALLY_STALE',
          review_status: 'NEEDS_REVIEW',
        }),
      ),
    recorded_time_note:
      'valid_from/valid_to describe the world; recorded_at/recorded_to describe when Tripwire knew. They are kept separate.',
  };

  return { detail, chain };
}

/* -------------------------------------------------------------------- experts */

function adaptUncertainty(value: RawExpert['uncertainty']): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}

/**
 * Backend contribution/artifact kinds → the view's four-value `SourceType`.
 *
 * `contribution_type` wins because it says what the person actually did
 * ("resolved_ticket"); `artifact_label` is the coarser fallback. Anything
 * unrecognised becomes `prd`, the closest "written document" bucket, and the
 * original string is still preserved on the evidence row for display.
 */
const CONTRIBUTION_TO_SOURCE: Record<string, SourceType> = {
  resolved_ticket: 'ticket',
  authored_ticket: 'ticket',
  commented_ticket: 'ticket',
  authored_message: 'slack_message',
  authored_meeting_note: 'meeting_note',
  contributed_to_meeting: 'meeting_note',
  authored_document: 'prd',
  authored_prd: 'prd',
  reviewed_document: 'prd',
};

const ARTIFACT_TO_SOURCE: Record<string, SourceType> = {
  message: 'slack_message',
  ticket: 'ticket',
  document: 'prd',
  prd: 'prd',
  note: 'meeting_note',
};

export function toSourceType(contributionType?: string | null, artifactLabel?: string | null): SourceType {
  const byContribution = CONTRIBUTION_TO_SOURCE[String(contributionType ?? '').toLowerCase()];
  if (byContribution) return byContribution;
  const byArtifact = ARTIFACT_TO_SOURCE[String(artifactLabel ?? '').toLowerCase()];
  if (byArtifact) return byArtifact;
  return 'prd';
}

export function adaptExpert(raw: RawExpert): Expert {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw.contribution_counts ?? {})) {
    counts[key] = value;
  }

  /*
   * Real contribution records look like:
   *   { artifact_id: "document:ticket:nwl-2328", artifact_label: "Document",
   *     artifact_name: "EU launch readiness checklist",
   *     contribution_type: "resolved_ticket", weight, relevance, recency, score,
   *     timestamp, source_ref: "ticket:NWL-2328", note }
   * There is no `label` or `source_id`, so reading those yielded undefined and the
   * panel crashed. `contribution_type` is the reliable discriminator.
   */
  const evidence: Expert['evidence'] = (raw.contributions ?? []).map((contribution) => ({
    source_id: contribution.artifact_id ?? contribution.source_ref ?? '',
    type: toSourceType(contribution.contribution_type, contribution.artifact_label),
    title: contribution.artifact_name ?? contribution.source_ref ?? contribution.artifact_id ?? 'Contribution',
    at: contribution.timestamp ?? '',
    why: contribution.note ?? undefined,
  }));

  // Fall back to evidence_refs when the backend sends ids without detail.
  if (evidence.length === 0 && raw.evidence_refs?.length) {
    for (const ref of raw.evidence_refs.slice(0, 10)) {
      evidence.push({ source_id: ref, type: 'document' as SourceType, title: ref, at: '' });
    }
  }

  return {
    person_id: raw.person_id,
    name: raw.person_name,
    team_id: null,
    team_name: raw.team_name ?? undefined,
    title: raw.role ?? undefined,
    score: raw.score,
    rank: raw.rank,
    is_official_owner: Boolean(raw.is_official_owner),
    contribution_counts: counts as Expert['contribution_counts'],
    total_contributions: raw.contribution_total ?? evidence.length,
    evidence,
    ranking_explanation: raw.reason ?? '',
    uncertainty: adaptUncertainty(raw.uncertainty),
    limitations: '',
  };
}

export function adaptExperts(raw: RawExpertsResponse): ExpertsResponse {
  const experts = (raw.experts ?? []).map(adaptExpert);
  const method = raw.method ?? '';
  const notes = raw.notes ?? [];

  // The scoring method and its caveats are shown on every row: a rank is not a
  // statement of truth, and the panel must say so.
  const limitations = [
    method,
    ...notes,
    'Ranking reflects recorded contributions only. Authorship volume is not proof of expertise, and someone with relevant knowledge who never wrote anything down will not appear here.',
  ]
    .filter(Boolean)
    .join(' ');

  const hiddenExperts = (raw.hidden_experts ?? []).map(adaptExpert).map((expert) => ({
    ...expert,
    limitations,
  }));

  const withLimitations = experts.map((expert) => ({ ...expert, limitations }));

  return {
    system_id: raw.target_id ?? null,
    system_label: raw.target_name ?? raw.target_label ?? undefined,
    experts: withLimitations,
    method,
    weights: undefined,
    excluded: [],
    for_alert_id: null,
    alert_context: null,
    recommended_contact: (hiddenExperts[0] ?? withLimitations[0])
      ? {
          person_id: (hiddenExperts[0] ?? withLimitations[0]).person_id,
          name: (hiddenExperts[0] ?? withLimitations[0]).name,
          why:
            hiddenExperts[0]
              ? 'This person ranks highly on contributions but is not the listed owner — the shadow-org-chart case.'
              : 'Top-ranked by recorded contribution.',
          ranking_explanation: (hiddenExperts[0] ?? withLimitations[0]).ranking_explanation,
          uncertainty: (hiddenExperts[0] ?? withLimitations[0]).uncertainty,
        }
      : null,
    hidden_experts: hiddenExperts,
    official_owners: (raw.official_owners ?? []).map((owner) => ({
      person_id: owner.person_id,
      person_name: owner.person_name,
      official_role: owner.official_role,
      team_name: owner.team_name,
      owns: owner.owns_name ?? owner.owns,
    })),
  };
}

/* ------------------------------------------------------------------- sources */

export function adaptSource(raw: RawSource): SourceRecord {
  const kind = String(raw.source_system ?? raw.doc_type ?? raw.label ?? '').toLowerCase();
  let type: SourceType = 'document' as SourceType;
  if (kind.includes('slack') || kind === 'message') type = 'slack_message';
  else if (kind.includes('ticket')) type = 'ticket';
  else if (kind.includes('prd')) type = 'prd';
  else if (kind.includes('meeting')) type = 'meeting_note';

  return {
    id: raw.id,
    type,
    title: raw.title ?? raw.name ?? raw.id,
    external_id: raw.external_id ?? null,
    author_id: raw.author_id ?? null,
    author_name: raw.author_id ? readableId(raw.author_id) : undefined,
    timestamp: raw.timestamp ?? raw.recorded_at ?? '',
    recorded_at: raw.recorded_at ?? undefined,
    text: raw.text ?? '',
    excerpt: raw.text ? String(raw.text).slice(0, 240) : undefined,
    simulated: false,
    metadata: { source_ref: raw.source_ref ?? null, channel: raw.channel ?? null, doc_type: raw.doc_type ?? null },
  };
}

export function adaptSourceDetail(raw: RawSourceDetail): {
  source: SourceRecord;
  states: GraphNode[];
} {
  return {
    source: adaptSource(raw.source),
    states: (raw.states ?? []).map((node) => adaptGraphNode(node)),
  };
}

/* ------------------------------------------------------------------- history */

function beliefFor(fact: RawNode): HistoryFact['belief'] {
  if (fact.status && String(fact.status).toUpperCase() === 'CONTRADICTED') return 'later_contradicted';
  if (fact.valid_to) return 'later_contradicted';
  if (fact.recorded_at === null) return 'unknown_yet';
  return 'believed_true';
}

export function adaptHistoryFact(fact: RawNode): HistoryFact {
  return {
    id: fact.id,
    statement: fact.statement ?? fact.name ?? '',
    label: fact.name ?? fact.id,
    valid_from: fact.valid_from ?? null,
    valid_to: fact.valid_to ?? null,
    recorded_at: fact.recorded_at ?? null,
    superseded_at: fact.recorded_to ?? null,
    belief: beliefFor(fact),
    current_state: toNodeState(fact),
    confidence: fact.confidence ?? null,
  };
}

export function adaptHistory(
  belief: RawHistoryBelief | null,
  changes: RawHistoryChanges | null,
  decisions: HistoryDecision[] = [],
): HistoryResponse {
  const facts = (belief?.facts ?? []).map(adaptHistoryFact);
  const asOf = belief?.at ?? changes?.since ?? new Date(0).toISOString();

  const timeline: TimelineEntry[] = (changes?.events ?? []).map((event) => ({
    at: event.recorded_at,
    kind: event.event_type,
    summary: event.summary ?? event.event_type,
    entity_ids: [],
    actor: event.actor_id ?? 'system',
  }));

  return {
    as_of: asOf,
    mode: 'recorded_time',
    demo_clock: changes?.since,
    event_applied: facts.some((fact) => fact.belief === 'later_contradicted'),
    facts,
    changes: (changes?.facts ?? []).map((fact) => ({
      at: fact.recorded_at ?? '',
      kind: 'fact_recorded',
      entity_id: fact.fact_id,
      summary: fact.statement ?? fact.name ?? '',
      actor: 'system',
    })),
    timeline,
    decisions,
    notes: [
      'Reconstructed from recorded_at/recorded_to (when Tripwire learned it) — the current graph is not re-stamped onto the past.',
    ],
  };
}

export function adaptTimeline(changes: RawHistoryChanges | null): TimelineResponse {
  if (!changes) return { events: [], total: 0 };
  const events: TimelineEntry[] = [
    ...(changes.events ?? []).map((event) => ({
      at: event.recorded_at,
      kind: event.event_type,
      summary: event.summary ?? event.event_type,
      entity_ids: [],
      source_ids: [],
      actor: event.actor_id ?? 'system',
    })),
    ...(changes.facts ?? []).map((fact) => ({
      at: fact.recorded_at ?? '',
      kind: 'fact_recorded',
      summary: `${fact.name ?? fact.fact_id}: recorded as ${fact.status ?? 'recorded'}`,
      entity_ids: [fact.fact_id],
      source_ids: fact.source_id ? [fact.source_id] : [],
      actor: 'system',
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return { events, total: events.length, demo_clock: changes.since };
}

/* ------------------------------------------------------------- demo & health */

export function adaptHealth(raw: RawHealth): HealthResponse {
  return {
    status: raw.status,
    service: 'tripwire-backend',
    version: '1.0.0',
    time: raw.checked_at,
    // Shown verbatim in the UI. The real backend reports its store backend, and
    // `llm_enabled: false` means deterministic rules — the UI must say so.
    mode: `${raw.active_backend}${raw.llm_enabled ? '' : ' · deterministic'}`,
    dataset: {
      name: 'northwind-labs',
      seeded_at: raw.checked_at,
      revision: raw.store?.nodes ?? 0,
      deterministic: !raw.llm_enabled,
    },
    counts: {
      people: 0,
      teams: 0,
      systems: 0,
      projects: 0,
      decisions: 0,
      assumptions: 0,
      facts: 0,
      sources: 0,
      events: 0,
      alerts: 0,
      nodes: raw.store?.nodes ?? 0,
      edges: raw.store?.edges ?? 0,
    },
  };
}

export function adaptDemoState(raw: RawDemoState, alertCounts?: Record<string, number>): DemoState {
  const byLabel = raw.counts?.by_label ?? {};
  const keys = raw.key_entities ?? {};
  const openAlerts = raw.alerts?.total ?? 0;

  return {
    phase: raw.seeded ? (openAlerts > 0 ? 'event_applied' : 'baseline') : 'baseline',
    event_applied: openAlerts > 0,
    revision: raw.counts?.nodes ?? 0,
    demo_clock: new Date().toISOString(),
    seeded_at: new Date().toISOString(),
    last_event: null,
    reset_available: true,
    counts: {
      nodes: raw.counts?.nodes ?? 0,
      edges: raw.counts?.edges ?? 0,
      alerts_open: openAlerts,
      decisions_needing_review: Object.entries(alertCounts ?? raw.alerts?.status_counts ?? {})
        .filter(([status]) => status !== 'DISMISSED' && status !== 'RESOLVED')
        .reduce((sum, [, value]) => sum + value, 0),
    },
    storyline: {
      fact_id: keys.compliance_fact ?? '',
      new_fact_id: keys.new_compliance_fact,
      assumption_id: keys.residency_assumption ?? '',
      decision_id: keys.eu_launch_decision ?? '',
      partner_id: keys.frankfurt_partner,
      trigger_text: 'Our Frankfurt hosting partner has lost its EU compliance certification.',
    },
    thresholds: raw.config?.limits
      ? {
          requires_investigation: raw.config.limits.verified_confidence_floor,
          uncertain_floor: raw.config.limits.verified_confidence_floor,
          method: `max propagation depth ${raw.config.limits.max_propagation_depth}`,
        }
      : undefined,
    key_entities: keys,
    by_label: byLabel,
    by_rel: raw.counts?.by_rel ?? {},
    dataset: raw.dataset
      ? {
          name: raw.dataset.name,
          version: raw.dataset.version,
          storyline: raw.dataset.storyline,
          matches_expected: raw.dataset.matches_expected ?? {},
        }
      : undefined,
    llm: raw.llm
      ? { enabled: raw.llm.enabled, provider: raw.llm.provider, model: raw.llm.model, note: raw.llm.note }
      : undefined,
    history_summary: raw.history as unknown as Record<string, number> | undefined,
  };
}

/* ------------------------------------------------------------------- trigger */

export interface AdaptTriggerOptions {
  /** Graph nodes, used to report honestly which decisions the event did NOT touch. */
  graphNodes?: RawNode[];
  now?: Date;
}

/**
 * Real trigger response → the view model the scenario and decision panels read.
 *
 * `impacts[]` is a superset of what the UI needs (`flagged`, `certainty`, `depth`,
 * `reason`, `alternate_evidence`), so the frontend stops recomputing propagation.
 */
export function adaptTrigger(raw: RawTriggerResponse, options: AdaptTriggerOptions = {}): TriggerEventResponse {
  const impacts = raw.impacts ?? [];
  const newFact = raw.assertion?.fact ?? null;
  const candidate = raw.contradiction?.primary ?? null;
  const challengedId = candidate?.existing_fact_id ?? null;
  const nodeIndex = new Map((options.graphNodes ?? []).map((node) => [node.id, node]));

  const impactedIds = new Set(impacts.map((impact) => impact.entity_id));

  // Which assumptions carried each entity, straight from `propagation.affected`
  // (the `impacts` list omits it).
  const assumptionsByEntity = new Map<string, string[]>();
  for (const affected of raw.propagation?.affected ?? []) {
    assumptionsByEntity.set(affected.entity_id, affected.contributing_assumptions ?? []);
  }

  const toImpact = (impact: (typeof impacts)[number]): import('./types').PropagationDecision => ({
    id: impact.entity_id,
    label: impact.entity_name,
    status: String(impact.status_after ?? '').toLowerCase(),
    impact: (impact.certainty === 'confirmed' ? 'high' : 'medium') as 'high' | 'medium' | 'low',
    certainty: impact.certainty,
    confidence: impact.alert?.confidence ?? null,
    // `flagged` is the backend's own decision about whether a human must look.
    requires_investigation: Boolean(impact.flagged),
    depth: impact.depth,
    status_before: impact.status_before,
    status_after: impact.status_after,
    reason: impact.reason,
    assumption_ids: assumptionsByEntity.get(impact.entity_id) ?? [],
    alternate_evidence: (impact.alternate_evidence ?? []).map(adaptAlternateEvidence),
    reviewers: impact.reviewers ?? [],
    paths: (impact.paths ?? []).map(adaptRawPath),
  });

  /** Narrower shape for the lists that only need headline fields. */
  const toItem = (impact: (typeof impacts)[number]): import('./types').PropagationItem => {
    const decision = toImpact(impact);
    return {
      id: decision.id,
      label: decision.label,
      impact: decision.impact,
      reason: decision.reason,
      status: decision.status,
      confidence: decision.confidence ?? undefined,
      requires_investigation: decision.requires_investigation,
      alternate_evidence: decision.alternate_evidence,
    };
  };

  const decisionImpacts = impacts.filter((impact) => String(impact.entity_label).toLowerCase() === 'decision');
  const projectImpacts = impacts.filter((impact) => String(impact.entity_label).toLowerCase() === 'project');

  // Honest "unaffected": ACTIVE decisions in the graph that the engine did not
  // touch. Derived from the graph, never invented.
  const unaffected = (options.graphNodes ?? [])
    .filter((node) => String(node.label).toLowerCase() === 'decision')
    .filter((node) => !impactedIds.has(node.id))
    .filter((node) => String(node.status ?? '').toUpperCase() === 'ACTIVE')
    .map((node) => ({
      id: node.id,
      label: displayName(node),
      status: 'active',
      reason: 'Not reachable from the changed fact through any recorded assumption, so the engine left it alone.',
    }));

  const primaryPath = decisionImpacts[0]?.paths?.[0] ?? raw.propagation?.affected?.[0]?.paths?.[0];
  const source = raw.assertion?.source_id ? adaptSourceRef({ source_id: raw.assertion.source_id }) : undefined;

  const event: EventSummary = {
    id: `event:${raw.event?.scenario ?? 'scenario'}:${raw.event?.triggered_at ?? ''}`,
    type: raw.event?.scenario ?? 'triggered_event',
    summary: newFact?.statement ?? newFact?.name ?? '',
    occurred_at: raw.event?.triggered_at ?? '',
    // The backend applies the event at its own recorded time; the two axes stay
    // distinguishable in the UI.
    recorded_at: newFact?.recorded_at ?? raw.event?.triggered_at ?? '',
    actor: raw.event?.actor_id ?? 'unknown',
    source_id: raw.assertion?.source_id ?? '',
    raw_text: newFact?.statement ?? newFact?.name ?? '',
    fact_ids: [
      ...(newFact?.id ? [newFact.id] : []),
      ...(challengedId ? [challengedId] : []),
    ],
  };

  const graphRevision = options.graphNodes?.length ?? 0;

  return {
    already_applied: (raw.applied?.length ?? 0) === 0,
    event,
    source,
    extraction: newFact
      ? {
          method: raw.contradiction?.llm_used ? 'llm-assisted' : 'deterministic rules',
          confidence: raw.contradiction?.primary?.confidence ?? newFact.confidence ?? 0,
          new_fact: adaptGraphNode(newFact),
          contradicted_fact: adaptGraphNode(
            challengedId
              ? {
                  id: challengedId,
                  label: 'Fact',
                  name: candidate?.rationale
                    ? String(candidate.rationale).split('.')[0]
                    : challengedId,
                  statement: candidate?.rationale ?? challengedId,
                  value: candidate?.existing_value ?? null,
                  valid_to: raw.event?.triggered_at ?? null,
                  status: 'ACTIVE',
                  confidence: candidate?.confidence ?? null,
                }
              : { id: '', label: 'Fact', name: '' },
          ),
          linked_entities: [challengedId, ...(raw.propagation?.assumptions ?? []), ...(raw.propagation?.seed_decisions ?? [])].filter(
            (id): id is string => Boolean(id),
          ),
          claims: (raw.contradiction?.candidates ?? []).map((item, index) => ({
            id: `${item.existing_fact_id ?? item.related_fact_id ?? 'claim'}-${index}`,
            text: item.rationale ?? '',
            kind: item.kind,
            confidence: item.confidence ?? 0,
            needs_review: (item.review_status ?? '').toUpperCase() === 'NEEDS_REVIEW',
            reason: item.explicit_rule ?? undefined,
            linked_entity_ids: [item.existing_fact_id, item.related_fact_id].filter((id): id is string => Boolean(id)),
            materialised_fact_id: item.contradicts ? item.new_fact_id ?? null : null,
          })),
          unparsed: raw.contradiction?.notes ?? [],
        }
      : undefined,
    propagation: {
      assumptions: (raw.propagation?.assumptions ?? []).map((id) => {
        const node = nodeIndex.get(id);
        return {
          id,
          label: node ? displayName(node) : readableId(id),
          relation: 'assumes',
          confidence: node?.confidence ?? 0,
          status: 'affected',
          alternate_evidence: [],
        };
      }),
      decisions: decisionImpacts.map(toImpact),
      projects: projectImpacts.map(toItem),
      systems: impacts
        .filter((impact) => String(impact.entity_label).toLowerCase() === 'system')
        .map(toItem),
      not_affected: unaffected,
      uncertain: decisionImpacts
        .filter((impact) => impact.certainty === 'potential')
        .map(toItem),
    },
    path: adaptRawPath(primaryPath),
    alerts: [],
    explanation: null,
    graph_revision: graphRevision,
    /**
     * Uncertainty stated by the engine, plus the distinction it insists on: a
     * detected contradiction is not a confirmed business consequence.
     */
    uncertainty: [
      ...(raw.propagation?.notes ?? []),
      ...(raw.staleness?.notes ?? []),
      `The engine evaluated ${raw.propagation?.counts?.affected_total ?? impacts.length} entities and flagged ${
        impacts.filter((impact) => impact.flagged).length
      }. ${raw.propagation?.counts?.confirmed ?? 0} are confirmed, ${
        raw.propagation?.counts?.potential ?? 0
      } are potential only — a potential impact is a request for review, not a conclusion that the decision is wrong.`,
    ],
    entity_impacts: impacts.map(toImpact),
    audit: {
      applied_entity_ids: raw.applied ?? [],
      source_fact_id: raw.propagation?.source_fact_id ?? '',
      source_fact_status: raw.propagation?.source_fact_status ?? '',
      source_fact_verified: Boolean(raw.propagation?.source_fact_verified),
      max_depth: raw.propagation?.max_depth ?? 0,
      counts: raw.propagation?.counts,
      notes: [...(raw.propagation?.notes ?? []), ...(raw.staleness?.notes ?? [])],
      contradiction_summary: raw.contradiction?.summary,
      contradiction_candidates: (raw.contradiction?.candidates ?? []).map((item) => ({
        kind: item.kind,
        existing_fact_id: item.existing_fact_id ?? null,
        new_fact_id: item.new_fact_id ?? null,
        attribute: item.attribute ?? null,
        existing_value: item.existing_value ?? null,
        new_value: item.new_value ?? null,
        confidence: item.confidence ?? null,
        rule: item.explicit_rule ?? null,
        rationale: item.rationale ?? '',
        llm_assisted: Boolean(item.llm_assisted),
        already_recorded: Boolean(item.already_recorded),
      })),
      llm_used: Boolean(raw.contradiction?.llm_used),
      scenario: raw.event?.scenario ?? null,
    },
  };
}

export function adaptAssumption(node: RawNode): AssumptionSummary {
  return {
    id: node.id,
    label: displayName(node),
    statement: node.statement ?? '',
    status: String(node.status ?? 'unknown').toLowerCase(),
    confidence: node.confidence ?? null,
    supported_by: [],
    contradicted_by: [],
    state: toNodeState(node),
  };
}

export function adaptDecisionDetail(
  raw: RawDecisionExplanation,
  decisionNode: GraphNode | null,
  sources: SourceRecord[],
  assumptions: AssumptionSummary[],
): DecisionDetail {
  // `decision` may legitimately be absent when the graph node was filtered out.
  const rawDecision: RawNode = raw.decision ?? {
    id: raw.decision_id ?? '',
    label: 'Decision',
    name: decisionNode?.label ?? '',
    status: raw.status ?? null,
  };

  return {
    decision: {
      id: raw.decision_id ?? decisionNode?.id ?? '',
      title: decisionNode?.label ?? raw.decision?.name ?? '',
      status: toDecisionStatus(rawDecision),
      owner_id: null,
      owner_name: undefined,
      project_ids: [],
      system_ids: [],
      created_at: raw.decision?.created_at ?? '',
      recorded_at: raw.decision?.recorded_at ?? '',
      assumption_ids: (raw.dependencies ?? []).map((dependency) => dependency.assumption_id),
      open_alert_count: (raw.alerts ?? []).length,
      review_state: String(raw.review_status ?? '').toLowerCase(),
      confidence: raw.confidence ?? null,
      graph_state: toNodeState(rawDecision),
    },
    description: raw.decision?.statement ?? '',
    assumptions,
    supporting_facts: (raw.dependencies ?? []).flatMap((dependency) =>
      dependency.facts.map((fact) =>
        adaptGraphNode({
          id: fact.fact_id,
          label: 'Fact',
          name: fact.name,
          statement: fact.statement,
          value: fact.value,
          status: fact.status,
          confidence: fact.confidence ?? null,
          valid_from: fact.valid_from ?? null,
          valid_to: fact.valid_to ?? null,
          recorded_at: fact.recorded_at ?? null,
        }),
      ),
    ),
    contradicted_facts: [],
    projects: [],
    systems: [],
    people: (raw.people ?? []).map((person) => ({
      id: person.person_id,
      name: person.person_name,
      role: String(person.relation ?? '').toLowerCase(),
      reason: person.detail ?? '',
    })),
    sources,
    history: (raw.alerts ?? []).map((alert) => ({
      at: alert.created_at ?? '',
      kind: 'alert_created',
      summary: alert.summary ?? '',
      actor: 'tripwire',
    })),
    alerts: [],
    unavailable: raw.missing ?? [],
  };
}

/**
 * Is this a structurally valid chain?
 *
 * The live backend returns one malformed route for the demo pair:
 * `nodes: [assumption, fact, assumption]` with `rels: [SUPPORTED_BY, ASSUMES]` — it
 * starts and ends at the same node, and the direction is inverted, so it does not
 * describe a walk from the changed fact to the decision. Rendering it would show a
 * contradiction chain that does not exist, so it is rejected rather than patched.
 *
 * A chain must: have at least two nodes, have exactly one fewer relationship than
 * nodes, and not return to where it started.
 */
export function validatePath(path: RawPath | undefined | null): {
  valid: boolean;
  reason?: string;
} {
  if (!path) return { valid: false, reason: 'no path returned' };
  const nodes = path.nodes ?? [];
  const rels = path.rels ?? [];
  if (nodes.length < 2) return { valid: false, reason: 'fewer than two nodes' };
  if (rels.length !== nodes.length - 1) {
    return { valid: false, reason: `${nodes.length} nodes but ${rels.length} relationships` };
  }
  if (nodes[0] === nodes[nodes.length - 1]) {
    return { valid: false, reason: 'path starts and ends at the same entity' };
  }
  if (new Set(nodes).size !== nodes.length) {
    return { valid: false, reason: 'path visits the same entity twice' };
  }
  return { valid: true };
}

export interface PathValidationSummary {
  total: number;
  valid: number;
  invalid: Array<{ index: number; reason: string }>;
}

/** Report on every route the backend offered, without hiding bad ones. */
export function summarisePaths(paths: RawPath[] | undefined): PathValidationSummary {
  const list = paths ?? [];
  const invalid: Array<{ index: number; reason: string }> = [];
  let valid = 0;
  list.forEach((path, index) => {
    const result = validatePath(path);
    if (result.valid) valid += 1;
    else invalid.push({ index, reason: result.reason ?? 'invalid' });
  });
  return { total: list.length, valid, invalid };
}

export function adaptGraphPath(
  raw: { paths?: RawPath[]; reason?: string } | null,
  from: string,
  to: string,
): GraphPath {
  const candidates = (raw?.paths ?? []).filter((path) => validatePath(path).valid);
  const first = candidates[0];
  const path = adaptRawPath(first);
  return {
    found: Boolean(first),
    from,
    to,
    nodes: path.nodes,
    edges: path.edges,
    hops: path.hops ?? 0,
    narration: path.narration ?? [],
  };
}
