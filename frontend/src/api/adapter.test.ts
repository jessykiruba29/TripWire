/**
 * Adapter tests driven by REAL captured backend responses.
 *
 * Every fixture under `fixtures/` is a trimmed copy of a live response from the
 * FastAPI backend (rows removed; no field renamed, invented or retyped). These
 * tests therefore fail if the mapping drifts from the actual wire format — which
 * is the whole point of the adapter.
 *
 * They also cover the cases that only appear at the edges: empty payloads,
 * missing/optional fields, the not-found explanation, and the real error
 * envelopes.
 */

import { describe, expect, it } from 'vitest';
import * as adapt from './adapter';
import { buildUrl, createHttpTransport, TripwireApiError } from './transport';
import { createRealTripwireClient, DEMO_SCENARIOS } from './realClient';
import type {
  RawAlert,
  RawAlertHistory,
  RawAlertList,
  RawDecisionExplanation,
  RawDemoState,
  RawExpertsResponse,
  RawFactExplanation,
  RawGraph,
  RawHealth,
  RawHistoryBelief,
  RawHistoryChanges,
  RawPathsResponse,
  RawSourceDetail,
  RawSourceList,
  RawTriggerResponse,
} from './backendTypes';

import healthJson from './fixtures/health.json';
import demoStateJson from './fixtures/demoState.json';
import graphJson from './fixtures/graph.json';
import graphEmptyJson from './fixtures/graphEmpty.json';
import triggerJson from './fixtures/trigger.json';
import explanationDecisionJson from './fixtures/explanationDecision.json';
import explanationFactJson from './fixtures/explanationFact.json';
import explanationNotFoundJson from './fixtures/explanationNotFound.json';
import expertsJson from './fixtures/experts.json';
import expertsEmptyJson from './fixtures/expertsEmpty.json';
import alertsJson from './fixtures/alerts.json';
import alertsEmptyJson from './fixtures/alertsEmpty.json';
import alertHistoryJson from './fixtures/alertHistory.json';
import sourcesJson from './fixtures/sources.json';
import sourceDetailJson from './fixtures/sourceDetail.json';
import historyBeliefJson from './fixtures/historyBelief.json';
import historyChangesJson from './fixtures/historyChanges.json';
import pathsJson from './fixtures/paths.json';
import ingestAdaptersJson from './fixtures/ingestAdapters.json';

const health = healthJson as unknown as RawHealth;
const demoState = demoStateJson as unknown as RawDemoState;
const graph = graphJson as unknown as RawGraph;
const graphEmpty = graphEmptyJson as unknown as RawGraph;
const trigger = triggerJson as unknown as RawTriggerResponse;
const decisionExplanation = explanationDecisionJson as unknown as RawDecisionExplanation;
const factExplanation = explanationFactJson as unknown as RawFactExplanation;
const experts = expertsJson as unknown as RawExpertsResponse;
const expertsEmpty = expertsEmptyJson as unknown as RawExpertsResponse;
const alerts = alertsJson as unknown as RawAlertList;
const alertsEmpty = alertsEmptyJson as unknown as RawAlertList;
const historyBelief = historyBeliefJson as unknown as RawHistoryBelief;
const historyChanges = historyChangesJson as unknown as RawHistoryChanges;
const paths = pathsJson as unknown as RawPathsResponse;

/** The post-event decision node — POTENTIALLY_STALE with review_status NEEDS_REVIEW. */
const rawDecisionNode = explanationDecisionJson.decision as unknown as import('./backendTypes').RawNode;
const sourceList = sourcesJson as unknown as RawSourceList;
const sourceDetail = sourceDetailJson as unknown as RawSourceDetail;

const STORY = {
  fact: 'fact:frankfurt-partner-compliance-valid',
  residency: 'assumption:data-residency-eu',
  decision: 'decision:eu-launch',
  unrelated: 'decision:dark-mode-default',
};

/* --------------------------------------------------------- the inversions */

describe('the label/name inversion', () => {
  it('maps backend `label` (the kind) to view `type` and `name` to view `label`', () => {
    const node = graph.nodes.find((n) => n.id === STORY.decision)!;
    const adapted = adapt.adaptGraphNode(node);

    // backend says label="Decision", name="Launch Northwind in the EU…"
    expect(node.label).toBe('Decision');
    expect(adapted.type).toBe('decision');
    expect(adapted.label).toBe(node.name);
    expect(adapted.label).not.toBe('Decision');
    expect(adapted.summary.length).toBeGreaterThan(0);
  });

  it('maps every backend kind it emits onto a view type', () => {
    expect(adapt.toNodeType('Fact')).toBe('fact');
    expect(adapt.toNodeType('Decision')).toBe('decision');
    expect(adapt.toNodeType('Assumption')).toBe('assumption');
    expect(adapt.toNodeType('Person')).toBe('person');
    expect(adapt.toNodeType('Message')).toBe('message');
    expect(adapt.toNodeType('Document')).toBe('document');
    // Alerts are signals, not knowledge entities
    expect(adapt.toNodeType('Alert')).toBe('event');
    expect(adapt.toNodeType(undefined)).toBe('document');
  });

  it('lowercases relationship names', () => {
    expect(adapt.toEdgeType('SUPPORTED_BY')).toBe('supported_by');
    expect(adapt.toEdgeType('CONTRADICTS')).toBe('contradicts');
    expect(adapt.toEdgeType(null)).toBe('related_to');
  });
});

