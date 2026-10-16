/**
 * Tripwire deterministic engine.
 *
 * Holds the whole mutable demo state (event application, alerts, review log,
 * ad-hoc ingestion) and implements every operation in docs/API_CONTRACT.md.
 * Runs unchanged in Node (mock server) and in the browser (mock adapter).
 */

import { buildDataset, edgeId } from './dataset.js';
import { ApiError, badRequest, conflict, notFound, validationError } from './errors.js';
import {
  ALTERNATE_EVIDENCE, METHOD, THRESHOLDS, classifyEvent, extractClaims, linkEntities,
  propagate, rankExperts,
} from './rules.js';

const SERVICE_VERSION = '1.0.0';
const GRAPH_NODE_LIMIT = 1500;

const REVIEW_TRANSITIONS = {
  NEW: ['NEEDS_REVIEW', 'CONFIRMED_STALE', 'DISMISSED', 'RESOLVED'],
  NEEDS_REVIEW: ['CONFIRMED_STALE', 'DISMISSED', 'RESOLVED'],
  CONFIRMED_STALE: ['RESOLVED', 'DISMISSED'],
  DISMISSED: ['NEEDS_REVIEW'],
  RESOLVED: ['NEEDS_REVIEW'],
};

const CHANNEL_TO_SOURCE_TYPE = {
  slack: 'slack_message',
  slack_message: 'slack_message',
  ticket: 'ticket',
  prd: 'prd',
  meeting_note: 'meeting_note',
  meeting: 'meeting_note',
  manual: 'slack_message',
};

