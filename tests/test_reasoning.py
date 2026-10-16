"""Contradiction detection and staleness propagation.

Covers spec S15: *contradiction detection and negative cases*, *staleness
propagation and path correctness*, *multiple assumptions and alternate evidence*,
*cycles, repeated events and duplicate paths*, and *an unrelated decision staying
unaffected*.

The propagation tests build small, fully-controlled graphs so each behaviour -
depth bounds, cycles, alternate evidence, restraint - is asserted deterministically
instead of being inferred from the demo dataset.
"""

from __future__ import annotations

from typing import Any, Iterable

import pytest

from tripwire.config import Settings
from tripwire.core.contradictions import find_contradictions, polarity
from tripwire.core.engine import GraphEngine
from tripwire.core.models import Edge, Node
from tripwire.core.store import MemoryGraphStore

FACT_VALID = "fact:svc-compliance-valid"
FACT_SOC2 = "fact:svc-soc2-valid"
FACT_OLD_RATE = "fact:svc-rate-2026"
FACT_NEW_RATE = "fact:svc-rate-2027"


def make_engine() -> GraphEngine:
    """A fresh, empty engine over an in-memory store."""
    return GraphEngine(MemoryGraphStore(), settings=Settings(store_backend="memory"))


def add_fact(
    engine: GraphEngine,
    fact_id: str,
    *,
    subject_id: str = "system:svc",
    attribute: str = "compliance_status",
    value: Any = "valid",
    verified: bool = True,
    status: str = "ACTIVE",
    confidence: float = 0.9,
    valid_from: str = "2026-01-01T00:00:00Z",
    valid_to: str | None = None,
    name: str | None = None,
) -> str:
    """Insert a fact node directly (no source artifact needed)."""
    engine.put_node(
        Node(
            id=fact_id,
            label="Fact",
            name=name or f"{subject_id} {attribute} = {value}",
            props={
                "subject_id": subject_id,
                "subject_name": subject_id,
                "attribute": attribute,
                "value": value,
                "statement": name or f"{subject_id} {attribute} = {value}",
                "valid_from": valid_from,
                "valid_to": valid_to,
                "recorded_at": valid_from,
                "confidence": confidence,
                "verified": verified,
                "status": status,
                "review_status": "AUTO_ACCEPTED" if verified else "NEEDS_REVIEW",
            },
        )
    )
    return fact_id


def add_assumption(
    engine: GraphEngine, assumption: str, *, supported_by: Iterable[str], name: str | None = None
) -> str:
    """Insert an assumption supported by the given facts."""
    engine.put_node(
        Node(
            id=assumption,
            label="Assumption",
            name=name or f"assumption {assumption}",
            props={"statement": name or assumption, "status": "ACTIVE"},
        )
    )
    for fact_id in supported_by:
        engine.put_edge(
            Edge(src=assumption, rel="SUPPORTED_BY", dst=fact_id, props={"recorded_at": "2026-02-01T00:00:00Z"})
        )
    return assumption


def add_decision(
    engine: GraphEngine,
    decision: str,
    *,
    assumes: Iterable[str] = (),
    depends_on: Iterable[str] = (),
    impacts: Iterable[str] = (),
    status: str = "ACTIVE",
    name: str | None = None,
) -> str:
    """Insert a decision with its assumption, dependency and impact edges."""
    engine.put_node(
        Node(
            id=decision,
            label="Decision",
            name=name or f"decision {decision}",
            props={"statement": name or decision, "status": status, "review_status": "UNREVIEWED"},
        )
    )
    for assumption in assumes:
        engine.put_edge(Edge(src=decision, rel="ASSUMES", dst=assumption, props={"recorded_at": "2026-02-01T00:00:00Z"}))
    for parent in depends_on:
        engine.put_edge(Edge(src=decision, rel="DEPENDS_ON", dst=parent, props={"recorded_at": "2026-02-01T00:00:00Z"}))
    for project in impacts:
        engine.put_edge(Edge(src=decision, rel="IMPACTS", dst=project, props={"at": "2026-02-01T00:00:00Z"}))
    return decision