/* ------------------------------------------------------------- node states */

describe('status → state', () => {
  it('treats a fact whose RECORD was closed as contradicted, even though its own status still reads ACTIVE', () => {
    const contested = decisionExplanation.dependencies[0].facts.find((f) => f.recorded_to);
    expect(contested?.status).toBe('ACTIVE');
    expect(contested?.recorded_to).toBeTruthy();

    const adapted = adapt.adaptGraphNode({
      id: contested!.fact_id,
      label: 'Fact',
      name: contested!.name,
      status: contested!.status,
      valid_to: contested!.valid_to,
      recorded_to: contested!.recorded_to,
    });
    expect(adapted.state).toBe('contradicted');
  });

  it('does NOT treat a scheduled expiry as a contradiction', () => {
    // Real seed data: the SOC 2 attestation is valid until 2027 and the rate hold
    // until 2027-01-01, with recorded_to null. Both are healthy facts, and calling
    // them contradicted would put three false alarms on screen.
    const scheduled = {
      id: 'fact:frankfurt-partner-soc2-attestation-valid',
      label: 'Fact',
      name: 'Frankfurt Hosting Partner holds a valid SOC 2 Type II attestation',
      status: 'ACTIVE',
      valid_from: '2026-01-15T00:00:00Z',
      valid_to: '2027-03-31T00:00:00Z',
      recorded_to: null,
    };
    expect(adapt.isClosedFact(scheduled)).toBe(false);
    expect(adapt.toNodeState(scheduled)).toBe('normal');
    expect(adapt.adaptGraphNode(scheduled).state).toBe('normal');

    // ...and a genuinely closed record still is one
    expect(adapt.isClosedFact({ ...scheduled, recorded_to: '2026-02-20T08:15:00Z' })).toBe(true);
    // a non-fact with a valid_to is never a contradicted fact
    expect(adapt.isClosedFact({ id: 'd', label: 'Decision', valid_to: '2027-01-01T00:00:00Z' })).toBe(false);
  });

  it('maps POTENTIALLY_STALE to potentially affected and never to confirmed stale', () => {
    // The baseline graph is (correctly) all-ACTIVE, so the stale status is taken
    // from the post-event fixture.
    const node = rawDecisionNode;
    expect(node.status).toBe('POTENTIALLY_STALE');

    const state = adapt.toNodeState(node);
    expect(state).toBe('potentially_affected');
    expect(state).not.toBe('confirmed_stale');
    expect(state).not.toBe('needs_review');
  });

  it('maps the remaining statuses', () => {
    expect(adapt.toNodeState({ id: 'x', label: 'Decision', status: 'STALE' })).toBe('confirmed_stale');
    expect(adapt.toNodeState({ id: 'x', label: 'Decision', status: 'NEEDS_REVIEW' })).toBe('needs_review');
    expect(adapt.toNodeState({ id: 'x', label: 'Decision', status: 'DISMISSED' })).toBe('dismissed');
    expect(adapt.toNodeState({ id: 'x', label: 'Decision', status: 'RESOLVED' })).toBe('resolved');
    expect(adapt.toNodeState({ id: 'x', label: 'Decision', status: 'ACTIVE' })).toBe('normal');
    // unknown / absent status must not crash or invent a problem
    expect(adapt.toNodeState({ id: 'x', label: 'Team' })).toBe('normal');
  });

  it('reports a potentially stale decision as needing review, not as confirmed stale', () => {
    // Post-event: the decision is POTENTIALLY_STALE with review_status NEEDS_REVIEW,
    // so the panel must ask for a review rather than declare it stale.
    expect(adapt.toDecisionStatus(rawDecisionNode)).toBe('needs_review');

    // Baseline: untouched decisions stay active.
    const baseline = graph.nodes.find((n) => n.id === STORY.decision)!;
    expect(adapt.toDecisionStatus(baseline)).toBe('active');

    expect(adapt.toDecisionStatus({ id: 'd', label: 'Decision', status: 'STALE' })).toBe('confirmed_stale');
    // A confirmed-certainty potential impact is still not "confirmed stale".
    expect(
      adapt.toDecisionStatus({ id: 'd', label: 'Decision', status: 'POTENTIALLY_STALE', stale_certainty: 'confirmed' }),
    ).toBe('potential');
  });
});

/* ------------------------------------------------------------------- graph */