const ALERT_SEVERITY = (confidence) => (confidence >= 0.7 ? 'high' : confidence >= 0.5 ? 'medium' : 'low');

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export class TripwireStore {
  constructor() {
    this.reset();
  }

  // ---------------------------------------------------------------- lifecycle

  reset() {
    this.base = buildDataset();
    this.revision = 1;
    this.mutation = null;
    this.alertList = [];
    this.extraSources = [];
    this.extraNodes = [];
    this.extraEdges = [];
    this.reviewLog = [];
    this.ingestCounter = 0;
    this.eventCounter = 0;
    return this.demoState();
  }

  get nodeById() {
    return new Map([...this.base.nodes, ...this.extraNodes].map((n) => [n.id, n]));
  }

  get allNodes() {
    return [...this.base.nodes, ...this.extraNodes];
  }

  get allEdges() {
    return [...this.base.edges, ...this.extraEdges];
  }

  get allSources() {
    return [...this.base.sources, ...this.extraSources];
  }

  /** Fact records = base facts plus any fact materialised by an event. */
  get allFacts() {
    return this.allNodes.filter((n) => n.type === 'fact');
  }

  health() {
    const nodes = this.allNodes;
    const edges = this.allEdges;
    return {
      status: 'ok',
      service: 'tripwire-api',
      version: SERVICE_VERSION,
      time: this.base.demo_clock,
      mode: 'mock-backend',
      dataset: {
        name: 'northwind-labs',
        seeded_at: this.base.seeded_at,
        demo_clock: this.base.demo_clock,
        revision: this.revision,
        deterministic: true,
      },
      counts: {
        ...this.base.counts,
        sources: this.allSources.length,
        alerts: this.alertList.length,
        nodes: nodes.length,
        edges: edges.length,
      },
      source_counts_by_type: this.base.source_counts_by_type,
    };
  }

  demoState() {
    const nodes = this.allNodes;
    return {
      phase: this.mutation ? 'event_applied' : 'baseline',
      event_applied: Boolean(this.mutation),
      revision: this.revision,
      demo_clock: this.base.demo_clock,
      seeded_at: this.base.seeded_at,
      last_event: this.mutation ? clone(this.mutation.event) : null,
      reset_available: true,
      counts: {
        nodes: nodes.length,
        edges: this.allEdges.length,
        alerts_open: this.alertList.filter((a) => a.status === 'NEW' || a.status === 'NEEDS_REVIEW').length,
        decisions_needing_review: nodes.filter((n) => n.type === 'decision' && this.nodeState(n) === 'needs_review').length,
      },
      storyline: clone(this.base.storyline),
      thresholds: { ...THRESHOLDS, method: METHOD },
    };
  }

  // ------------------------------------------------------------------- events

  triggerEvent(body = {}) {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw validationError('Field "text" is required and must not be empty.', { field: 'text' });
    const classification = classifyEvent(text);
    if (!classification) {
      throw validationError('Event text did not match any known entity or rule, so no graph change was made.', {
        unparsed: true,
        supported: ['certification loss for a known hosting partner'],
        rule_ids: ['certification_lost'],
      });
    }
    if (this.mutation) {
      return { status: 200, body: { ...clone(this.mutation.response), already_applied: true, graph_revision: this.revision } };
    }
    const result = this.applyEvent({
      classification,
      text,
      channel: body.channel || 'slack',
      actor: body.actor || 'demo-operator',
      occurred_at: body.occurred_at || null,
      source_author_id: body.source_author_id || null,
      external_id: body.external_id || null,
      origin: 'demo_trigger',
    });
    return { status: 201, body: result };
  }

  applyEvent({ classification, text, channel, actor, occurred_at, source_author_id, external_id, origin }) {
    const rule = classification.rule;
    const dataset = { nodes: this.allNodes, edges: this.allEdges, sources: this.allSources };
    const recordedAt = this.base.demo_clock;
    const occurredAt = occurred_at || (origin === 'demo_trigger' ? '2026-10-15T08:40:00.000Z' : recordedAt);

    this.eventCounter += 1;
    const eventId = `EVT-${String(this.eventCounter + 1).padStart(4, '0')}`;
    const sourceType = CHANNEL_TO_SOURCE_TYPE[channel] || 'slack_message';
    const sourceId = origin === 'demo_trigger'
      ? `SRC-EVT-${String(this.eventCounter).padStart(3, '0')}`
      : `SRC-I-${String(this.ingestCounter).padStart(3, '0')}`;

    const factSpec = rule.new_fact;
    const newFactId = factSpec.id;

    const newSource = {
      id: sourceId,
      type: sourceType,
      title: origin === 'demo_trigger' ? 'Operator event entry' : (external_id || 'Ad-hoc ingestion'),
      external_id: external_id || `simulated://operator-entry/${eventId}`,
      author_id: source_author_id || null,
      author_name: source_author_id ? (this.nodeById.get(source_author_id)?.label || null) : actor,
      timestamp: occurredAt,
      recorded_at: recordedAt,
      text,
      excerpt: text.length > 240 ? `${text.slice(0, 237)}...` : text,
      simulated: true,
      operator_entry: true,
      entity_ids: [...new Set([...rule.new_fact.system_ids, ...rule.new_fact.project_ids, rule.contradicts])],
      fact_ids: [newFactId],
      metadata: { channel, operator_entry: true, origin },
    };

    const newFactNode = {
      id: newFactId,
      type: 'fact',
      label: factSpec.statement.length > 74 ? `${factSpec.statement.slice(0, 71)}...` : factSpec.statement,
      state: 'new_fact',
      summary: factSpec.statement,
      confidence: rule.confidence,
      project_ids: factSpec.project_ids.slice(),
      team_ids: [],
      valid_from: occurredAt,
      valid_to: null,
      recorded_at: recordedAt,
      degree: 0,
      source_ids: [sourceId],
      properties: {
        statement: factSpec.statement, kind: factSpec.kind, extracted_from: sourceId,
        superseded_at: null, introduced_by: eventId, rule_id: rule.id,
      },
    };

    const event = {
      id: eventId,
      type: rule.type,
      summary: rule.summary,
      occurred_at: occurredAt,
      recorded_at: recordedAt,
      actor,
      source_id: sourceId,
      raw_text: text,
      rule_id: rule.id,
      confidence: rule.confidence,
      method: METHOD,
      fact_ids: [newFactId],
      discovered_via: origin,
    };

    const propagation = propagate({ rule }, dataset);

    // --- alerts, one per decision that crossed the review threshold
    const createdAlerts = [];
    propagation.decisions.forEach((d) => {
      const decisionNode = this.nodeById.get(d.id);
      const alertId = `ALERT-${String(this.alertList.length + createdAlerts.length + 1).padStart(4, '0')}`;
      const contradictory = d.alternate_evidence.length
        ? ` Alternate evidence exists and must be weighed: ${d.alternate_evidence.map((a) => a.note).join(' ')}`
        : '';
      createdAlerts.push({
        id: alertId,
        status: 'NEW',
        severity: ALERT_SEVERITY(d.confidence),
        title: `${decisionNode?.label || d.id} may rest on a lapsed certification`,
        what_changed: event.summary,
        contradicted_fact_id: rule.contradicts,
        new_fact_id: newFactId,
        assumption_ids: d.assumption_ids,
        decision_ids: [d.id],
        project_ids: (decisionNode?.project_ids || []).slice(),
        confidence: d.confidence,
        requires_investigation: true,
        why: `${d.reason}${contradictory}`,
        thresholds: { requires_investigation: THRESHOLDS.requires_investigation, method: METHOD },
        source_ids: [sourceId, ...(this.nodeById.get(rule.contradicts)?.source_ids || [])],
        people: this.suggestInvestigators(d.id, rule),
        event: { id: event.id, occurred_at: event.occurred_at, recorded_at: event.recorded_at, actor: event.actor },
        history: [{ at: recordedAt, from: null, to: 'NEW', actor: 'system', note: `Alert raised by event ${event.id} (${METHOD}).` }],
        created_at: recordedAt,
        updated_at: recordedAt,
      });
    });

    const factUpdates = {
      [rule.contradicts]: {
        valid_to: occurredAt,
        superseded_at: recordedAt,
        state: 'contradicted',
        contradicted_by: [newFactId],
        reason: `Contradicted by ${newFactId} recorded at ${recordedAt}.`,
      },
      [newFactId]: { state: 'new_fact', contradicts: [rule.contradicts] },
    };
    const assumptionUpdates = {};
    propagation.assumptions.forEach((a) => {
      assumptionUpdates[a.id] = {
        status: 'challenged',
        confidence: a.confidence,
        contradicted_by: [newFactId],
        alternate_evidence: a.alternate_evidence,
      };
    });
    const decisionUpdates = {};
    propagation.decisions.forEach((d) => {
      decisionUpdates[d.id] = { state: 'needs_review', review_state: 'needs_review', confidence: d.confidence, flagged_by: [eventId] };
    });
    propagation.uncertain.forEach((d) => {
      decisionUpdates[d.id] = { state: 'potentially_affected', review_state: 'investigate', confidence: d.confidence, flagged_by: [eventId], uncertain: true };
    });

    this.extraSources.push(newSource);
    this.addSourceNode(newSource);
    this.extraNodes.push(newFactNode);
    this.extraEdges.push(
      { id: edgeId(newFactId, 'contradicts', rule.contradicts), source: newFactId, target: rule.contradicts, type: 'contradicts', label: 'contradicts', confidence: rule.confidence, properties: {} },
      { id: edgeId(newFactId, 'supersedes', rule.contradicts), source: newFactId, target: rule.contradicts, type: 'supersedes', label: 'supersedes', confidence: rule.confidence, properties: {} },
      { id: edgeId(eventId, 'raised_for', newFactId), source: eventId, target: newFactId, type: 'raised_for', label: 'raised for', confidence: null, properties: {} },
      { id: edgeId(eventId, 'observed_by', sourceId), source: eventId, target: sourceId, type: 'observed_by', label: 'observed by', confidence: null, properties: {} },
      { id: edgeId(sourceId, 'about', newFactId), source: sourceId, target: newFactId, type: 'about', label: 'about', confidence: null, properties: {} },
      { id: edgeId(newFactId, 'documented_in', sourceId), source: newFactId, target: sourceId, type: 'documented_in', label: 'documented in', confidence: null, properties: {} },
    );
    for (const sys of factSpec.system_ids) {
      this.extraEdges.push({ id: edgeId(newFactId, 'affects', sys), source: newFactId, target: sys, type: 'affects', label: 'affects', confidence: null, properties: {} });
    }
    this.alertList.push(...createdAlerts);
    this.revision += 1;

    const path = this.buildContradictionPath(newFactId, rule.contradicts, propagation);
    const explanation = this.buildExplanation(propagation.decisions[0]?.id || this.base.storyline.decision_id, {
      propagation, event, path, newFactId, contradictedFactId: rule.contradicts,
    });

    const response = {
      already_applied: false,
      event,
      source: newSource,
      extraction: {
        method: METHOD,
        confidence: rule.confidence,
        rule_id: rule.id,
        matched_terms: classification.matched_terms,
        new_fact: { ...clone(newFactNode), state: 'new_fact' },
        contradicted_fact: { ...clone(this.nodeById.get(rule.contradicts)), state: 'contradicted', valid_to: occurredAt },
        linked_entities: [...new Set([...factSpec.system_ids, ...factSpec.project_ids, rule.contradicts])],
        claims: (extractClaims(text, { sourceType }).claims).map((c) => ({ ...c, materialised_fact_id: c.needs_review ? null : newFactId })),
        unparsed: [],
      },
      propagation: {
        assumptions: propagation.assumptions,
        decisions: propagation.decisions,
        projects: propagation.projects,
        systems: propagation.systems,
        not_affected: propagation.not_affected,
        uncertain: propagation.uncertain,
      },
      path,
      alerts: createdAlerts,
      explanation,
      graph_revision: this.revision,
      uncertainty: rule.uncertainty || [],
    };

    this.mutation = { event, response, rule, factUpdates, assumptionUpdates, decisionUpdates, propagation, path };
    return response;
  }

  suggestInvestigators(decisionId, rule) {
    const systemId = rule.new_fact.system_ids?.[0];
    const out = [];
    if (systemId) {
      const ranking = rankExperts({ nodes: this.allNodes, sources: this.allSources }, systemId, 2);
      for (const e of ranking.experts) {
        out.push({
          id: e.person_id, name: e.name, team_name: e.team_name, role: 'suggested_investigator',
          rank: e.rank, is_official_owner: e.is_official_owner,
          reason: e.ranking_explanation,
          uncertainty: e.uncertainty[0],
        });
      }
    }
    const ownerId = this.nodeById.get(decisionId)?.properties?.owner_id;
    if (ownerId && !out.some((p) => p.id === ownerId)) {
      out.push({
        id: ownerId, name: this.nodeById.get(ownerId)?.label, role: 'decision_owner',
        reason: `Accountable owner of ${decisionId}; must decide whether the decision is still valid.`,
        uncertainty: 'Ownership is recorded in the graph; domain expertise is not inferred from it.',
      });
    }
    return out;
  }

  buildContradictionPath(newFactId, contradictedFactId, propagation) {
    const nodes = [newFactId, contradictedFactId];
    const edges = [];
    const narration = [`The new fact ${newFactId} contradicts ${contradictedFactId}.`];
    edges.push({ id: edgeId(newFactId, 'contradicts', contradictedFactId), source: newFactId, target: contradictedFactId, type: 'contradicts', label: 'contradicts' });

    const assumptionId = propagation.assumptions[0]?.id;
    if (assumptionId) {
      nodes.push(assumptionId);
      edges.push({ id: edgeId(contradictedFactId, 'supports', assumptionId), source: contradictedFactId, target: assumptionId, type: 'supports', label: 'supported' });
      narration.push(`${contradictedFactId} was the evidence carrying ${assumptionId}.`);
    }
    const decisionId = propagation.decisions[0]?.id;
    if (decisionId && assumptionId) {
      nodes.push(decisionId);
      edges.push({ id: edgeId(decisionId, 'depends_on', assumptionId), source: decisionId, target: assumptionId, type: 'depends_on', label: 'depends on' });
      narration.push(`${decisionId} depends on ${assumptionId}, so it is flagged for review - not declared invalid.`);
    }
    for (const d of propagation.decisions.slice(1)) {
      narration.push(`${d.id} is also affected at confidence ${d.confidence}.`);
    }
    for (const u of propagation.uncertain) {
      narration.push(`${u.id} sits below the review threshold at confidence ${u.confidence} and is reported as uncertain.`);
    }
    return { nodes, edges, narration, from: newFactId, to: decisionId || null, hops: edges.length };
  }

  propagation() {
    return this.mutation?.propagation || null;
  }

  // -------------------------------------------------------------- node states

  nodeState(node) {
    const m = this.mutation;
    if (m) {
      const forDecision = this.alertList.filter((a) => a.decision_ids.includes(node.id));
      if (forDecision.length) {
        const active = forDecision.filter((a) => a.status === 'CONFIRMED_STALE' || a.status === 'NEEDS_REVIEW' || a.status === 'NEW');
        if (forDecision.some((a) => a.status === 'CONFIRMED_STALE')) return 'confirmed_stale';
        if (forDecision.some((a) => a.status === 'DISMISSED') && active.length === 0) return 'dismissed';
        if (forDecision.some((a) => a.status === 'RESOLVED') && active.length === 0) return 'resolved';
        if (active.length) return 'needs_review';
      }
      if (m.factUpdates[node.id]?.state) return m.factUpdates[node.id].state;
      if (m.assumptionUpdates[node.id]) return 'potentially_affected';
      if (m.decisionUpdates[node.id]?.state) return m.decisionUpdates[node.id].state;
    }
    return 'normal';
  }

  materialise(node) {
    const m = this.mutation;
    const out = clone(node);
    if (!m) return out;
    const fu = m.factUpdates[node.id];
    if (fu) {
      if (fu.valid_to !== undefined) out.valid_to = fu.valid_to;
      out.state = fu.state;
      if (fu.superseded_at) out.properties.superseded_at = fu.superseded_at;
      if (fu.contradicted_by) out.properties.contradicted_by = fu.contradicted_by;
      if (fu.contradicts) out.properties.contradicts = fu.contradicts;
      out.properties.validity = fu.state === 'contradicted' ? 'contradicted' : 'valid';
    }
    const au = m.assumptionUpdates[node.id];
    if (au) {
      out.properties = { ...out.properties, ...au, supported_by: node.properties.supported_by };
      out.confidence = au.confidence;
    }
    const du = m.decisionUpdates[node.id];
    if (du) {
      out.properties = { ...out.properties, ...du };
      out.confidence = du.confidence;
      out.state = this.nodeState(node);
    }
    if (node.id in m.factUpdates || node.id in m.assumptionUpdates || node.id in m.decisionUpdates) {
      out.state = this.nodeState(node);
    }
    return out;
  }

  addSourceNode(s) {
    const n = {
      id: s.id,
      type: s.type === 'slack_message' ? 'message' : 'document',
      label: s.title,
      state: 'normal',
      summary: s.text.length > 160 ? `${s.text.slice(0, 157)}...` : s.text,
      confidence: null,
      project_ids: (s.entity_ids || []).filter((e) => e.startsWith('PRJ-')),
      team_ids: [],
      valid_from: null,
      valid_to: null,
      recorded_at: s.recorded_at,
      degree: 0,
      source_ids: [s.id],
      properties: {
        source_type: s.type, author_id: s.author_id, timestamp: s.timestamp,
        external_id: s.external_id, simulated: true,
        excerpt: s.text.length > 240 ? `${s.text.slice(0, 237)}...` : s.text,
        metadata: s.metadata || {}, operator_entry: Boolean(s.operator_entry),
      },
    };
    this.extraNodes.push(n);
    if (s.author_id) {
      this.extraEdges.push({ id: edgeId(s.author_id, 'author_of', s.id), source: s.author_id, target: s.id, type: 'author_of', label: 'author of', confidence: null, properties: {} });
    }
    for (const e of s.entity_ids || []) {
      this.extraEdges.push({ id: edgeId(s.id, 'about', e), source: s.id, target: e, type: 'about', label: 'about', confidence: null, properties: {} });
    }
    return n;
  }

  // -------------------------------------------------------------------- graph

  graph(params = {}) {
    const includeSources = params.include_sources !== false && params.include_sources !== 'false';
    let nodes = this.allNodes.map((n) => this.materialise(n));
    if (!includeSources) nodes = nodes.filter((n) => n.type !== 'message' && n.type !== 'document');

    if (params.types) {
      const set = new Set(String(params.types).split(',').map((s) => s.trim()).filter(Boolean));
      if (set.size) nodes = nodes.filter((n) => set.has(n.type));
    }
    if (params.project_id) {
      nodes = nodes.filter((n) => n.id === params.project_id || (n.project_ids || []).includes(params.project_id));
    }
    if (params.status) {
      const wanted = String(params.status);
      nodes = nodes.filter((n) => n.state === wanted || n.properties?.status === wanted || n.properties?.review_state === wanted);
    }
    if (params.q) nodes = nodes.filter((n) => matches(n, params.q));

    const allNodes = this.allNodes.map((n) => this.materialise(n));
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    let edges = this.allEdges;

    let truncated = false;
    let totalMatching = nodes.length;
    if (params.focus_id) {
      const depth = Math.max(1, Math.min(4, Number(params.depth) || 1));
      const adjacency = buildAdjacency(edges);
      const seen = new Set([String(params.focus_id)]);
      let frontier = [String(params.focus_id)];
      for (let d = 0; d < depth; d += 1) {
        const next = [];
        for (const id of frontier) {
          for (const nb of adjacency.get(id) || []) {
            if (!seen.has(nb.nodeId) && byId.has(nb.nodeId)) {
              seen.add(nb.nodeId);
              next.push(nb.nodeId);
            }
          }
        }
        frontier = next;
      }
      nodes = nodes.filter((n) => seen.has(n.id));
      totalMatching = nodes.length;
    }
    if (nodes.length > GRAPH_NODE_LIMIT) {
      truncated = true;
      nodes = nodes.slice(0, GRAPH_NODE_LIMIT);
    }
    const kept = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));

    const degree = new Map();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    nodes = nodes.map((n) => ({ ...n, degree: degree.get(n.id) || 0 }));

    const by_type = {};
    const by_state = {};
    for (const n of nodes) {
      by_type[n.type] = (by_type[n.type] || 0) + 1;
      by_state[n.state] = (by_state[n.state] || 0) + 1;
    }
    return {
      revision: this.revision,
      generated_at: this.base.demo_clock,
      nodes,
      edges,
      stats: {
        node_count: nodes.length, edge_count: edges.length, by_type, by_state,
        total_matching: totalMatching, total_nodes: allNodes.length, total_edges: this.allEdges.length,
      },
      truncated,
      filters: {
        types: params.types || null, project_id: params.project_id || null, status: params.status || null,
        q: params.q || null, include_sources: includeSources, focus_id: params.focus_id || null,
      },
    };
  }

  pathBetween(from, to) {
    const fromId = String(from); const toId = String(to);
    const byId = this.nodeById;
    if (!byId.has(fromId)) throw notFound('Node', fromId);
    if (!byId.has(toId)) throw notFound('Node', toId);
    const adjacency = buildAdjacency(this.allEdges);
    const prev = new Map([[fromId, null]]);
    const queue = [fromId];
    while (queue.length) {
      const current = queue.shift();
      if (current === toId) break;
      for (const nb of adjacency.get(current) || []) {
        if (!prev.has(nb.nodeId) && byId.has(nb.nodeId)) {
          prev.set(nb.nodeId, { id: current, edge: nb.edge });
          queue.push(nb.nodeId);
        }
      }
    }
    if (!prev.has(toId)) {
      throw new ApiError(404, 'not_connected', `${fromId} and ${toId} are not connected in the current graph`, { from: fromId, to: toId });
    }
    const reverse = [];
    let cursor = toId;
    while (prev.get(cursor)) {
      const step = prev.get(cursor);
      reverse.push({ from: step.id, to: cursor, edge: step.edge });
      cursor = step.id;
    }
    reverse.reverse();
    const nodes = [fromId, ...reverse.map((s) => s.to)];
    const edges = reverse.map((s) => s.edge).filter((e) => e);
    return {
      found: true,
      from: fromId,
      to: toId,
      nodes,
      edges,
      hops: edges.length,
      narration: edges.map((e) => `${e.source} ${e.label || e.type} ${e.target}`),
    };
  }

  path(from, to) {
    if (!from || !to) throw badRequest('Query params "from" and "to" are required.');
    return this.pathBetween(from, to);
  }

  // ---------------------------------------------------------------- decisions

  decisionSummary(node) {
    const state = this.nodeState(node);
    const alerts = this.alertList.filter((a) => a.decision_ids.includes(node.id));
    const status = state === 'needs_review' ? 'needs_review'
      : state === 'confirmed_stale' ? 'confirmed_stale'
        : state === 'dismissed' ? 'active'
          : (node.properties.status || 'active');
    const alertStatuses = alerts.map((a) => a.status);
    const reviewState = alertStatuses.includes('CONFIRMED_STALE') ? 'confirmed_stale'
      : alertStatuses.includes('NEEDS_REVIEW') || alertStatuses.includes('NEW') ? 'needs_review'
        : alertStatuses.includes('DISMISSED') ? 'dismissed'
          : alertStatuses.includes('RESOLVED') ? 'resolved'
            : (node.properties.review_state || (state === 'normal' ? 'none' : state));
    return {
      id: node.id,
      title: node.label,
      status,
      owner_id: node.properties.owner_id || null,
      project_ids: (node.project_ids || []).slice(),
      system_ids: (node.properties.system_ids || []).slice(),
      created_at: node.properties.created_at || node.recorded_at,
      recorded_at: node.recorded_at,
      assumption_ids: (node.properties.assumption_ids || []).slice(),
      open_alert_count: alerts.filter((a) => a.status === 'NEW' || a.status === 'NEEDS_REVIEW').length,
      review_state: reviewState,
      confidence: node.confidence ?? null,
      graph_state: state,
      impact_weight: node.properties.impact_weight ?? null,
    };
  }

  decisions() {
    const nodes = this.allNodes.filter((n) => n.type === 'decision');
    const decisions = nodes.map((n) => this.decisionSummary(this.materialise(n)))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || (a.id < b.id ? -1 : 1));
    return { decisions, total: decisions.length };
  }

  decision(decisionId) {
    const raw = this.nodeById.get(decisionId);
    if (!raw || raw.type !== 'decision') throw notFound('Decision', decisionId);
    const node = this.materialise(raw);
    const assumptionIds = node.properties.assumption_ids || [];
    const assumptions = assumptionIds.map((id) => {
      const a = this.nodeById.get(id);
      if (!a) return null;
      const am = this.materialise(a);
      return {
        id: am.id, label: am.label, statement: am.properties.statement,
        status: am.properties.status || 'supported', confidence: am.confidence,
        supported_by: (am.properties.supported_by || []).slice(),
        contradicted_by: (am.properties.contradicted_by || []).slice(),
        alternate_evidence: am.properties.alternate_evidence || [],
      };
    }).filter(Boolean);

    const supportingFactIds = [...new Set(assumptions.flatMap((a) => a.supported_by))];
    const contradictedFactIds = [...new Set(assumptions.flatMap((a) => a.contradicted_by))];
    const factNode = (id) => {
      const f = this.nodeById.get(id);
      return f ? this.materialise(f) : null;
    };

    const people = [];
    const owner = this.nodeById.get(node.properties.owner_id);
    if (owner) people.push({ id: owner.id, name: owner.label, role: 'decision_owner', reason: `Accountable owner recorded for ${node.id}.` });
    if (this.mutation) {
      const inv = this.suggestInvestigators(node.id, this.mutation.rule);
      for (const p of inv) if (!people.some((x) => x.id === p.id)) people.push(p);
    }

    const sources = [...new Set([
      ...(node.source_ids || []),
      ...supportingFactIds.flatMap((id) => factNode(id)?.source_ids || []),
      ...contradictedFactIds.flatMap((id) => factNode(id)?.source_ids || []),
    ])].map((id) => this.sourceRecord(id)).filter(Boolean);

    const history = this.decisionHistory(node, assumptions);

    const unavailable = [];
    if (!node.properties.owner_id) unavailable.push('owner_id');
    if (!assumptions.length) unavailable.push('assumptions');
    if (!sources.length) unavailable.push('sources');
    if (!this.mutation) unavailable.push('contradiction_history');
    else if (!this.alertList.some((a) => a.decision_ids.includes(node.id))) unavailable.push('alert');

    return {
      decision: this.decisionSummary(node),
      description: node.properties.description || null,
      assumptions,
      supporting_facts: supportingFactIds.map(factNode).filter(Boolean),
      contradicted_facts: contradictedFactIds.map(factNode).filter(Boolean),
      projects: (node.project_ids || []).map((id) => ({ id, title: this.nodeById.get(id)?.label || id })),
      systems: (node.properties.system_ids || []).map((id) => ({ id, title: this.nodeById.get(id)?.label || id })),
      people,
      sources,
      history,
      alerts: this.alertList.filter((a) => a.decision_ids.includes(node.id)).map(friendlyAlert),
      unavailable,
      graph_state: this.nodeState(raw),
    };
  }

  decisionHistory(node, assumptions) {
    const entries = [];
    entries.push({
      at: node.properties.created_at || node.recorded_at, kind: 'created', actor: node.properties.owner_id,
      summary: `Decision recorded from ${node.properties.created_from || 'an unspecified source'}.`,
    });
    for (const a of assumptions) {
      for (const f of a.supported_by) {
        const fact = this.nodeById.get(f);
        if (fact) entries.push({ at: fact.recorded_at, kind: 'fact_recorded', actor: fact.properties.extracted_from, summary: `Assumption carried by fact ${f}.` });
      }
      for (const f of a.contradicted_by) {
        const m = this.mutation;
        entries.push({ at: m?.event.recorded_at || this.base.demo_clock, kind: 'assumption_challenged', actor: m?.event.actor, summary: `Assumption ${a.id} challenged by ${f}.` });
      }
    }
    for (const alert of this.alertList.filter((a) => a.decision_ids.includes(node.id))) {
      for (const h of alert.history) entries.push({ at: h.at, kind: h.kind || 'review_changed', actor: h.actor, summary: `${alert.id}: ${h.note}` });
    }
    return entries.filter((e) => e.at).sort((a, b) => (a.at < b.at ? -1 : 1));
  }

  buildExplanation(decisionId, ctx) {
    const { propagation, event, newFactId, contradictedFactId } = ctx;
    const rule = this.mutation?.rule;
    const decisionNode = this.nodeById.get(decisionId);
    const flagged = propagation.decisions.find((d) => d.id === decisionId);
    const uncertain = propagation.uncertain.find((d) => d.id === decisionId);
    const entry = flagged || uncertain;
    const assumptionId = entry?.assumption_ids?.[0] || this.base.storyline.assumption_id;
    const assumption = this.nodeById.get(assumptionId);
    const challenged = this.nodeById.get(contradictedFactId);
    const newFact = this.nodeById.get(newFactId);

    let path = { nodes: [], edges: [], narration: [] };
    try {
      path = this.pathBetween(newFactId, decisionId);
    } catch {
      path = ctx.path || { nodes: [], edges: [], narration: [] };
    }

    const why = [];
    why.push(`Event ${event.id} recorded "${event.raw_text}" and introduced ${newFactId} (${event.method}, confidence ${event.confidence}).`);
    why.push(`${newFactId} contradicts ${contradictedFactId}, which carried the assumption ${assumptionId}.`);
    if (entry) {
      why.push(`${decisionId} depends on ${assumptionId}; computed confidence ${entry.confidence} against a review threshold of ${THRESHOLDS.requires_investigation} for impact weight ${decisionNode?.properties.impact_weight}.`);
      if (flagged) why.push('The threshold was crossed, so the decision is flagged for human review. It is not declared invalid.');
      else why.push('The threshold was not crossed, so it is reported as uncertain rather than flagged.');
    }

    const supportingSources = [...new Set([
      ...(challenged?.source_ids || []),
      ...(newFact?.source_ids || []),
      ...(entry ? [] : []),
    ])].map((id) => this.sourceRecord(id)).filter(Boolean);

    return {
      decision_id: decisionId,
      headline: flagged
        ? `${decisionNode?.label || decisionId} depends on a certification the Frankfurt partner no longer holds`
        : `${decisionNode?.label || decisionId} is related to the change but below the review threshold`,
      why_flagged: why,
      new_information: newFact ? { fact_id: newFactId, summary: newFact.summary, recorded_at: newFact.recorded_at, source_id: newFact.properties.extracted_from } : null,
      challenged_fact: challenged ? {
        id: challenged.id, label: challenged.label, statement: challenged.properties.statement,
        valid_from: challenged.valid_from, valid_to: challenged.valid_to,
        recorded_at: challenged.recorded_at, superseded_at: challenged.properties.superseded_at || null,
        state: this.nodeState(challenged),
      } : null,
      connecting_assumption: assumption ? {
        id: assumption.id, label: assumption.label, statement: assumption.properties.statement,
        status: assumption.properties.status || 'supported', confidence: assumption.confidence,
        alternate_evidence: assumption.properties.alternate_evidence || [],
      } : null,
      path,
      supporting_sources: supportingSources,
      alternate_evidence: entry?.alternate_evidence || [],
      uncertainty: [...(rule?.uncertainty || []), ...(entry?.requires_investigation === false ? ['Reported as uncertain: alternate evidence has not been ruled out.'] : [])],
      suggested_investigators: this.suggestInvestigators(decisionId, rule || { new_fact: { system_ids: [] } }),
      generated_by: METHOD,
      generated_at: event.recorded_at,
      unavailable: entry ? [] : ['contradiction_path'],
    };
  }

  explanation(decisionId) {
    const node = this.nodeById.get(decisionId);
    if (!node || node.type !== 'decision') throw notFound('Decision', decisionId);
    if (!this.mutation) {
      const assumptionIds = node.properties.assumption_ids || [];
      const supporting = [...new Set(assumptionIds.flatMap((a) => this.nodeById.get(a)?.properties.supported_by || []))];
      return {
        decision_id: decisionId,
        headline: 'No contradiction affects this decision at the current revision.',
        why_flagged: [],
        new_information: null,
        challenged_fact: null,
        connecting_assumption: null,
        path: { nodes: [], edges: [], narration: [] },
        supporting_sources: [...new Set(supporting.flatMap((f) => this.nodeById.get(f)?.source_ids || []))]
          .map((id) => this.sourceRecord(id)).filter(Boolean),
        alternate_evidence: [],
        uncertainty: [
          'Nothing is flagged for review at the baseline revision.',
          'This is the recorded state of the graph, not a guarantee that the assumptions hold in the real world.',
        ],
        suggested_investigators: [],
        generated_by: METHOD,
        generated_at: this.base.demo_clock,
        unavailable: ['contradiction_path'],
      };
    }
    return this.buildExplanation(decisionId, {
      propagation: this.mutation.propagation, event: this.mutation.event,
      newFactId: this.mutation.propagation.new_fact_id, contradictedFactId: this.mutation.propagation.contradicted_fact_id,
      path: this.mutation.path,
    });
  }

  // ------------------------------------------------------------------- alerts

  alerts(params = {}) {
    let list = this.alertList.map(friendlyAlert);
    if (params.status) list = list.filter((a) => a.status === String(params.status));
    if (params.decision_id) list = list.filter((a) => a.decision_ids.includes(params.decision_id));
    if (params.project_id) list = list.filter((a) => a.project_ids.includes(params.project_id));
    const by_status = {};
    for (const a of this.alertList) by_status[a.status] = (by_status[a.status] || 0) + 1;
    return {
      alerts: list.sort((a, b) => (b.created_at < a.created_at ? -1 : 1)),
      total: list.length,
      by_status,
      allowed_transitions: REVIEW_TRANSITIONS,
      empty_reason: this.alertList.length === 0
        ? 'No contradictions have been detected in the recorded graph. Alerts appear here only when an event contradicts a fact that decisions depend on.'
        : null,
    };
  }

  alert(alertId) {
    const found = this.alertList.find((a) => a.id === alertId);
    if (!found) throw notFound('Alert', alertId);
    return friendlyAlert(found);
  }

  reviewAlert(alertId, body = {}) {
    const found = this.alertList.find((a) => a.id === alertId);
    if (!found) throw notFound('Alert', alertId);
    const target = typeof body.status === 'string' ? body.status.toUpperCase() : '';
    if (!target) throw validationError('Field "status" is required.', { allowed: Object.keys(REVIEW_TRANSITIONS) });
    if (!REVIEW_TRANSITIONS[found.status]) throw conflict(`Alert ${alertId} has unknown status ${found.status}.`);
    if (!REVIEW_TRANSITIONS[found.status].includes(target)) {
      throw conflict(`Cannot move alert ${alertId} from ${found.status} to ${target}.`, { from: found.status, allowed: REVIEW_TRANSITIONS[found.status] });
    }
    const at = this.base.demo_clock;
    const actor = body.actor || 'reviewer';
    found.status = target;
    found.updated_at = at;
    found.history.push({ at, from: found.history[found.history.length - 1]?.to || null, to: target, actor, note: body.note || `Status changed to ${target}.` });
    this.reviewLog.push({ at, alert_id: alertId, to: target, actor, note: body.note || null });
    return friendlyAlert(found);
  }

  // ------------------------------------------------------------------ sources

  sourceRecord(id) {
    const s = this.allSources.find((x) => x.id === id);
    if (!s) return null;
    return {
      ...clone(s),
      author_name: s.author_id ? (this.nodeById.get(s.author_id)?.label || null) : (s.author_name || null),
      excerpt: s.text.length > 240 ? `${s.text.slice(0, 237)}...` : s.text,
      simulated: true,
    };
  }

  sources(params = {}) {
    const q = params.q ? String(params.q).toLowerCase() : null;
    let list = this.allSources.slice();
    if (params.type) list = list.filter((s) => s.type === String(params.type));
    if (params.author_id) list = list.filter((s) => s.author_id === params.author_id);
    if (params.project_id) list = list.filter((s) => (s.entity_ids || []).includes(params.project_id));
    if (params.entity_id) list = list.filter((s) => (s.entity_ids || []).includes(params.entity_id) || (s.fact_ids || []).includes(params.entity_id));
    if (q) list = list.filter((s) => `${s.title} ${s.text}`.toLowerCase().includes(q));
    const limit = Number(params.limit) || 200;
    const by_type = {};
    for (const s of this.allSources) by_type[s.type] = (by_type[s.type] || 0) + 1;
    return {
      sources: list.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, limit).map((s) => this.sourceRecord(s.id)),
      total: list.length,
      by_type,
    };
  }

  source(sourceId) {
    const s = this.sourceRecord(sourceId);
    if (!s) throw notFound('Source', sourceId);
    const factIds = [...new Set([...(s.fact_ids || []), ...this.allFacts.filter((f) => (f.source_ids || []).includes(sourceId)).map((f) => f.id)])];
    const facts = factIds.map((id) => this.materialise(this.nodeById.get(id))).filter(Boolean);
    const supportedAssumptionIds = [...new Set(facts.flatMap((f) => this.allEdges.filter((e) => e.source === f.id && e.type === 'supports').map((e) => e.target)))];
    const decisions = [...new Set(supportedAssumptionIds.flatMap((a) => this.allNodes.filter((n) => n.type === 'decision' && (n.properties.assumption_ids || []).includes(a)).map((n) => n.id)))];
    return {
      source: s,
      supports_facts: facts,
      supports_assumptions: supportedAssumptionIds.map((id) => {
        const a = this.nodeById.get(id);
        return a ? { id: a.id, label: a.label, statement: a.properties?.statement || '' } : null;
      }).filter(Boolean),
      supports_decisions: decisions.map((id) => this.decisionSummary(this.materialise(this.nodeById.get(id)))),
      linked_entities: [...new Set(s.entity_ids || [])].map((id) => {
        const n = this.nodeById.get(id);
        return n ? { id: n.id, type: n.type, label: n.label, state: this.nodeState(n) } : null;
      }).filter(Boolean),
      provenance: this.buildProvenanceForSource(s),
      simulated: true,
    };
  }

  buildProvenanceForSource(s) {
    const steps = [{
      kind: 'original_source', ref_id: s.id, label: s.title, actor: s.author_id,
      at: s.timestamp, text: s.text, simulated: true, source_type: s.type,
    }];
    const claims = extractClaims(s.text, { sourceType: s.type }).claims;
    for (const c of claims) steps.push({ kind: 'extracted_claim', ref_id: c.id, label: c.text.slice(0, 80), actor: 'system', at: s.recorded_at, text: c.text, confidence: c.confidence, needs_review: c.needs_review, reason: c.reason, method: METHOD });
    for (const f of s.fact_ids || []) {
      steps.push({ kind: 'system_interpretation', ref_id: f, label: `Recorded as graph fact ${f}`, actor: 'system', at: s.recorded_at, text: this.nodeById.get(f)?.properties?.statement || '', method: METHOD });
    }
    return steps;
  }

  // --------------------------------------------------------------------- facts

  factValidity(node) {
    const m = this.nodeById.get(node.id);
    const state = m ? this.nodeState(m) : 'normal';
    if (state === 'contradicted') return 'contradicted';
    if (node.properties.superseded_at) return 'stale';
    if (node.valid_to) return 'stale';
    if (node.confidence !== null && node.confidence < 0.65) return 'uncertain';
    return 'open';
  }

  factSummary(node) {
    return {
      id: node.id, statement: node.properties.statement || node.summary, label: node.label,
      kind: node.properties.kind || 'fact', state: this.nodeState(this.nodeById.get(node.id) || node),
      validity: this.factValidity(node), confidence: node.confidence,
      valid_from: node.valid_from, valid_to: node.valid_to, recorded_at: node.recorded_at,
      superseded_at: node.properties.superseded_at || null,
      source_ids: (node.source_ids || []).slice(), system_ids: (node.properties.system_ids || []).slice(),
      project_ids: (node.project_ids || []).slice(),
    };
  }

  facts(params = {}) {
    let list = this.allFacts.map((f) => this.materialise(f));
    if (params.state) list = list.filter((f) => this.nodeState(this.nodeById.get(f.id)) === String(params.state));
    if (params.q) list = list.filter((f) => `${f.summary} ${f.id}`.toLowerCase().includes(String(params.q).toLowerCase()));
    return {
      facts: list.map((f) => this.factSummary(f)).sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1)),
      total: list.length,
    };
  }

  fact(factId) {
    const raw = this.nodeById.get(factId);
    if (!raw || raw.type !== 'fact') throw notFound('Fact', factId);
    const node = this.materialise(raw);
    const supports = this.allEdges.filter((e) => e.source === factId && e.type === 'supports').map((e) => this.nodeById.get(e.target)).filter(Boolean)
      .map((a) => ({ id: a.id, label: a.label, statement: a.properties?.statement || '' }));
    const decisionsAffected = [...new Set(supports.flatMap((a) => this.allNodes.filter((n) => n.type === 'decision' && (n.properties.assumption_ids || []).includes(a.id)).map((n) => n.id)))]
      .map((id) => this.decisionSummary(this.materialise(this.nodeById.get(id))));
    const contradictedBy = (node.properties.contradicted_by || []).map((id) => this.factSummary(this.materialise(this.nodeById.get(id)) || {}));
    const contradicts = (node.properties.contradicts || []).map((id) => this.factSummary(this.materialise(this.nodeById.get(id)) || {}));
    const sources = (node.source_ids || []).map((id) => this.sourceRecord(id)).filter(Boolean);
    return {
      fact: node,
      statement: node.properties.statement || node.summary,
      kind: node.properties.kind || 'fact',
      valid_from: node.valid_from, valid_to: node.valid_to,
      recorded_at: node.recorded_at, superseded_at: node.properties.superseded_at || null,
      validity: this.factValidity(node),
      confidence: node.confidence,
      sources,
      supports,
      contradicted_by: contradictedBy.filter((f) => f.id),
      contradicts: contradicts.filter((f) => f.id),
      affects_decisions: decisionsAffected,
      recorded_time_note: node.valid_from && node.recorded_at
        ? (node.valid_from === node.recorded_at
          ? 'Tripwire recorded this at the same time it became true.'
          : `Tripwire learned about this on ${node.recorded_at}; it was already true on ${node.valid_from}.`)
        : null,
      provenance: this.buildProvenanceForFact(node),
      unavailable: (node.source_ids || []).length ? [] : ['sources'],
    };
  }

  buildProvenanceForFact(node) {
    const steps = [];
    for (const sid of node.source_ids || []) {
      const s = this.sourceRecord(sid);
      if (!s) continue;
      steps.push({
        kind: 'original_source', ref_id: s.id, label: s.title, actor: s.author_id, actor_name: s.author_name,
        at: s.timestamp, text: s.text, simulated: true, source_type: s.type, external_id: s.external_id,
      });
    }
    steps.push({
      kind: 'extracted_claim', ref_id: `CLM-${node.id}`, label: node.summary, actor: 'system', at: node.recorded_at,
      text: node.properties.statement || node.summary, confidence: node.confidence, needs_review: false, method: METHOD,
      note: 'Deterministic extraction recorded this statement as a graph fact.',
    });
    for (const e of this.allEdges.filter((x) => x.source === node.id || x.target === node.id)) {
      if (!['supports', 'contradicts', 'supersedes'].includes(e.type)) continue;
      const other = this.nodeById.get(e.source === node.id ? e.target : e.source);
      steps.push({
        kind: 'system_interpretation', ref_id: e.id, label: `${e.label}`,
        actor: 'system', at: this.mutation?.event.recorded_at || node.recorded_at,
        text: e.source === node.id
          ? `Tripwire linked ${node.id} to ${other?.label || e.target} (${e.type}).`
          : `Tripwire linked ${other?.label || e.source} to ${node.id} (${e.type}).`,
        confidence: e.confidence, method: METHOD, target_id: other?.id,
      });
    }
    const assumptionIds = this.allEdges.filter((e) => e.source === node.id && e.type === 'supports').map((e) => e.target);
    for (const decision of this.allNodes.filter((n) => n.type === 'decision' && (n.properties.assumption_ids || []).some((a) => assumptionIds.includes(a)))) {
      steps.push({
        kind: 'business_decision', ref_id: decision.id, label: decision.label, actor: decision.properties.owner_id,
        at: decision.properties.created_at, text: decision.properties.description || '', created_from: decision.properties.created_from,
        note: 'Human decision that ultimately rests on this fact.',
      });
    }
    return steps;
  }

  provenance(factId) {
    const raw = this.nodeById.get(factId);
    if (!raw || raw.type !== 'fact') throw notFound('Fact', factId);
    return { fact_id: factId, chain: this.buildProvenanceForFact(this.materialise(raw)), simulated: true };
  }

  // ------------------------------------------------------------------- history

  timeline(params = {}) {
    const entries = [];
    for (const s of this.allSources) {
      entries.push({ at: s.recorded_at, recorded_at: s.recorded_at, kind: 'source_recorded', summary: `Source recorded: ${s.title}`, entity_ids: s.entity_ids || [], source_ids: [s.id], actor: s.author_id, source_type: s.type });
    }
    for (const f of this.allFacts) {
      entries.push({ at: f.recorded_at, recorded_at: f.recorded_at, kind: 'fact_recorded', summary: `Fact recorded: ${f.summary}`, entity_ids: [f.id], source_ids: f.source_ids || [], actor: f.properties.extracted_from || 'system' });
      if (f.properties.superseded_at) {
        entries.push({ at: f.properties.superseded_at, recorded_at: f.properties.superseded_at, kind: 'fact_contradicted', summary: `Contradicted: ${f.summary}`, entity_ids: [f.id, ...(f.properties.contradicted_by || [])], source_ids: f.source_ids || [], actor: 'system' });
      }
    }
    for (const e of [...this.base.events, ...(this.mutation ? [this.mutation.event] : [])]) {
      entries.push({ at: e.recorded_at, recorded_at: e.recorded_at, kind: 'event_recorded', summary: `Event: ${e.summary}`, entity_ids: e.fact_ids || [], source_ids: e.source_id ? [e.source_id] : [], actor: e.actor });
    }
    for (const a of this.alertList) {
      for (const h of a.history) {
        entries.push({ at: h.at, recorded_at: h.at, kind: h.from === null ? 'alert_raised' : 'review_changed', summary: `${a.id}: ${h.note}`, entity_ids: [...a.decision_ids, ...a.assumption_ids], source_ids: a.source_ids, actor: h.actor });
      }
    }
    const limit = Number(params.limit) || 200;
    const sorted = entries.sort((a, b) => (a.at < b.at ? 1 : -1));
    return { events: sorted.slice(0, limit), total: sorted.length, demo_clock: this.base.demo_clock, seeded_at: this.base.seeded_at };
  }

  history(params = {}) {
    const at = params.at || this.base.demo_clock;
    const mutationAt = this.mutation?.event.recorded_at || null;

    const facts = this.allNodes
      .filter((n) => n.type === 'fact')
      .map((n) => this.materialise(n))
      .map((f) => {
        let belief;
        if (f.recorded_at > at) belief = 'unknown_yet';
        else if (f.properties.superseded_at && f.properties.superseded_at <= at) belief = 'believed_false';
        else belief = 'believed_true';
        return {
          id: f.id, statement: f.properties.statement || f.summary, label: f.label,
          valid_from: f.valid_from,
          valid_to: f.properties.superseded_at && f.properties.superseded_at <= at ? f.valid_to : (f.recorded_at <= at ? f.valid_to : f.valid_to),
          recorded_at: f.recorded_at,
          superseded_at: f.properties.superseded_at || null,
          belief,
          confidence: belief === 'believed_true' ? f.confidence : null,
          current_state: this.nodeState(this.nodeById.get(f.id)),
          source_ids: f.source_ids || [],
        };
      })
      .filter((f) => !params.entity_id || f.id === params.entity_id || (this.nodeById.get(params.entity_id)?.properties?.assumption_ids || []).includes(f.id));

    const decisions = this.allNodes
      .filter((n) => n.type === 'decision')
      .map((n) => {
        const node = this.materialise(n);
        const recordedAt = node.properties.created_at || node.recorded_at;
        const affectedAt = mutationAt && this.mutation.propagation.flagged_ids.concat(this.mutation.propagation.uncertain.map((u) => u.id)).includes(n.id) ? mutationAt : null;
        const statusAtTime = recordedAt && recordedAt > at ? 'not_yet_decided' : (affectedAt && affectedAt <= at ? (this.mutation.propagation.flagged_ids.includes(n.id) ? 'needs_review' : 'potentially_affected') : 'active');
        return {
          id: n.id, title: n.label, status_at_time: statusAtTime, status_now: this.decisionSummary(node).status,
          created_at: recordedAt, review_state_now: node.properties.review_state || 'none',
        };
      });

    const all = this.timeline({ limit: 500 }).events;
    const changes = all.filter((e) => e.at <= at).slice(0, 60);

    return {
      as_of: at,
      mode: 'recorded_time',
      demo_clock: this.base.demo_clock,
      seeded_at: this.base.seeded_at,
      event_applied: Boolean(this.mutation),
      event_recorded_at: mutationAt,
      facts: facts.sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1)),
      changes,
      timeline: all.slice(0, 120),
      decisions,
      notes: [
        'valid_from / valid_to describe when something was true in the world.',
        'recorded_at / superseded_at describe when Tripwire knew it.',
        'Beliefs shown here are reconstructed from recorded times, not by re-stamping the current graph.',
      ],
    };
  }

  // -------------------------------------------------------------------- people

  personSummary(node) {
    const authored = this.allSources.filter((s) => s.author_id === node.id);
    return {
      id: node.id, name: node.label, team_id: node.properties.team_id,
      team_name: this.nodeById.get(node.properties.team_id)?.label || null,
      title: node.properties.title, official_owner_of: node.properties.official_owner_of || [],
      contribution_count: authored.length,
      project_ids: (node.project_ids || []).slice(),
      system_ids: [...new Set(authored.flatMap((s) => (s.entity_ids || []).filter((e) => e.startsWith('SYS-'))))],
    };
  }

  people() {
    const people = this.allNodes.filter((n) => n.type === 'person').map((n) => this.personSummary(n))
      .sort((a, b) => b.contribution_count - a.contribution_count || a.name.localeCompare(b.name));
    return { people, total: people.length };
  }

  person(personId) {
    const raw = this.nodeById.get(personId);
    if (!raw || raw.type !== 'person') throw notFound('Person', personId);
    const authored = this.allSources.filter((s) => s.author_id === personId);
    const contributions = authored.map((s) => ({
      source_id: s.id, type: s.type, title: s.title, at: s.timestamp,
      entity_ids: s.entity_ids || [], role: s.type === 'ticket' && s.metadata?.resolved_by === personId ? 'resolver' : 'author',
      status: s.metadata?.status || null, simulated: true,
    })).sort((a, b) => (a.at < b.at ? 1 : -1));
    const counts = {
      messages: authored.filter((s) => s.type === 'slack_message').length,
      tickets: authored.filter((s) => s.type === 'ticket').length,
      tickets_resolved: authored.filter((s) => s.type === 'ticket' && s.metadata?.resolved_by === personId).length,
      prds: authored.filter((s) => s.type === 'prd').length,
      meeting_notes: authored.filter((s) => s.type === 'meeting_note').length,
    };
    return {
      person: this.personSummary(raw),
      blurb: raw.properties.blurb,
      joined: raw.properties.joined,
      contributions,
      contribution_counts: counts,
      systems: [...new Set(authored.flatMap((s) => (s.entity_ids || []).filter((e) => e.startsWith('SYS-'))))].map((id) => ({ id, title: this.nodeById.get(id)?.label || id })),
      projects: [...new Set(authored.flatMap((s) => (s.entity_ids || []).filter((e) => e.startsWith('PRJ-'))))].map((id) => ({ id, title: this.nodeById.get(id)?.label || id })),
      decisions: this.allNodes.filter((n) => n.type === 'decision' && n.properties.owner_id === personId).map((n) => this.decisionSummary(this.materialise(n))),
      team: raw.properties.team_id ? { id: raw.properties.team_id, name: this.nodeById.get(raw.properties.team_id)?.label } : null,
      caveat: 'Contributions are counted from recorded sources only. Absence of records is not evidence of absence of expertise.',
    };
  }

  experts(params = {}) {
    const systemId = params.system_id || this.base.storyline.system_id || 'SYS-FRANKFURT-HOSTING';
    if (!this.nodeById.has(systemId)) throw notFound('System', systemId);
    const limit = Math.max(1, Math.min(20, Number(params.limit) || 5));
    const ranking = rankExperts({ nodes: this.allNodes, sources: this.allSources }, systemId, limit);
    const forAlert = params.for_alert_id ? this.alertList.find((a) => a.id === params.for_alert_id) : null;
    return {
      ...ranking,
      for_alert_id: params.for_alert_id || null,
      alert_context: forAlert ? { id: forAlert.id, title: forAlert.title, confidence: forAlert.confidence } : null,
      recommended_contact: ranking.experts[0] ? {
        person_id: ranking.experts[0].person_id, name: ranking.experts[0].name,
        why: 'Highest weighted contribution to the affected system; recommended as the first contact for this review.',
        ranking_explanation: ranking.experts[0].ranking_explanation,
        uncertainty: ranking.experts[0].uncertainty,
      } : null,
    };
  }

  // ---------------------------------------------------------------- lookups

  projects() {
    return {
      projects: this.allNodes.filter((n) => n.type === 'project').map((n) => ({
        id: n.id, title: n.label, status: n.properties.status || 'unknown', team_id: n.properties.team_id,
        team_name: this.nodeById.get(n.properties.team_id)?.label || null,
        system_ids: (n.properties.system_ids || []).slice(),
        decision_ids: this.allNodes.filter((d) => d.type === 'decision' && (d.project_ids || []).includes(n.id)).map((d) => d.id),
        assumption_ids: (n.properties.assumption_ids || []).slice(),
        source_count: (n.source_ids || []).length,
        blurb: n.properties.blurb,
      })),
    };
  }

  systems() {
    return {
      systems: this.allNodes.filter((n) => n.type === 'system').map((n) => ({
        id: n.id, title: n.label, owner_id: n.properties.owner_id,
        owner_name: this.nodeById.get(n.properties.owner_id)?.label || null,
        project_ids: (n.project_ids || []).slice(),
        fact_ids: this.allFacts.filter((f) => (f.properties.system_ids || []).includes(n.id)).map((f) => f.id),
        criticality: n.properties.criticality, blurb: n.properties.blurb,
        state: this.nodeState(n),
      })),
    };
  }

  teams() {
    return {
      teams: this.allNodes.filter((n) => n.type === 'team').map((n) => ({
        id: n.id, name: n.label,
        person_ids: this.allNodes.filter((p) => p.type === 'person' && p.properties.team_id === n.id).map((p) => p.id),
        project_ids: (n.project_ids || []).slice(),
        focus: n.properties.focus,
      })),
    };
  }

  assumptions() {
    return {
      assumptions: this.allNodes.filter((n) => n.type === 'assumption').map((n) => {
        const a = this.materialise(n);
        return {
          id: a.id, label: a.label, statement: a.properties.statement,
          status: a.properties.status || 'supported', confidence: a.confidence,
          supported_by: (a.properties.supported_by || []).slice(),
          contradicted_by: (a.properties.contradicted_by || []).slice(),
          alternate_evidence: a.properties.alternate_evidence || [],
          decision_ids: (a.properties.decision_ids || []).slice(),
          state: this.nodeState(n),
        };
      }),
    };
  }

  events() {
    const list = [...this.base.events, ...(this.mutation ? [this.mutation.event] : [])];
    return { events: list.map((e) => ({ ...clone(e), applied: true })).sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1)) };
  }

  search(params = {}) {
    const q = (params.q || '').toString().trim().toLowerCase();
    const limit = Math.max(1, Math.min(50, Number(params.limit) || 12));
    if (!q) return { results: [], total: 0, query: q, empty_reason: 'Enter at least one character to search people, decisions, facts, projects, systems and sources.' };
    const results = [];
    for (const n of this.allNodes) {
      const haystack = `${n.label} ${n.summary} ${n.id} ${n.properties?.statement || ''}`.toLowerCase();
      const score = n.label.toLowerCase().includes(q) ? 1 : haystack.includes(q) ? 0.6 : 0;
      if (score > 0) {
        results.push({
          id: n.id, type: n.type, label: n.label,
          subtitle: n.summary?.slice(0, 120) || n.id,
          score, state: this.nodeState(n),
        });
      }
    }
    for (const s of this.allSources) {
      const haystack = `${s.title} ${s.text}`.toLowerCase();
      if (!haystack.includes(q)) continue;
      results.push({
        id: s.id, type: s.type, label: s.title,
        subtitle: s.text.slice(0, 120), score: 0.5, state: 'normal',
      });
    }
    const sorted = results.sort((a, b) => b.score - a.score).slice(0, limit);
    return {
      results: sorted, total: results.length, query: q,
      empty_reason: sorted.length === 0 ? `Nothing in the recorded graph matches "${q}".` : null,
    };
  }

  // ---------------------------------------------------------------- ingestion

  integrations() {
    return {
      integrations: [
        { id: 'slack', label: 'Slack', available: false, mechanism: 'structured_input', accepted_types: ['slack_message'], note: 'No live Slack workspace is connected in this deployment. Slack-shaped records are entered as structured input and stored as simulated sources.' },
        { id: 'ticketing', label: 'Ticketing', available: false, mechanism: 'structured_input', accepted_types: ['ticket'], note: 'No live ticketing connector is configured. Ticket records are entered as structured input.' },
        { id: 'files', label: 'Documents', available: true, mechanism: 'paste_or_upload', accepted_types: ['prd', 'meeting_note'], accepted_files: ['.md', '.txt', '.json'], note: 'PRDs and meeting notes are ingested from pasted text or a plain-text file selected in the browser.' },
      ],
      supported_source_types: ['slack_message', 'ticket', 'prd', 'meeting_note'],
      extractor: METHOD,
      honest_note: 'This deployment has no live provider connections. Anything shown as ingested here is stored as a simulated source until a real backend integration is configured.',
    };
  }

  ingest(body = {}) {
    const type = String(body.source_type || '').toLowerCase();
    const allowed = ['slack_message', 'ticket', 'prd', 'meeting_note'];
    if (!allowed.includes(type)) {
      throw validationError('Unsupported source_type.', { field: 'source_type', allowed });
    }
    const text = (body.text || '').toString().trim();
    if (text.length < 12) throw validationError('Field "text" is required and must be at least 12 characters.', { field: 'text', min_length: 12 });
    if (body.author_id && !this.nodeById.has(body.author_id)) {
      throw validationError('Unknown author_id.', { field: 'author_id', allowed: this.allNodes.filter((n) => n.type === 'person').map((n) => n.id) });
    }
    const occurredAt = body.occurred_at || this.base.demo_clock;
    const title = (body.title || (type === 'ticket' ? 'Ad-hoc ticket' : type === 'prd' ? 'Ad-hoc PRD' : type === 'meeting_note' ? 'Ad-hoc meeting note' : '#ad-hoc')).toString();
    const extraction = extractClaims(text, { sourceType: type });
    const classification = classifyEvent(text);

    let source;
    let graphDelta;
    let impact;
    let alertsCreated = [];

    if (classification && !this.mutation) {
      this.ingestCounter += 1;
      const result = this.applyEvent({
        classification, text, channel: type, actor: body.author_id || 'ingest-operator',
        occurred_at: occurredAt, source_author_id: body.author_id || null,
        external_id: body.external_id || null, origin: 'ingest',
      });
      source = result.source;
      alertsCreated = result.alerts;
      source.title = title;
      source.metadata = { ...source.metadata, metadata: body.metadata || {}, ingest_title: title };
      graphDelta = { nodes_added: [source.id, result.event.fact_ids[0]], edges_added: this.extraEdges.filter((e) => e.source === source.id || e.target === source.id || e.source === result.event.fact_ids[0] || e.target === result.event.fact_ids[0]).map((e) => e.id), revision: this.revision };
      impact = {
        alerts_created: alertsCreated.map(friendlyAlert),
        note: `The text matched event rule "${classification.rule.id}", so a contradiction was propagated through ${result.propagation.assumptions.length} assumption(s) to ${result.propagation.decisions.length} decision(s).`,
        propagation: result.propagation,
      };
    } else {
      this.ingestCounter += 1;
      const sourceId = `SRC-I-${String(this.ingestCounter).padStart(3, '0')}`;
      source = {
        id: sourceId, type, title,
        external_id: body.external_id || `simulated://ingest/${sourceId}`,
        author_id: body.author_id || null,
        author_name: body.author_id ? (this.nodeById.get(body.author_id)?.label || null) : null,
        timestamp: occurredAt, recorded_at: this.base.demo_clock,
        text, excerpt: text.length > 240 ? `${text.slice(0, 237)}...` : text,
        simulated: true,
        entity_ids: extraction.linked_entity_ids.filter((id) => this.nodeById.has(id) && !id.startsWith('FACT-')),
        fact_ids: [],
        metadata: { ...(body.metadata || {}), ingest_title: title },
      };
      this.extraSources.push(source);
      this.addSourceNode(source);
      this.revision += 1;
      graphDelta = { nodes_added: [source.id], edges_added: this.extraEdges.filter((e) => e.source === source.id || e.target === source.id).map((e) => e.id), revision: this.revision };
      impact = {
        alerts_created: [],
        note: classification
          ? 'The text matched a contradiction rule, but the demo event has already been applied at this revision, so no second propagation was run.'
          : 'No contradiction detected for the current graph. Extracted claims are stored for review and are not presented as verified facts.',
      };
    }

    return {
      status: 'ingested',
      source: this.sourceRecord(source.id),
      extraction: { ...extraction, claims: extraction.claims.map((c) => ({ ...c, materialised_fact_id: null })) },
      graph_delta: graphDelta,
      impact,
      revision: this.revision,
    };
  }
}

// ---------------------------------------------------------------------- helpers

function buildAdjacency(edges) {
  const adjacency = new Map();
  for (const e of edges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    if (!adjacency.has(e.target)) adjacency.set(e.target, []);
    adjacency.get(e.source).push({ nodeId: e.target, edge: e });
    adjacency.get(e.target).push({ nodeId: e.source, edge: e });
  }
  return adjacency;
}

function matches(node, q) {
  const needle = String(q).toLowerCase();
  return `${node.label} ${node.summary} ${node.id}`.toLowerCase().includes(needle);
}

function friendlyAlert(alert) {
  return {
    ...clone(alert),
    kind: 'contradiction',
    review_status_label: {
      NEW: 'New', NEEDS_REVIEW: 'Needs review', CONFIRMED_STALE: 'Confirmed stale',
      DISMISSED: 'Dismissed', RESOLVED: 'Resolved',
    }[alert.status] || alert.status,
  };
}