def chain_graph(*, alternate: bool = True, unverified: bool = False) -> GraphEngine:
    """Build the controlled propagation graph.

    ``FACT_VALID <- A1 <- D1 <- D2 <- D3`` plus a project impacted by D1, and two
    deliberately unrelated decisions with their own assumption and fact.
    """
    engine = make_engine()
    engine.put_node(Node(id="system:svc", label="System", name="Service"))
    add_fact(
        engine,
        FACT_VALID,
        verified=not unverified,
        status="ACTIVE",
        confidence=0.55 if unverified else 0.95,
    )
    if alternate:
        add_fact(engine, FACT_SOC2, attribute="certification_status", value="soc2_valid")
    # Projects must exist before the IMPACTS edges that point at them.
    engine.put_node(Node(id="project:p1", label="Project", name="P1"))
    engine.put_node(Node(id="project:p2", label="Project", name="P2"))

    add_assumption(engine, "assumption:a1", supported_by=[FACT_VALID, *([FACT_SOC2] if alternate else [])])
    add_decision(engine, "decision:d1", assumes=["assumption:a1"], impacts=["project:p1"])
    add_decision(engine, "decision:d2", depends_on=["decision:d1"])
    add_decision(engine, "decision:d3", depends_on=["decision:d2"], impacts=["project:p2"])

    # Unrelated island: a different assumption supported by a different fact.
    add_fact(engine, "fact:other-valid", subject_id="system:other", attribute="licence_status", value="valid")
    add_assumption(engine, "assumption:other", supported_by=["fact:other-valid"], name="other assumption")
    add_decision(engine, "decision:other", assumes=["assumption:other"], name="unrelated decision")
    return engine


# --------------------------------------------------------------------------- #
# Contradiction detection
# --------------------------------------------------------------------------- #
def test_polarity_lexicon() -> None:
    assert polarity("revoked") == -1
    assert polarity("valid") == 1
    assert polarity("eu-central-1") == 0
    assert polarity(True) == 1 and polarity(False) == -1


def test_conflicting_status_is_a_contradiction() -> None:
    engine = chain_graph()
    engine.put_node(Node(id="system:svc", label="System", name="Service"))
    result = engine.trigger_event(
        {
            "new_fact": {
                "subject": "system:svc",
                "subject_label": "System",
                "attribute": "compliance_status",
                "value": "revoked",
                "statement": "The service compliance status is revoked.",
            }
        }
    )
    contradiction = result["contradiction"]
    assert contradiction["detected"] is True
    primary = contradiction["primary"]
    assert primary["kind"] == "contradiction"
    assert primary["existing_fact_id"] == FACT_VALID
    assert primary["explicit_rule"] == "compliance_revocation"
    assert primary["contradicts"] is True
    assert 0.0 < primary["confidence"] <= 1.0


def test_agreeing_claim_is_additive_not_a_contradiction() -> None:
    engine = chain_graph()
    result = engine.trigger_event(
        {
            "new_fact": {
                "subject": "system:svc",
                "subject_label": "System",
                "attribute": "compliance_status",
                "value": "valid",
                "statement": "The service compliance status is still valid.",
            }
        }
    )
    assert result["contradiction"]["detected"] is False
    assert result["impacts"] == []
    assert result["contradiction"]["summary"]["contradiction"] == 0


def test_different_attribute_is_new_information() -> None:
    engine = chain_graph()
    result = engine.trigger_event(
        {
            "new_fact": {
                "subject": "system:svc",
                "subject_label": "System",
                "attribute": "runbook_url",
                "value": "https://wiki/svc",
                "statement": "A runbook URL was recorded for the service.",
            }
        }
    )
    assert result["contradiction"]["detected"] is False
    kinds = result["contradiction"]["summary"]
    assert kinds.get("additive", 0) >= 1
    assert kinds.get("contradiction", 0) == 0