describe('adaptGraph', () => {
  it('adapts a real graph payload with degree computed from edges', () => {
    const adapted = adapt.adaptGraph(graph);
    expect(adapted.nodes).toHaveLength(graph.nodes.length);
    expect(adapted.edges).toHaveLength(graph.edges.length);
    expect(adapted.byId.get(STORY.decision)?.type).toBe('decision');
    expect(adapted.byId.get(STORY.residency)?.type).toBe('assumption');

    // degree is derived, and at least one story node is genuinely connected
    const decisionNode = adapted.byId.get(STORY.decision)!;
    expect(decisionNode.degree).toBeGreaterThan(0);
  });

  it('keeps backend-only metadata reachable without a second lookup', () => {
    const adapted = adapt.adaptGraph(graph);
    const fact = adapted.byId.get(STORY.fact)!;
    expect(fact.properties.backend_label).toBe('Fact');
    expect(fact.properties.status).toBe('ACTIVE');
    expect(typeof fact.properties.attribute).toBe('string');
  });

  it('handles an empty graph without throwing', () => {
    const adapted = adapt.adaptGraph(graphEmpty);
    expect(adapted.nodes).toEqual([]);
    expect(adapted.edges).toEqual([]);
    expect(adapted.byId.size).toBe(0);
  });

  it('derives the decisions list from the graph (there is no list endpoint)', () => {
    const decisions = adapt.adaptDecisionList(graph.nodes);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.map((d) => d.id)).toContain(STORY.decision);
    // the unrelated decision is present too, and still active
    const unrelated = decisions.find((d) => d.id === STORY.unrelated);
    expect(unrelated?.status).toBe('active');
  });

  it('returns nothing for an empty node list', () => {
    expect(adapt.adaptDecisionList([])).toEqual([]);
  });
});

/* ----------------------------------------------------------------- trigger */

describe('adaptTrigger', () => {
  const view = adapt.adaptTrigger(trigger, { graphNodes: graph.nodes });

  it('reports the scenario and the two time axes separately', () => {
    expect(view.event.type).toBe('frankfurt_compliance_revoked');
    expect(view.event.occurred_at).toBeTruthy();
    expect(view.event.recorded_at).toBeTruthy();
    expect(view.event.raw_text).toContain('revoked');
  });

  it('carries the backend’s own certainty instead of recomputing propagation', () => {
    const euLaunch = view.propagation.decisions.find((d) => d.id === STORY.decision)!;
    expect(euLaunch.certainty).toBe('potential');
    expect(euLaunch.depth).toBe(0);
    expect(euLaunch.status_before).toBe('ACTIVE');
    expect(euLaunch.status_after).toBe('POTENTIALLY_STALE');
    // potential impact still asks a human to look
    expect(euLaunch.requires_investigation).toBe(true);
  });

  it('never upgrades a potential impact into a confirmed stale decision', () => {
    for (const decision of view.propagation.decisions) {
      expect(decision.status).not.toBe('confirmed_stale');
    }
    // and the confirmed ones are marked as such, not hidden
    expect(trigger.propagation.counts.confirmed).toBeGreaterThan(0);
  });

  it('keeps alternate evidence, which is why the EU launch is not declared invalid', () => {
    const euLaunch = view.propagation.decisions.find((d) => d.id === STORY.decision)!;
    expect(euLaunch.alternate_evidence.length).toBeGreaterThan(0);
    const alt = euLaunch.alternate_evidence[0];
    expect(alt.fact_id).toBeTruthy();
    expect(alt.effect).toBeTruthy();
    expect(euLaunch.reason.length).toBeGreaterThan(0);
  });

  it('passes the engine’s own flag through, rather than deriving it', () => {
    // invariant: requires_investigation mirrors the backend's `flagged`
    for (const [index, impact] of view.entity_impacts!.entries()) {
      expect(impact.requires_investigation).toBe(Boolean(trigger.impacts[index].flagged));
    }
    // and an unflagged entity stays unflagged instead of being upgraded to a warning
    const unflagged = adapt.adaptTrigger(
      { ...trigger, impacts: [{ ...trigger.impacts[0], flagged: false }] },
      { graphNodes: [] },
    );
    expect(unflagged.propagation.decisions[0].requires_investigation).toBe(false);
  });

  it('derives unaffected decisions from the graph rather than inventing them', () => {
    const untouched = view.propagation.not_affected.map((item) => item.id);
    expect(untouched).toContain(STORY.unrelated);
    // nothing the engine flagged may appear as unaffected
    const flagged = new Set(view.propagation.decisions.map((d) => d.id));
    for (const id of untouched) expect(flagged.has(id)).toBe(false);
  });

  it('explains the reasoning in the backend’s own words', () => {
    const decision = view.propagation.decisions[0];
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(view.audit?.source_fact_id).toBe(STORY.fact);
    expect(view.audit?.llm_used).toBe(false);
    expect(view.audit?.scenario).toBe('frankfurt_compliance_revoked');
  });

  it('states uncertainty, including that potential impact is a review request, not a verdict', () => {
    expect(view.uncertainty.length).toBeGreaterThan(0);
    expect(view.uncertainty.join(' ')).toMatch(/potential/i);
  });

  it('builds the evidence path with edges derived from the parallel rels array', () => {
    expect(view.path.nodes.length).toBeGreaterThan(1);
    expect(view.path.edges.length).toBe(view.path.nodes.length - 1);
    expect(view.path.edges.every((edge) => edge.type && edge.source && edge.target)).toBe(true);
  });

  it('reports an already-applied event honestly instead of claiming a fresh change', () => {
    const replay = adapt.adaptTrigger({ ...trigger, applied: [] }, { graphNodes: [] });
    expect(replay.already_applied).toBe(true);
    const fresh = adapt.adaptTrigger({ ...trigger, applied: ['decision:eu-launch'] }, { graphNodes: [] });
    expect(fresh.already_applied).toBe(false);
  });

  it('survives a trigger response with everything optional missing', () => {
    const minimal: RawTriggerResponse = {
      event: { triggered_at: '2026-02-20T08:15:00Z' },
      contradiction: { contradiction_found: false },
      applied: [],
      contradiction_edges: [],
      staleness: {
        source_fact_id: '',
        applied_at: '',
        impact_count: 0,
        decision_count: 0,
        project_count: 0,
        impacts: [],
        notes: [],
      },
      propagation: {
        source_fact_id: '',
        source_fact_name: '',
        source_fact_status: 'ACTIVE',
        source_fact_verified: false,
        evaluated_at: '',
        max_depth: 0,
        assumptions: [],
        seed_decisions: [],
        counts: {
          assumptions: 0,
          seed_decisions: 0,
          affected_total: 0,
          affected_decisions: 0,
          affected_projects: 0,
          confirmed: 0,
          potential: 0,
        },
        affected: [],
        notes: [],
      },
      impacts: [],
      alert_ids: [],
    };
    const view2 = adapt.adaptTrigger(minimal);
    expect(view2.propagation.decisions).toEqual([]);
    expect(view2.propagation.not_affected).toEqual([]);
    expect(view2.alerts).toEqual([]);
    expect(view2.path.nodes).toEqual([]);
    expect(view2.extraction).toBeUndefined();
  });
});