def test_a_later_period_is_succession_not_contradiction() -> None:
    engine = make_engine()
    engine.put_node(Node(id="system:svc", label="System", name="Service"))
    add_fact(
        engine,
        FACT_OLD_RATE,
        attribute="pricing",
        value="rate_2026",
        valid_from="2026-01-01T00:00:00Z",
        valid_to="2027-01-01T00:00:00Z",
    )
    result = engine.trigger_event(
        {
            "new_fact": {
                "subject": "system:svc",
                "subject_label": "System",
                "attribute": "pricing",
                "value": "rate_2027",
                "statement": "The contracted rate is renewed for 2027.",
                "valid_from": "2027-01-01T00:00:00Z",
            }
        }
    )
    assert result["contradiction"]["detected"] is False
    assert result["contradiction"]["summary"]["temporal"] >= 1
    # The negotiated successor is still recorded as knowledge.
    assert engine.store.get_node(result["assertion"]["fact_id"]) is not None


def test_unverified_claim_conflicts_but_is_not_accepted() -> None:
    engine = chain_graph()
    result = engine.trigger_event(
        {
            "new_fact": {
                "subject": "system:svc",
                "subject_label": "System",
                "attribute": "compliance_status",
                "value": "revoked",
                "statement": "An unverified post claims the status is revoked.",
                "verified": False,
                "confidence": 0.3,
            }
        }
    )
    primary = result["contradiction"]["primary"]
    assert primary["kind"] == "unverified"
    assert primary["contradicts"] is True
    edge = engine.store.get_edges(src=result["assertion"]["fact_id"], rel="CONTRADICTS")[0]
    assert edge.props["status"] == "UNVERIFIED"
    assert edge.props["verified"] is False
    # The original belief is contested, never silently invalidated.
    original = engine.store.get_node(FACT_VALID)
    assert original.props["status"] == "CONTESTED"
    assert original.props.get("recorded_to") is None
    assert original.props.get("valid_to") is None


def test_prior_inconsistency_is_reported_as_ambiguous() -> None:
    engine = make_engine()
    engine.put_node(Node(id="system:svc", label="System", name="Service"))
    add_fact(engine, "fact:region-a", attribute="hosting_region", value="eu-central-1")
    add_fact(engine, "fact:region-b", attribute="hosting_region", value="us-east-1")
    result = engine.trigger_event(
        {
            "new_fact": {
                "subject": "system:svc",
                "subject_label": "System",
                "attribute": "hosting_region",
                "value": "eu-west-1",
                "statement": "A third region claim was made.",
            }
        }
    )
    assert result["contradiction"]["detected"] is False
    assert result["contradiction"]["summary"]["ambiguous"] >= 1
    assert result["impacts"] == []


def test_claim_about_unknown_subject_is_unrelated() -> None:
    """An opposing value about a *different* subject must never be a contradiction."""
    engine = chain_graph()
    result = engine.trigger_event(
        {
            "new_fact": {
                "subject": "System With No History",
                "subject_label": "System",
                "attribute": "compliance_status",
                "value": "revoked",
                "statement": "Nothing is known about this subject; its status is revoked.",
            }
        }
    )
    assert result["contradiction"]["detected"] is False
    # The candidate matched on attribute alone (a different subject), so it is
    # classified unrelated rather than conflicting.
    assert result["contradiction"]["summary"]["unrelated"] >= 1
    assert result["contradiction"]["summary"]["contradiction"] == 0
    assert result["impacts"] == []


def test_hypothetical_candidate_does_not_write_anything() -> None:
    """``find_contradictions`` can answer "would this conflict?" without persisting."""
    engine = chain_graph()
    before = (engine.store.node_count(), engine.store.edge_count())
    verdict = engine.find_contradictions(
        candidate={
            "subject": "system:svc",
            "attribute": "compliance_status",
            "value": "revoked",
            "statement": "Hypothetical revocation.",
        }
    )
    after = (engine.store.node_count(), engine.store.edge_count())
    assert verdict["contradiction_found"] is True
    assert before == after, "a hypothetical comparison must not write to the graph"


def test_find_contradictions_on_a_missing_fact_raises_not_found() -> None:
    from tripwire.core.errors import NotFoundError

    engine = chain_graph()
    with pytest.raises(NotFoundError):
        engine.find_contradictions(fact_id="fact:does-not-exist")


# --------------------------------------------------------------------------- #
# Staleness propagation
# --------------------------------------------------------------------------- #
def test_propagation_reaches_direct_and_transitive_decisions_and_projects() -> None:
    engine = chain_graph()
    plan = engine.plan_staleness(FACT_VALID)

    affected = {entity.entity_id: entity for entity in plan.affected}
    assert set(affected) == {
        "decision:d1",
        "decision:d2",
        "decision:d3",
        "project:p1",
        "project:p2",
    }
    assert affected["decision:d1"].depth == 0
    assert affected["decision:d2"].depth == 1
    assert affected["decision:d3"].depth == 2
    assert affected["project:p1"].entity_label == "Project"
    # The contributing assumption is recorded, so an explanation can name it.
    assert "assumption:a1" in affected["decision:d1"].contributing_assumptions


def test_propagation_depth_is_bounded() -> None:
    engine = chain_graph()
    plan = engine.plan_staleness(FACT_VALID, max_depth=1)
    assert {entity.entity_id for entity in plan.affected} >= {"decision:d1", "decision:d2"}
    assert "decision:d3" not in {entity.entity_id for entity in plan.affected}


def test_propagation_handles_cycles_without_duplicate_entries() -> None:
    engine = chain_graph()
    # Close the chain into a cycle: d2 -> d3 -> d2.
    engine.put_edge(Edge(src="decision:d2", rel="DEPENDS_ON", dst="decision:d3", props={"recorded_at": "2026-02-01T00:00:00Z"}))

    plan = engine.plan_staleness(FACT_VALID, max_depth=5)
    ids = [entity.entity_id for entity in plan.affected]
    assert len(ids) == len(set(ids)), f"each entity must appear once, got {ids}"
    assert set(ids) == {"decision:d1", "decision:d2", "decision:d3", "project:p1", "project:p2"}


def test_multiple_assumptions_yield_one_entry_per_entity_with_multiple_paths() -> None:
    engine = chain_graph()
    add_assumption(engine, "assumption:a1b", supported_by=[FACT_VALID])
    engine.put_edge(Edge(src="decision:d1", rel="ASSUMES", dst="assumption:a1b", props={"recorded_at": "2026-02-01T00:00:00Z"}))

    plan = engine.plan_staleness(FACT_VALID)
    d1 = [entity for entity in plan.affected if entity.entity_id == "decision:d1"]
    assert len(d1) == 1, "the same decision must not be reported twice"
    assert set(d1[0].contributing_assumptions) == {"assumption:a1", "assumption:a1b"}
    assert len(d1[0].paths) >= 2, "each supporting assumption should yield its own path"


def test_paths_are_built_from_real_edges() -> None:
    engine = chain_graph()
    plan = engine.plan_staleness(FACT_VALID)
    d2 = next(entity for entity in plan.affected if entity.entity_id == "decision:d2")
    path = d2.paths[0]

    assert path.node_ids[0] == FACT_VALID, "the path must start at the changed fact"
    assert path.node_ids[-1] == "decision:d2", "the path must end at the affected entity"
    assert path.rels[:3] == ["SUPPORTED_BY", "ASSUMES", "DEPENDS_ON"]
    # Every hop must correspond to an edge that exists in the graph.
    for step in path.steps:
        stored_src = step.props["stored_src"]
        stored_dst = step.props["stored_dst"]
        assert step.props["edge_direction"] in ("forward", "reverse")
        assert engine.store.get_edges(src=stored_src, rel=step.rel, dst=stored_dst), (
            f"fabricated hop {stored_src} -{step.rel}-> {stored_dst}"
        )