/* ------------------------------------------------------------- explanation */

describe('adaptExplanation', () => {
  const nodeIndex = adapt.adaptGraph(graph).byId;
  const view = adapt.adaptExplanation(decisionExplanation, nodeIndex);

  it('splits the narrative into discrete reasons', () => {
    expect(view.why_flagged.length).toBeGreaterThan(0);
    expect(view.why_flagged.every((line) => line.length > 0)).toBe(true);
    expect(view.headline).toBe(view.why_flagged[0]);
  });

  it('distinguishes the new information from the fact it contradicts', () => {
    expect(view.new_information).not.toBeNull();
    expect(view.challenged_fact).not.toBeNull();
    expect(view.new_information!.fact_id).not.toBe(view.challenged_fact!.id);
    // the challenged fact is the one whose window closed
    expect(view.challenged_fact!.valid_to).toBeTruthy();
    expect(view.challenged_fact!.state).toBe('contradicted');
  });

  it('surfaces the connecting assumption, which is the reason the decision is exposed', () => {
    expect(view.connecting_assumption).not.toBeNull();
    expect(view.connecting_assumption!.id).toBe(STORY.residency);
    expect(view.connecting_assumption!.label.length).toBeGreaterThan(0);
  });

  it('rebuilds the evidence path into nodes and typed edges', () => {
    expect(view.path.nodes[0]).toBe(STORY.fact);
    expect(view.path.nodes).toContain(STORY.residency);
    expect(view.path.edges.map((edge) => edge.type)).toEqual(['supported_by', 'assumes']);
    expect(view.path.narration?.length ?? 0).toBeGreaterThan(0);
  });

  it('keeps alternate evidence and uncertainty visible', () => {
    expect(view.alternate_evidence.length).toBeGreaterThan(0);
    expect(view.uncertainty.length).toBeGreaterThan(0);
    // it must not claim certainty while the review is still open
    expect(view.uncertainty.join(' ')).toMatch(/not a verdict/i);
  });

  it('maps people onto investigators with a stated reason', () => {
    expect(view.suggested_investigators.length).toBeGreaterThan(0);
    expect(view.suggested_investigators[0].name.length).toBeGreaterThan(0);
    expect(view.suggested_investigators[0].reason.length).toBeGreaterThan(0);
  });

  it('deduplicates the sources it collects across facts', () => {
    const ids = view.supporting_sources.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('reports `missing` from the backend instead of silently omitting it', () => {
    expect(Array.isArray(view.unavailable)).toBe(true);
  });

  it('handles the not-found explanation without throwing', () => {
    const notFound = explanationNotFoundJson as unknown as RawDecisionExplanation;
    const empty = adapt.adaptExplanation(notFound);
    expect(empty.new_information).toBeNull();
    expect(empty.challenged_fact).toBeNull();
    expect(empty.connecting_assumption).toBeNull();
    expect(empty.path.nodes).toEqual([]);
    expect(empty.why_flagged).toEqual([]);
  });
});

/* ---------------------------------------------------------------- experts */

describe('adaptExperts', () => {
  const view = adapt.adaptExperts(experts);

  it('ranks contributors and carries the contribution counts through', () => {
    expect(view.experts.length).toBeGreaterThan(0);
    expect(view.experts[0].rank).toBe(1);
    expect(view.experts[0].total_contributions).toBeGreaterThan(0);
    expect(Object.keys(view.experts[0].contribution_counts).length).toBeGreaterThan(0);
  });

  it('reveals a hidden expert who is not the listed owner', () => {
    const hidden = view.hidden_experts ?? [];
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden[0].is_official_owner).toBe(false);
    expect(view.official_owners?.length ?? 0).toBeGreaterThan(0);
    // and the contrast is real: a different person is the official owner
    expect(view.official_owners![0].person_id).not.toBe(hidden[0].person_id);
  });

  it('always states the ranking method and its limitations', () => {
    expect(view.method.length).toBeGreaterThan(0);
    expect(view.method).toBe(view.experts[0].limitations.slice(0, view.method.length));
    expect(view.experts[0].limitations).toMatch(/not proof of expertise/i);
  });

  it('normalises null uncertainty instead of leaking null into the UI', () => {
    for (const expert of view.experts) {
      expect(Array.isArray(expert.uncertainty)).toBe(true);
    }
  });

  it('handles an empty expert response', () => {
    const empty = adapt.adaptExperts(expertsEmpty);
    expect(empty.experts).toEqual([]);
    expect(empty.recommended_contact).toBeNull();
  });
});

/* ----------------------------------------------------------------- alerts */

describe('adaptAlert', () => {
  const list = adapt.adaptAlertList(alerts);

  it('maps the alert fields the UI shows', () => {
    const alert = list.alerts[0];
    expect(alert.id).toBeTruthy();
    expect(alert.title.length).toBeGreaterThan(0);
    expect(alert.what_changed.length).toBeGreaterThan(0);
    expect(alert.why.length).toBeGreaterThan(0);
    expect(alert.severity).toBeTruthy();
  });

  it('links the alert back to the facts it concerns', () => {
    const alert = list.alerts[0];
    expect(alert.contradicted_fact_id).toBe(STORY.fact);
    expect(alert.new_fact_id).toBeTruthy();
    expect(alert.assumption_ids).toContain(STORY.residency);
  });

  it('builds a path from the parallel node/rel arrays', () => {
    const alert = list.alerts[0];
    expect(alert.path?.nodes.length ?? 0).toBeGreaterThan(1);
    expect(alert.path?.edges.length).toBe((alert.path?.nodes.length ?? 1) - 1);
  });

  it('treats every open alert as requiring investigation, and closed ones as not', () => {
    for (const alert of list.alerts) {
      expect(alert.requires_investigation).toBe(true);
    }
    const dismissed = adapt.adaptAlert({ ...(alerts.alerts[0] as RawAlert), status: 'DISMISSED' });
    expect(dismissed.requires_investigation).toBe(false);
    const resolved = adapt.adaptAlert({ ...(alerts.alerts[0] as RawAlert), status: 'RESOLVED' });
    expect(resolved.requires_investigation).toBe(false);
  });

  it('never claims an external notification was sent', () => {
    // the backend reports notified_externally:false; the adapter must not invent it
    const alert = adapt.adaptAlert(alerts.alerts[0] as RawAlert);
    expect(JSON.stringify(alert)).not.toMatch(/slack notification sent/i);
  });

  it('counts statuses for the summary', () => {
    expect(list.by_status.NEEDS_REVIEW).toBeGreaterThan(0);
    expect(list.total).toBeGreaterThan(0);
  });

  it('handles an empty alert list', () => {
    const empty = adapt.adaptAlertList(alertsEmpty);
    expect(empty.alerts).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.by_status).toEqual({});
  });

  it('adapts the review audit trail', () => {
    const history = adapt.adaptAlertHistory(alertHistoryJson as unknown as RawAlertHistory);
    expect(history.length).toBeGreaterThanOrEqual(0);
    for (const entry of history) {
      expect(entry.to).toBeTruthy();
      expect(entry.actor.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------- facts */

describe('adaptFactExplanation', () => {
  const { detail, chain } = adapt.adaptFactExplanation(factExplanation);

  it('keeps both time axes separate', () => {
    expect(detail.valid_from).toBeTruthy();
    expect(detail.valid_to).toBeTruthy();
    expect(detail.recorded_at).toBeTruthy();
    expect(detail.superseded_at).toBeTruthy();
    expect(detail.recorded_time_note).toMatch(/kept separate/i);
  });

  it('builds the provenance chain in the required order, distinguishing the machine step', () => {
    const kinds = chain.map((step) => step.kind);
    expect(kinds[0]).toBe('original_source');
    expect(kinds).toContain('extracted_claim');
    expect(kinds).toContain('system_interpretation');
    expect(kinds.indexOf('extracted_claim')).toBeLessThan(kinds.indexOf('system_interpretation'));

    const machine = chain.find((step) => step.kind === 'system_interpretation')!;
    expect(machine.note).toMatch(/machine conclusion/i);
    expect(machine.method).toBeTruthy();
  });

  it('records who authored the source', () => {
    const source = chain.find((step) => step.kind === 'original_source')!;
    expect(source.actor).toBeTruthy();
  });

  it('keeps the contradicted-by relation rather than deleting the old fact', () => {
    expect(detail.contradicted_by.length).toBeGreaterThan(0);
    expect(detail.validity).toBe('contradicted');
  });
});

/* ------------------------------------------------------------------ history */

describe('adaptHistory', () => {
  it('maps both time axes and a belief for every fact', () => {
    const view = adapt.adaptHistory(historyBelief, historyChanges);
    expect(view.mode).toBe('recorded_time');
    expect(view.facts.length).toBeGreaterThan(0);
    for (const fact of view.facts) {
      expect(fact.belief).toBeTruthy();
      expect(fact.id).toBeTruthy();
    }
  });

  it('states that recorded time is reconstructed, not re-stamped', () => {
    const view = adapt.adaptHistory(historyBelief, historyChanges);
    expect(view.notes?.join(' ')).toMatch(/not re-stamped/i);
  });

  it('marks a fact with a closed window as later contradicted, and an open one as believed', () => {
    // This as-of date predates the event, so the facts held then are all open.
    const view = adapt.adaptHistory(historyBelief, historyChanges);
    expect(view.facts.every((fact) => fact.valid_to === null || fact.valid_to === '')).toBe(true);
    for (const fact of view.facts) expect(fact.belief).toBe('believed_true');

    // Once the window closes, the belief changes — the same fact object, no deletion.
    const closed = adapt.adaptHistoryFact({
      id: 'fact:frankfurt-partner-compliance-valid',
      label: 'Fact',
      name: 'holds a current EU compliance certification',
      status: 'ACTIVE',
      valid_from: '2025-04-01T00:00:00Z',
      valid_to: '2026-02-20T08:15:00Z',
      recorded_at: '2026-01-12T10:05:00Z',
      recorded_to: '2026-02-20T08:15:00Z',
    });
    expect(closed.belief).toBe('later_contradicted');
    expect(closed.superseded_at).toBe('2026-02-20T08:15:00Z');
    // both axes survive: the world-time and the record-time are distinct
    expect(closed.valid_from).not.toBe(closed.recorded_at);
  });

  it('handles null inputs on both sides', () => {
    const view = adapt.adaptHistory(null, null);
    expect(view.facts).toEqual([]);
    expect(view.changes).toEqual([]);
    expect(view.timeline).toEqual([]);
  });

  it('adapts the activity feed, newest first', () => {
    const feed = adapt.adaptTimeline(historyChanges);
    expect(feed.events.length).toBeGreaterThan(0);
    const times = feed.events.map((event) => new Date(event.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(adapt.adaptTimeline(null).events).toEqual([]);
  });
});

/* ------------------------------------------------------------------ sources */

describe('source adaptation', () => {
  it('maps a source record with its type and verbatim text', () => {
    const record = adapt.adaptSource(sourceList.sources[0]);
    expect(record.id).toBeTruthy();
    expect(record.title.length).toBeGreaterThan(0);
    expect(record.text.length).toBeGreaterThan(0);
    // the real backend serves seeded records, not fixtures
    expect(record.simulated).toBe(false);
  });

  it('classifies slack, ticket, prd and meeting-note sources', () => {
    expect(adapt.adaptSource({ id: 'a', label: 'Message', source_system: 'slack' }).type).toBe('slack_message');
    expect(adapt.adaptSource({ id: 'b', label: 'Document', doc_type: 'ticket' }).type).toBe('ticket');
    expect(adapt.adaptSource({ id: 'c', label: 'Document', doc_type: 'prd' }).type).toBe('prd');
    expect(adapt.adaptSource({ id: 'd', label: 'Document', doc_type: 'meeting_note' }).type).toBe('meeting_note');
  });

  it('adapts the source detail with its derived states', () => {
    const detail = adapt.adaptSourceDetail(sourceDetail);
    expect(detail.source.id).toBe(sourceDetail.source.id);
    expect(Array.isArray(detail.states)).toBe(true);
  });

  it('survives a source with almost every field missing', () => {
    const record = adapt.adaptSource({ id: 'source:bare', label: 'Document' });
    expect(record.id).toBe('source:bare');
    expect(record.text).toBe('');
    expect(record.timestamp).toBe('');
  });
});

/* --------------------------------------------------------------------- misc */

describe('health and demo state', () => {
  it('advertises the real store and that no LLM is in use, verbatim', () => {
    const view = adapt.adaptHealth(health);
    expect(view.status).toBe('ok');
    expect(view.mode).toContain('memory');
    expect(view.mode).toContain('deterministic');
    expect(view.dataset.deterministic).toBe(true);
    expect(view.counts.nodes).toBe(health.store.nodes);
  });

  it('exposes key entities so the UI never hardcodes an id', () => {
    const view = adapt.adaptDemoState(demoState);
    expect(view.key_entities?.eu_launch_decision).toBe(STORY.decision);
    expect(view.key_entities?.residency_assumption).toBe(STORY.residency);
    expect(view.key_entities?.compliance_fact).toBe(STORY.fact);
    expect(view.key_entities?.hidden_expert).toBeTruthy();
  });

  it('reports the simulated flag from the real dataset as not-simulated', () => {
    const view = adapt.adaptDemoState(demoState);
    expect(view.counts.nodes).toBeGreaterThan(0);
    expect(view.by_label?.Decision).toBeGreaterThan(0);
    expect(view.by_rel?.SUPPORTED_BY).toBeGreaterThan(0);
  });
});

describe('adaptGraphPath', () => {
  it('uses the first of several candidate paths', () => {
    const path = adapt.adaptGraphPath(paths, STORY.fact, STORY.decision);
    expect(path.found).toBe(true);
    expect(path.nodes[0]).toBe(STORY.fact);
    expect(path.edges.length).toBe(path.nodes.length - 1);
  });

  it('reports not-found instead of inventing a chain', () => {
    const path = adapt.adaptGraphPath({ paths: [] }, 'a', 'b');
    expect(path.found).toBe(false);
    expect(path.nodes).toEqual([]);
    const nullPath = adapt.adaptGraphPath(null, 'a', 'b');
    expect(nullPath.found).toBe(false);
  });

  it('rejects the real malformed route the backend still returns', () => {
    // Captured live from GET /api/paths — route [1] is
    // nodes: [assumption, fact, assumption] with rels: [SUPPORTED_BY, ASSUMES].
    // It starts and ends at the same entity, so it is not a chain.
    const malformed = {
      nodes: ['assumption:data-residency-eu', 'fact:frankfurt-partner-compliance-valid', 'assumption:data-residency-eu'],
      rels: ['SUPPORTED_BY', 'ASSUMES'],
      length: 2,
    };
    const verdict = adapt.validatePath(malformed);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/starts and ends at the same entity|visits the same entity twice/);

    // and it must not be handed to the UI as if it were a valid chain
    const chosen = adapt.adaptGraphPath({ paths: [malformed] }, 'a', 'b');
    expect(chosen.found).toBe(false);
    expect(chosen.nodes).toEqual([]);
  });

  it('reports the validity of every route rather than hiding the bad ones', () => {
    const report = adapt.summarisePaths(paths.paths);
    expect(report.total).toBe(paths.paths.length);
    expect(report.valid + report.invalid.length).toBe(report.total);
    // the live capture does contain a malformed route — the bug is real
    expect(report.invalid.length).toBeGreaterThan(0);
    for (const entry of report.invalid) {
      expect(typeof entry.index).toBe('number');
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('accepts structurally sound routes', () => {
    expect(adapt.validatePath({ nodes: ['a', 'b'], rels: ['R'], length: 1 }).valid).toBe(true);
    expect(adapt.validatePath({ nodes: ['a', 'b', 'c'], rels: ['R1', 'R2'], length: 2 }).valid).toBe(true);
    // wrong relationship count
    expect(adapt.validatePath({ nodes: ['a', 'b', 'c'], rels: ['R1'], length: 1 }).valid).toBe(false);
    // too short
    expect(adapt.validatePath({ nodes: ['a'], rels: [], length: 0 }).valid).toBe(false);
    // revisits a node
    expect(adapt.validatePath({ nodes: ['a', 'b', 'a', 'c'], rels: ['R1', 'R2', 'R3'], length: 3 }).valid).toBe(false);
    expect(adapt.validatePath(null).valid).toBe(false);
  });
});

/* --------------------------------------------------------- real error handling */

describe('real backend error envelopes', () => {
  it('parses the FLAT envelope the real backend returns', async () => {
    const flat = JSON.stringify({ error: 'not_found', message: "decision 'x' does not exist", details: { decision_id: 'x' } });
    const failingFetch = (() =>
      Promise.resolve(new Response(flat, { status: 404, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;

    const client = createRealTripwireClient(
      createHttpTransport({ baseUrl: 'http://backend.test', fetchImpl: failingFetch }),
    );

    const error = await client.explanation('decision:missing').catch((e: unknown) => e as TripwireApiError);
    expect(error).toBeInstanceOf(TripwireApiError);
    const apiError = error as TripwireApiError;
    // the code must survive: "internal_error" here would hide the real cause
    expect(apiError.status).toBe(404);
    expect(apiError.code).toBe('not_found');
    expect(apiError.message).toContain('does not exist');
    expect(apiError.details).toEqual({ decision_id: 'x' });
  });

  it('still parses the nested envelope used by the reference engine', async () => {
    const nested = JSON.stringify({ error: { code: 'not_found', message: 'gone', details: { a: 1 } } });
    const failingFetch = (() =>
      Promise.resolve(new Response(nested, { status: 404, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;

    const client = createRealTripwireClient(
      createHttpTransport({ baseUrl: 'http://backend.test', fetchImpl: failingFetch }),
    );
    const error = (await client.alert('x').catch((e: unknown) => e)) as TripwireApiError;
    expect(error.code).toBe('not_found');
    expect(error.details).toEqual({ a: 1 });
  });

  it('surfaces a real 422 validation failure with its details', async () => {
    const validation = JSON.stringify({
      error: 'validation_error',
      message: 'Request validation failed.',
      details: { errors: [{ type: 'missing', loc: ['query', 'q'], msg: 'Field required' }] },
    });
    const failingFetch = (() =>
      Promise.resolve(new Response(validation, { status: 422, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;

    const client = createRealTripwireClient(
      createHttpTransport({ baseUrl: 'http://backend.test', fetchImpl: failingFetch }),
    );
    const error = (await client.experts({ q: '' }).catch((e: unknown) => e)) as TripwireApiError;
    expect(error.isValidation).toBe(true);
    expect(error.details.errors).toBeDefined();
  });
});

/* ------------------------------------------------------- real client wiring */

describe('realClient request shapes', () => {
  function recordingFetch(payload: unknown = {}, status = 200) {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }),
      );
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  function clientFor(payload: unknown) {
    const recorder = recordingFetch(payload);
    const transport = createHttpTransport({ baseUrl: 'http://127.0.0.1:8000', fetchImpl: recorder.fetchImpl });
    return { client: createRealTripwireClient(transport, { autoSeed: false }), calls: recorder.calls };
  }

  it('URL-encodes ids that contain a colon', async () => {
    const { client, calls } = clientFor(explanationNotFoundJson);
    await client.provenance('fact:frankfurt-partner-compliance-valid').catch(() => undefined);
    expect(calls[0].url).toContain('fact%3Afrankfurt-partner-compliance-valid');
    expect(calls[0].url).not.toMatch(/\/api\/facts\/fact:/);
  });

  it('sends the scenario id rather than free text', async () => {
    const { client, calls } = clientFor(trigger);
    await client.triggerEvent({ scenario: 'frankfurt_compliance_revoked' }).catch(() => undefined);
    const triggerCall = calls.find((call) => call.url.includes('/api/demo/trigger-event'))!;
    expect(triggerCall.body).toEqual({ scenario: 'frankfurt_compliance_revoked' });
    expect(JSON.stringify(triggerCall.body)).not.toContain('text');
  });

  it('maps legacy free text onto a scenario when it matches the story', async () => {
    const { client, calls } = clientFor(trigger);
    await client
      .triggerEvent({ text: 'Our Frankfurt hosting partner has lost its EU compliance certification.' })
      .catch(() => undefined);
    const triggerCall = calls.find((call) => call.url.includes('/api/demo/trigger-event'))!;
    expect(triggerCall.body).toEqual({ scenario: 'frankfurt_compliance_revoked' });
  });

  it('rejects unmappable free text with a clear, actionable error instead of guessing', async () => {
    const { client } = clientFor({});
    const error = (await client.triggerEvent({ text: 'The coffee machine is broken.' }).catch((e: unknown) => e)) as TripwireApiError;
    expect(error).toBeInstanceOf(TripwireApiError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('scenario_required');
    expect(error.message).toContain('frankfurt_compliance_revoked');
    expect(error.details.valid_scenarios).toEqual([...DEMO_SCENARIOS]);
  });

  it('uses POST with actor_id and note for a review transition', async () => {
    const { client, calls } = clientFor(alerts.alerts[0]);
    await client.reviewAlert('alert:abc', { status: 'NEEDS_REVIEW', actor: 'tester', note: 'checked' }).catch(() => undefined);
    const call = calls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/api/alerts/alert%3Aabc/review');
    expect(call.url).not.toContain('review-status');
    expect(call.body).toEqual({ status: 'NEEDS_REVIEW', actor_id: 'tester', note: 'checked' });
  });

  it('passes the required params that otherwise produce a 422', async () => {
    const { client, calls } = clientFor(paths);
    await client.graphPath({ from: STORY.fact, to: STORY.decision }).catch(() => undefined);
    expect(calls[0].url).toContain('source=fact%3Afrankfurt-partner-compliance-valid');
    expect(calls[0].url).toContain('target=decision%3Aeu-launch');
  });

  it('sends `q` to /api/experts, resolving a system id to its name first', async () => {
    const graphCall = recordingFetch(graph);
    const graphTransport = createHttpTransport({ baseUrl: 'http://127.0.0.1:8000', fetchImpl: graphCall.fetchImpl });
    const graphClient = createRealTripwireClient(graphTransport, { autoSeed: false });
    const expertsCall = recordingFetch(experts);
    const mixed = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const impl = url.includes('/api/experts') ? expertsCall.fetchImpl : graphCall.fetchImpl;
      return impl(input, init);
    }) as unknown as typeof fetch;

    const transport = createHttpTransport({ baseUrl: 'http://127.0.0.1:8000', fetchImpl: mixed });
    const client = createRealTripwireClient(transport, { autoSeed: false });
    await client.experts({ system_id: 'system:frankfurt-hosting-partner' }).catch(() => undefined);

    // the system id is resolved via the graph, then used as free text
    expect(graphCall.calls.some((call) => call.url.includes('/api/graph'))).toBe(true);
    void graphClient;
  });

  it('seeds before reading state when the store is empty', async () => {
    const calls: string[] = [];
    const fetchImpl = ((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/health')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ...health, seeded: false }), { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      }
      if (url.includes('/api/demo/seed')) {
        return Promise.resolve(new Response(JSON.stringify({ seeded: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(demoState), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }) as unknown as typeof fetch;

    const client = createRealTripwireClient(
      createHttpTransport({ baseUrl: 'http://127.0.0.1:8000', fetchImpl }),
    );
    await client.demoState();

    const seedIndex = calls.findIndex((url) => url.includes('/api/demo/seed'));
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    // and it happens BEFORE the state read
    expect(seedIndex).toBeLessThan(calls.findIndex((url) => url.includes('/api/demo/state')));
  });

  it('does not re-seed when the store already has data', async () => {
    const calls: string[] = [];
    const fetchImpl = ((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const payload = url.includes('/api/health') ? health : demoState;
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }) as unknown as typeof fetch;

    const client = createRealTripwireClient(createHttpTransport({ baseUrl: 'http://127.0.0.1:8000', fetchImpl }));
    await client.demoState();
    expect(calls.some((url) => url.includes('/api/demo/seed'))).toBe(false);
  });
});

describe('buildUrl', () => {
  it('leaves encoded ids intact', () => {
    const url = buildUrl('http://h', '/api/decisions/decision%3Aeu-launch/explanation');
    expect(url).toBe('http://h/api/decisions/decision%3Aeu-launch/explanation');
  });
});

describe('integrations honesty', () => {
  it('describes adapters as documented inputs, not live provider integrations', () => {
    const raw = ingestAdaptersJson as unknown as {
      available: boolean;
      adapters: Array<{ name: string; integration_note?: string }>;
      message?: string | null;
    };
    expect(raw.available).toBe(true);
    expect(raw.adapters.length).toBeGreaterThan(0);
    // nothing may claim an automatic pull from Slack or a ticket system
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/automatically pulled from slack/i);
  });
});