def test_paths_are_deduplicated_across_repeated_evaluation() -> None:
    engine = chain_graph()
    first = engine.plan_staleness(FACT_VALID)
    second = engine.plan_staleness(FACT_VALID)
    keys = lambda plan: sorted(  # noqa: E731 - local test helper
        (entity.entity_id, entity.paths[0].key) for entity in plan.affected
    )
    assert keys(first) == keys(second)


def test_unrelated_decisions_are_never_affected() -> None:
    engine = chain_graph()
    plan = engine.plan_staleness(FACT_VALID)
    ids = {entity.entity_id for entity in plan.affected}
    assert "decision:other" not in ids
    assert "assumption:other" not in ids

    engine.trigger_event(
        {
            "new_fact": {
                "subject": "system:svc",
                "subject_label": "System",
                "attribute": "compliance_status",
                "value": "revoked",
                "statement": "Revoked.",
            }
        }
    )
    assert engine.store.get_node("decision:other").props["status"] == "ACTIVE"


def test_no_assumption_means_no_affected_entities() -> None:
    """A fact nothing depends on must not manufacture a dependency chain."""
    engine = make_engine()
    engine.put_node(Node(id="system:svc", label="System", name="Service"))
    add_fact(engine, "fact:orphan", attribute="colour", value="blue")

    plan = engine.plan_staleness("fact:orphan")
    assert plan.affected == []
    assert any("no decision depends on it" in note for note in plan.notes)


def test_missing_fact_is_reported_rather_than_invented() -> None:
    engine = chain_graph()
    plan = engine.plan_staleness("fact:never-existed")
    assert plan.affected == []
    assert any("not present in the graph" in note for note in plan.notes)


# --------------------------------------------------------------------------- #
# Restraint
# --------------------------------------------------------------------------- #
def test_alternate_evidence_keeps_a_decision_potential() -> None:
    engine = chain_graph(alternate=True)
    plan = engine.plan_staleness(FACT_VALID)
    d1 = next(entity for entity in plan.affected if entity.entity_id == "decision:d1")

    assert d1.certainty == "potential"
    assert d1.has_alternate_evidence is True
    assert {evidence.fact_id for evidence in d1.alternate_evidence} == {FACT_SOC2}
    assert "independent evidence" in d1.reason.lower()
    assert d1.status_after == "POTENTIALLY_STALE", "never STALE without a review"


def test_absence_of_alternate_evidence_yields_confirmed_for_review() -> None:
    engine = chain_graph(alternate=False)
    plan = engine.plan_staleness(FACT_VALID)
    d1 = next(entity for entity in plan.affected if entity.entity_id == "decision:d1")
    assert d1.certainty == "confirmed"
    assert d1.alternate_evidence == []


def test_alternate_support_changes_the_review_outcome() -> None:
    """Spec S15: an alternate valid supporting fact must change the review outcome.

    The only difference between the two graphs is whether a second, independent,
    still-valid fact supports the assumption - and that flips the verdict and the
    resulting alert severity.
    """
    without = chain_graph(alternate=False)
    plan_without = without.plan_staleness(FACT_VALID)
    d1_without = next(e for e in plan_without.affected if e.entity_id == "decision:d1")
    applied_without = without.apply_staleness(plan_without, index=without.index())
    alert_without = next(
        i["alert"] for i in applied_without["impacts"] if i["entity_id"] == "decision:d1"
    )

    with_alternate = chain_graph(alternate=True)
    plan_with = with_alternate.plan_staleness(FACT_VALID)
    d1_with = next(e for e in plan_with.affected if e.entity_id == "decision:d1")
    applied_with = with_alternate.apply_staleness(plan_with, index=with_alternate.index())
    alert_with = next(
        i["alert"] for i in applied_with["impacts"] if i["entity_id"] == "decision:d1"
    )

    assert d1_without.certainty == "confirmed"
    assert d1_with.certainty == "potential"
    assert alert_without["certainty"] == "confirmed" and alert_with["certainty"] == "potential"
    assert alert_without["severity"] == "high" and alert_with["severity"] == "medium"
    assert alert_without["confidence"] > alert_with["confidence"], (
        "a decision with surviving independent support must not be reported as strongly"
    )
    assert "Independent supporting evidence exists" in alert_with["summary"]
    assert "No surviving independent support" in alert_without["summary"]
    # The verdict is persisted on the decision, not only returned in the response.
    assert with_alternate.store.get_node("decision:d1").props["stale_certainty"] == "potential"
    assert without.store.get_node("decision:d1").props["stale_certainty"] == "confirmed"


def test_unverified_change_keeps_every_verdict_potential() -> None:
    engine = chain_graph(alternate=False, unverified=True)
    plan = engine.plan_staleness(FACT_VALID)
    assert plan.affected, "the chain is still traversed; only the verdict is softened"
    assert {entity.certainty for entity in plan.affected} == {"potential"}
    assert any("unverified or merely contested" in note for note in plan.notes)


def test_stale_is_never_written_by_propagation() -> None:
    engine = chain_graph(alternate=False)
    engine.trigger_event(
        {
            "new_fact": {
                "subject": "system:svc",
                "subject_label": "System",
                "attribute": "compliance_status",
                "value": "revoked",
                "statement": "Revoked.",
            }
        }
    )
    for decision in engine.store.get_nodes(label="Decision"):
        assert decision.props["status"] != "STALE", (
            "propagation must never invalidate a decision on its own"
        )


def test_propagation_records_why_and_when() -> None:
    engine = chain_graph(alternate=True)
    engine.trigger_event(
        {
            "new_fact": {
                "subject": "system:svc",
                "subject_label": "System",
                "attribute": "compliance_status",
                "value": "revoked",
                "statement": "Revoked.",
            }
        }
    )
    d1 = engine.store.get_node("decision:d1")
    assert d1.props["status"] == "POTENTIALLY_STALE"
    assert d1.props["stale_reason"]
    assert d1.props["stale_since"]
    assert d1.props["stale_cause_fact_id"] == FACT_VALID
    assert d1.props["stale_certainty"] == "potential"
    assert d1.props["stale_alert_ids"], "the alert must be recorded on the decision"

    # A STALED edge records the cause in the graph, not just in the response.
    staled = engine.store.get_edges(src=FACT_VALID, rel="STALED", dst="decision:d1")
    assert staled and staled[0].props["reason"]

    # And a status-change event preserves the previous status and the instant.
    events = [
        event
        for event in engine.store.get_nodes(label="Event", where={"entity_id": "decision:d1"})
        if event.props.get("event_type") == "STATUS_CHANGE"
    ]
    assert events and events[0].props["from_status"] == "ACTIVE"
    assert events[0].props["to_status"] == "POTENTIALLY_STALE"


def test_replaying_the_same_event_converges_without_duplicate_alerts() -> None:
    """Replay is safe: no duplicate alerts, no re-applied statuses, and it converges.

    The first replay legitimately appends one audit event recording that the claim
    was *restated* (the first pass recorded it as newly asserted). That event has a
    stable id, so every subsequent replay changes nothing at all - which is the
    property that matters.
    """
    engine = chain_graph(alternate=False)
    payload = {
        "new_fact": {
            "subject": "system:svc",
            "subject_label": "System",
            "attribute": "compliance_status",
            "value": "revoked",
            "statement": "Revoked.",
        }
    }
    first = engine.trigger_event(payload)
    alerts_after_first = engine.alerts()["total"]
    statuses_after_first = {
        node.id: node.props.get("status") for node in engine.store.get_nodes(label="Decision")
    }
    staleness_edges_after_first = engine.store.edge_count()

    second = engine.trigger_event(payload)
    assert second["contradiction"]["detected"] is True, "a replay still reports the known conflict"
    assert second["contradiction"]["primary"]["already_recorded"] is True
    assert second["applied"] == [], "an already-recorded contradiction is not re-applied"
    assert second["alert_ids"] == first["alert_ids"], "no duplicate alerts"
    assert engine.alerts()["total"] == alerts_after_first, "no duplicate alerts in the feed"
    # No new dependency or CONTRADICTS edges: the only growth is the restatement
    # audit event and its ABOUT edge.
    assert engine.store.edge_count() == staleness_edges_after_first + 1, (
        "the only edge a first replay may add is the restatement event's ABOUT edge"
    )
    assert engine.store.get_edges(rel="CONTRADICTS") and len(
        engine.store.get_edges(rel="CONTRADICTS")
    ) == 1, "the CONTRADICTS edge must not be duplicated"

    counts_after_second = (engine.store.node_count(), engine.store.edge_count())
    third = engine.trigger_event(payload)
    assert (engine.store.node_count(), engine.store.edge_count()) == counts_after_second, (
        "a repeated replay must be a complete no-op"
    )
    assert {
        node.id: node.props.get("status") for node in engine.store.get_nodes(label="Decision")
    } == statuses_after_first, "a replay must not regress or re-apply statuses"


def test_reviewed_outcome_survives_a_replay() -> None:
    """An explicitly reviewed decision must not be dragged back by re-propagation."""
    engine = chain_graph(alternate=False)
    payload = {
        "new_fact": {
            "subject": "system:svc",
            "subject_label": "System",
            "attribute": "compliance_status",
            "value": "revoked",
            "statement": "Revoked.",
        }
    }
    engine.trigger_event(payload)
    engine.set_decision_status("decision:d1", "STALE", confirm=True, note="Reviewed by the owner.")

    engine.trigger_event(payload)
    assert engine.store.get_node("decision:d1").props["status"] == "STALE"


def test_reverted_decision_is_returned_to_active_on_dismissal() -> None:
    engine = chain_graph(alternate=True)
    result = engine.trigger_event(
        {
            "new_fact": {
                "subject": "system:svc",
                "subject_label": "System",
                "attribute": "compliance_status",
                "value": "revoked",
                "statement": "Revoked.",
            }
        }
    )
    alert_id = next(
        impact["alert"]["alert_id"]
        for impact in result["impacts"]
        if impact["entity_id"] == "decision:d1"
    )
    engine.review_alert(alert_id, "DISMISSED", note="Lower confidence than reported.")
    assert engine.store.get_node("decision:d1").props["status"] == "ACTIVE"


def test_contradiction_is_persisted_with_provenance_and_preserves_the_original() -> None:
    engine = chain_graph(alternate=False)
    result = engine.trigger_event(
        {
            "new_fact": {
                "subject": "system:svc",
                "subject_label": "System",
                "attribute": "compliance_status",
                "value": "revoked",
                "statement": "Revoked.",
            },
            "source": {
                "kind": "slack",
                "external_id": "prov-1",
                "channel": "#compliance",
                "author": "Reviewer",
                "timestamp": "2026-03-05T09:00:00Z",
                "text": "The compliance certification has been revoked.",
            },
        }
    )
    old = engine.store.get_node(FACT_VALID)
    new_id = result["assertion"]["fact_id"]
    new = engine.store.get_node(new_id)

    # The original record is preserved, with its belief interval closed.
    assert old is not None
    assert old.props["status"] == "INVALIDATED"
    assert old.props["recorded_to"] is not None
    assert old.props["valid_to"] == new.props["valid_from"]
    assert old.props["invalidated_by"] == new_id

    edges = engine.store.get_edges(src=new_id, rel="CONTRADICTS")
    assert edges and edges[0].dst == FACT_VALID and edges[0].props["status"] == "VERIFIED"
    assert engine.store.get_edges(src=result["assertion"]["source_id"], rel="STATES", dst=new_id)
