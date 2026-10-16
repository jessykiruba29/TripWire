"""Tests for the Tripwire MCP tool layer.

Two levels of testing:

1. **Direct unit tests** of the tool callables (:class:`TripwireTools`) against a
   seeded in-memory engine - fast, no transport, no server.
2. **Protocol tests** over the SDK's in-memory client transport
   (:class:`mcp.client._memory.InMemoryTransport`), which lists tools and calls
   them through the real MCP wire, plus one stdio subprocess test that proves
   ``python -m tripwire.mcp_server`` starts and serves the same tool surface.

The tools must be adapters, so nothing here re-implements graph reasoning: the
assertions are about the *surface* (names, shapes, bounds, structured errors).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest

from tripwire.config import Settings
from tripwire.core.engine import GraphEngine
from tripwire.core.store import MemoryGraphStore
from tripwire.dataset import entities as E
from tripwire.dataset.northwind import COMPLIANCE_FACT_ID, KEY_IDS
from tripwire.mcp_server.server import build_server
from tripwire.mcp_server.tools import CORE_TOOLS, TOOL_NAMES, TripwireTools

REPO_ROOT = Path(__file__).resolve().parents[1]


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
def _build_engine() -> GraphEngine:
    """A seeded, memory-backed engine - the same engine the API would use."""
    engine = GraphEngine(MemoryGraphStore(), settings=Settings(store_backend="memory"))
    engine.seed_demo()
    return engine


@pytest.fixture()
def engine() -> GraphEngine:
    return _build_engine()


@pytest.fixture()
def tools(engine: GraphEngine) -> TripwireTools:
    return TripwireTools(engine)


def _assert_error(payload: dict[str, Any], code: str) -> dict[str, Any]:
    """Assert `payload` is the structured error shape with `code`, return it."""
    assert "error" in payload, payload
    error = payload["error"]
    assert set(error) >= {"code", "message", "details"}, error
    assert error["code"] == code, error
    assert isinstance(error["message"], str) and error["message"]
    return error


def _payload(result: Any) -> dict[str, Any]:
    """Extract a structured payload from a protocol CallToolResult."""
    if getattr(result, "structured_content", None) is not None:
        return result.structured_content
    return json.loads(result.content[0].text)


# --------------------------------------------------------------------------- #
# Declared tool surface
# --------------------------------------------------------------------------- #
def test_required_tools_are_declared() -> None:
    assert set(CORE_TOOLS) <= set(TOOL_NAMES)
    assert set(CORE_TOOLS) == {
        "find_contradictions",
        "propagate_staleness",
        "find_experts",
        "explain_path",
    }
    # The additive tools the spec asks for are all present too.
    for name in (
        "explain_decision",
        "explain_alert",
        "explain_fact",
        "list_alerts",
        "review_alert",
        "graph_summary",
        "search_knowledge",
        "history_query",
        "trigger_demo_event",
    ):
        assert name in TOOL_NAMES


def test_every_declared_tool_is_callable_on_the_bound_object(tools: TripwireTools) -> None:
    for name in TOOL_NAMES:
        assert callable(getattr(tools, name)), name


# --------------------------------------------------------------------------- #
# 1. find_contradictions
# --------------------------------------------------------------------------- #
def test_find_contradictions_hypothetical_candidate_is_read_only(
    tools: TripwireTools, engine: GraphEngine
) -> None:
    before = engine.counts()
    payload = tools.find_contradictions(
        candidate={
            "subject": "Frankfurt Hosting Partner",
            "attribute": "compliance_status",
            "value": "revoked",
        }
    )
    assert "error" not in payload, payload
    for key in ("detected", "contradiction_found", "candidates", "paths", "summary"):
        assert key in payload, payload
    assert payload["detected"] == payload["contradiction_found"]
    assert isinstance(payload["candidates"], list)
    after = engine.counts()
    assert (after["nodes"], after["edges"]) == (before["nodes"], before["edges"])


def test_find_contradictions_existing_fact(tools: TripwireTools) -> None:
    payload = tools.find_contradictions(fact_id=KEY_IDS["soc2_fact"])
    assert "error" not in payload, payload
    assert "detected" in payload and "candidates" in payload


def test_find_contradictions_unknown_fact_is_structured_error(tools: TripwireTools) -> None:
    payload = tools.find_contradictions(fact_id="fact:does-not-exist")
    _assert_error(payload, "not_found")


def test_find_contradictions_requires_input(tools: TripwireTools) -> None:
    _assert_error(tools.find_contradictions(), "validation_error")
    _assert_error(
        tools.find_contradictions(
            fact_id=KEY_IDS["soc2_fact"], candidate={"subject": "a", "attribute": "b", "value": 1}
        ),
        "validation_error",
    )


def test_find_contradictions_candidate_missing_fields(tools: TripwireTools) -> None:
    _assert_error(tools.find_contradictions(candidate={"subject": "x"}), "validation_error")


# --------------------------------------------------------------------------- #
# 2. propagate_staleness
# --------------------------------------------------------------------------- #
def test_propagate_staleness_dry_run_is_non_destructive(
    tools: TripwireTools, engine: GraphEngine
) -> None:
    before = engine.counts()
    payload = tools.propagate_staleness(COMPLIANCE_FACT_ID, max_depth=3)
    assert "error" not in payload, payload
    assert payload["dry_run"] is True
    assert payload["applied"] is False
    assert payload["written"] is None

    plan = payload["plan"]
    assert plan["source_fact_id"] == COMPLIANCE_FACT_ID
    assert plan["counts"]["affected_decisions"] >= 1
    assert plan["counts"]["affected_total"] == len(plan["affected"])
    for affected in plan["affected"]:
        assert affected["certainty"] in ("potential", "confirmed")
        assert "paths" in affected and "alternate_evidence" in affected
        assert affected["reason"]

    after = engine.counts()
    assert after["nodes"] == before["nodes"], "dry_run must not write nodes"
    assert after["edges"] == before["edges"], "dry_run must not write edges"


def test_propagate_staleness_apply_writes_flags(tools: TripwireTools, engine: GraphEngine) -> None:
    before = engine.counts()
    payload = tools.propagate_staleness(COMPLIANCE_FACT_ID, max_depth=3, dry_run=False)
    assert "error" not in payload, payload
    assert payload["dry_run"] is False
    assert payload["written"] is not None
    assert payload["written"]["impact_count"] >= 1
    assert payload["applied"] is True

    after = engine.counts()
    assert after["nodes"] > before["nodes"]

    # Decisions are only ever flagged POTENTIALLY_STALE, never auto-STALE.
    statuses = {
        engine.store.get_node(item["entity_id"]).props.get("status")
        for item in payload["written"]["impacts"]
        if item["entity_label"] == "Decision"
    }
    assert statuses <= {"POTENTIALLY_STALE", None}


def test_propagate_staleness_reports_alternate_evidence(tools: TripwireTools) -> None:
    payload = tools.propagate_staleness(COMPLIANCE_FACT_ID, max_depth=3)
    affected = payload["plan"]["affected"]
    assert affected
    assert any(item["has_alternate_evidence"] for item in affected), (
        "the EU launch decision keeps its independent SOC 2 support"
    )
    assert payload["plan"]["notes"]


def test_propagate_staleness_depth_bounds(tools: TripwireTools) -> None:
    _assert_error(tools.propagate_staleness(COMPLIANCE_FACT_ID, max_depth=9), "validation_error")
    _assert_error(tools.propagate_staleness(COMPLIANCE_FACT_ID, max_depth=-1), "validation_error")


def test_propagate_staleness_unknown_fact_is_honest(tools: TripwireTools) -> None:
    payload = tools.propagate_staleness("fact:not-in-graph", max_depth=2)
    assert "error" not in payload, payload
    assert payload["plan"]["affected"] == []
    assert payload["plan"]["notes"], "the plan must say why nothing propagated"


# --------------------------------------------------------------------------- #
# 3. find_experts
# --------------------------------------------------------------------------- #
def test_find_experts_ranks_people(tools: TripwireTools) -> None:
    payload = tools.find_experts("Frankfurt Hosting Partner", limit=5)
    assert "error" not in payload, payload
    assert payload["experts"], payload
    assert payload["ranked_people"] == payload["experts"]
    assert payload["method"]
    assert "shadow_org_signal" in payload
    assert payload["shadow_org_signal"]["hidden_expert_count"] == len(payload["hidden_experts"])

    top = payload["experts"][0]
    for key in (
        "rank",
        "person_id",
        "person_name",
        "reason",
        "contribution_counts",
        "evidence_refs",
        "is_official_owner",
        "shadow_signal",
    ):
        assert key in top, (key, top)
    assert isinstance(top["contribution_counts"], dict)
    assert payload["official_owners"], "official owners must be reported separately"


def test_find_experts_shows_shadow_signal(tools: TripwireTools) -> None:
    payload = tools.find_experts("Frankfurt Hosting Partner", limit=10)
    assert payload["hidden_experts"], "Jonas Berg contributes without official ownership"
    hidden_names = {person["person_name"] for person in payload["hidden_experts"]}
    assert "Jonas Berg" in hidden_names


def test_find_experts_bounds_and_empty_query(tools: TripwireTools) -> None:
    _assert_error(tools.find_experts("Frankfurt", limit=51), "validation_error")
    _assert_error(tools.find_experts("   "), "validation_error")


# --------------------------------------------------------------------------- #
# 4. explain_path
# --------------------------------------------------------------------------- #
def test_explain_path_finds_a_route(tools: TripwireTools) -> None:
    payload = tools.explain_path(KEY_IDS["eu_launch_decision"], KEY_IDS["frankfurt_partner"])
    assert "error" not in payload, payload
    assert payload["found"] is True
    assert payload["paths"], payload
    assert payload["path_count"] == len(payload["paths"])


def test_explain_path_reports_missing_node_honestly(tools: TripwireTools) -> None:
    payload = tools.explain_path(KEY_IDS["eu_launch_decision"], "person:no-such-person")
    assert payload["found"] is False
    assert payload["paths"] == []
    assert payload["reason"]


def test_explain_path_rejects_unknown_relationship(tools: TripwireTools) -> None:
    _assert_error(
        tools.explain_path(KEY_IDS["eu_launch_decision"], KEY_IDS["frankfurt_partner"], rels=["NOPE"]),
        "validation_error",
    )


# --------------------------------------------------------------------------- #
# 5-7. explain_decision / explain_alert / explain_fact
# --------------------------------------------------------------------------- #
def test_explain_decision(tools: TripwireTools) -> None:
    payload = tools.explain_decision(KEY_IDS["eu_launch_decision"])
    assert "error" not in payload, payload
    assert payload["found"] is True
    assert payload["decision"]["id"] == KEY_IDS["eu_launch_decision"]


def test_explain_decision_missing_is_honest(tools: TripwireTools) -> None:
    payload = tools.explain_decision("decision:nope")
    assert payload["found"] is False
    assert payload["reason"]


def test_explain_fact(tools: TripwireTools) -> None:
    payload = tools.explain_fact(COMPLIANCE_FACT_ID)
    assert "error" not in payload, payload
    assert payload["found"] is True
    assert payload["fact"]["id"] == COMPLIANCE_FACT_ID
    assert payload["provenance"], "a fact must be traceable to its provenance"
    assert "contradictions" in payload and "supporting_assumptions" in payload


def test_explain_alert_needs_a_real_alert(tools: TripwireTools) -> None:
    event = tools.trigger_demo_event(scenario="frankfurt_compliance_revoked")
    assert "error" not in event, event
    assert event["contradiction"]["detected"] is True

    listing = tools.list_alerts()
    assert listing["total"] >= 1
    alert_id = listing["alerts"][0]["id"]

    payload = tools.explain_alert(alert_id)
    assert "error" not in payload, payload
    assert payload["found"] is True
    assert payload["alert"]["id"] == alert_id
    assert payload["alert"]["certainty"] in ("potential", "confirmed")


# --------------------------------------------------------------------------- #
# 8-9. list_alerts / review_alert
# --------------------------------------------------------------------------- #
def test_list_alerts_status_filter_and_histogram(tools: TripwireTools) -> None:
    tools.trigger_demo_event(scenario="frankfurt_compliance_revoked")
    every = tools.list_alerts(limit=50)
    assert "error" not in every, every
    assert {"total", "count", "status_counts", "alerts"} <= set(every)

    status = every["alerts"][0]["status"]
    filtered = tools.list_alerts(status=status, limit=5)
    assert "error" not in filtered, filtered
    assert filtered["total"] >= 1
    assert all(alert["status"] == status for alert in filtered["alerts"])


def test_list_alerts_invalid_status_is_structured_error(tools: TripwireTools) -> None:
    _assert_error(tools.list_alerts(status="BOGUS"), "validation_error")


def test_review_alert_invalid_status_is_structured_error(tools: TripwireTools) -> None:
    tools.trigger_demo_event(scenario="frankfurt_compliance_revoked")
    alert_id = tools.list_alerts()["alerts"][0]["id"]
    _assert_error(tools.review_alert(alert_id, "BOGUS"), "validation_error")


def test_review_alert_valid_transition_and_invalid_transition(tools: TripwireTools) -> None:
    tools.trigger_demo_event(scenario="frankfurt_compliance_revoked")
    alert_id = tools.list_alerts()["alerts"][0]["id"]

    reviewed = tools.review_alert(
        alert_id, "confirmed_stale", actor_id="person:priya-raman", note="Certification confirmed revoked."
    )
    assert "error" not in reviewed, reviewed
    assert reviewed["status"] == "CONFIRMED_STALE"
    assert reviewed["previous_status"] != "CONFIRMED_STALE"

    # No transition table entry leads back to NEW, so this must be rejected.
    _assert_error(tools.review_alert(alert_id, "NEW"), "invalid_transition")


def test_review_alert_unknown_alert_is_structured_error(tools: TripwireTools) -> None:
    _assert_error(tools.review_alert("alert:nope", "NEEDS_REVIEW"), "not_found")


def test_alert_history_is_reachable(tools: TripwireTools) -> None:
    tools.trigger_demo_event(scenario="frankfurt_compliance_revoked")
    alert_id = tools.list_alerts()["alerts"][0]["id"]
    history = tools.engine.alert_history(alert_id)
    assert history["alert_id"] == alert_id


# --------------------------------------------------------------------------- #
# 10-11. graph_summary / search_knowledge
# --------------------------------------------------------------------------- #
def test_graph_summary(tools: TripwireTools) -> None:
    payload = tools.graph_summary()
    assert "error" not in payload, payload
    assert payload["seeded"] is True
    assert payload["counts"]["nodes"] > 0
    assert payload["counts"]["edges"] > 0
    assert payload["dataset"]["name"] == "northwind-labs"
    assert payload["dataset"]["matches_expected"]["Decision"] is True
    assert payload["store"]["active_backend"] == "memory"
    assert payload["health"]["status"] == "ok"


def test_search_knowledge(tools: TripwireTools) -> None:
    payload = tools.search_knowledge("Frankfurt", limit=5)
    assert "error" not in payload, payload
    assert payload["query"] == "Frankfurt"
    assert payload["total"] >= 1
    assert payload["results"]


def test_search_knowledge_empty_query_is_structured_error(tools: TripwireTools) -> None:
    _assert_error(tools.search_knowledge("   "), "validation_error")


def test_search_knowledge_limit_bounds(tools: TripwireTools) -> None:
    _assert_error(tools.search_knowledge("Frankfurt", limit=0), "validation_error")


# --------------------------------------------------------------------------- #
# 12. history_query
# --------------------------------------------------------------------------- #
def test_history_query_fact_timeline(tools: TripwireTools) -> None:
    payload = tools.history_query(mode="fact", fact_id=COMPLIANCE_FACT_ID)
    assert "error" not in payload, payload
    assert payload["fact_id"] == COMPLIANCE_FACT_ID
    assert payload["found"] is True
    assert payload["status"] == "ACTIVE"
    assert payload["still_believed"] is True
    assert payload["recorded_to"] is None
    assert payload["valid_from"] and payload["valid_to"] is None


def test_history_query_fact_timeline_reflects_a_real_change(tools: TripwireTools) -> None:
    """After a verified contradiction the original fact is closed, not deleted."""
    tools.trigger_demo_event(scenario="frankfurt_compliance_revoked")
    payload = tools.history_query(mode="fact", fact_id=COMPLIANCE_FACT_ID)
    assert "error" not in payload, payload
    assert payload["found"] is True
    assert payload["status"] == "INVALIDATED"
    assert payload["still_believed"] is False
    assert payload["recorded_to"], "the transaction interval must be closed"
    assert payload["valid_to"], "the real-world validity interval must be closed"
    assert payload["entries"], "the change must leave a timeline entry"
    kinds = {entry["kind"] for entry in payload["entries"]}
    assert "FACT_CHANGE" in kinds, kinds


def test_history_query_belief_is_transaction_time_correct(tools: TripwireTools) -> None:
    before_seed = tools.history_query(mode="belief", at="2020-01-01T00:00:00Z", limit=50)
    assert "error" not in before_seed, before_seed
    assert before_seed["at"] == "2020-01-01T00:00:00Z"
    assert before_seed["total"] == 0
    assert before_seed["facts"] == []

    after_seed = tools.history_query(mode="belief", at="2035-01-01T00:00:00Z", limit=50)
    assert "error" not in after_seed, after_seed
    assert after_seed["total"] == len(E.FACTS), "every seeded fact is believed by 2035"
    assert len(after_seed["facts"]) == len(E.FACTS)
    assert all(
        fact["recorded_at"] <= "2035-01-01T00:00:00Z" for fact in after_seed["facts"]
    ), "belief at a transaction time must not include later-recorded facts"


def test_history_query_valid_is_real_world_time_correct(tools: TripwireTools) -> None:
    valid = tools.history_query(mode="valid", at="2026-01-01T00:00:00Z", limit=50)
    assert "error" not in valid, valid
    assert valid["total"] == 2
    assert COMPLIANCE_FACT_ID in {fact["id"] for fact in valid["facts"]}
    for fact in valid["facts"]:
        assert str(fact["valid_from"]) <= "2026-01-01T00:00:00Z", fact
        assert fact["valid_to"] is None or fact["valid_to"] > "2026-01-01T00:00:00Z", fact

    filtered = tools.history_query(
        mode="valid", at="2026-01-01T00:00:00Z", subject_id=KEY_IDS["frankfurt_partner"]
    )
    assert "error" not in filtered, filtered
    assert 1 <= filtered["total"] <= valid["total"]
    assert all(fact["subject_id"] == KEY_IDS["frankfurt_partner"] for fact in filtered["facts"])


def test_history_query_changes_since(tools: TripwireTools) -> None:
    nothing_new = tools.history_query(mode="changes", since="2035-01-01T00:00:00Z")
    assert "error" not in nothing_new, nothing_new
    assert nothing_new["since"].startswith("2035-01-01")
    assert nothing_new["fact_count"] == 0
    assert nothing_new["facts"] == []

    everything = tools.history_query(mode="changes", since="2020-01-01T00:00:00Z")
    assert "error" not in everything, everything
    assert everything["fact_count"] == len(E.FACTS)
    assert everything["event_count"] >= 1
    assert "SEED" in {event["event_type"] for event in everything["events"]}


def test_history_query_dependencies_at_a_transaction_time(tools: TripwireTools) -> None:
    deps = tools.history_query(
        mode="dependencies", decision_id=KEY_IDS["eu_launch_decision"], at="2035-01-01T00:00:00Z"
    )
    assert "error" not in deps, deps
    assert deps["found"] is True
    assert deps["decision_id"] == KEY_IDS["eu_launch_decision"]
    assert deps["status_at_query"] == "ACTIVE"
    assert deps["assumption_count"] == 1
    assert deps["fact_count"] == 2
    assumption = deps["assumptions"][0]
    assert assumption["assumption_id"] == KEY_IDS["residency_assumption"]
    assert {fact["fact_id"] for fact in assumption["supporting_facts"]} == {
        KEY_IDS["compliance_fact"],
        KEY_IDS["soc2_fact"],
    }
    assert all(fact["status"] == "ACTIVE" for fact in assumption["supporting_facts"])

    # Asked at a transaction time before the decision existed, nothing had been
    # assumed yet - the history is reconstructed, not read from today's state.
    early = tools.history_query(
        mode="dependencies", decision_id=KEY_IDS["eu_launch_decision"], at="2020-01-01T00:00:00Z"
    )
    assert "error" not in early, early
    assert early["status_at_query"] is None
    assert early["assumption_count"] == 0
    assert early["fact_count"] == 0


def test_history_query_validation(tools: TripwireTools) -> None:
    _assert_error(tools.history_query(mode="nope", at="2026-01-01T00:00:00Z"), "validation_error")
    _assert_error(tools.history_query(mode="belief"), "validation_error")
    _assert_error(tools.history_query(mode="changes"), "validation_error")
    _assert_error(tools.history_query(mode="fact"), "validation_error")
    _assert_error(tools.history_query(mode="dependencies", at="2026-01-01T00:00:00Z"), "validation_error")


# --------------------------------------------------------------------------- #
# 13. trigger_demo_event
# --------------------------------------------------------------------------- #
def test_trigger_demo_event_runs_the_full_pipeline(tools: TripwireTools, engine: GraphEngine) -> None:
    before = engine.counts()
    payload = tools.trigger_demo_event(scenario="frankfurt_compliance_revoked")
    assert "error" not in payload, payload
    assert payload["event"]["scenario"] == "frankfurt_compliance_revoked"
    assert payload["contradiction"]["detected"] is True
    assert payload["contradiction"]["primary"]["kind"] in ("contradiction", "ambiguity", "succession")
    assert payload["propagation"]["affected"]
    assert payload["alert_ids"], "a verified contradiction must raise reviewable alerts"
    assert engine.counts()["nodes"] > before["nodes"]


def test_trigger_demo_event_apply_false_skips_contradiction_writes(
    tools: TripwireTools, engine: GraphEngine
) -> None:
    """`apply=False` records the assertion but writes no conflict/propagation state."""
    before_edges = engine.counts()["edges"]
    payload = tools.trigger_demo_event(scenario="frankfurt_compliance_revoked", apply=False)
    assert "error" not in payload, payload
    assert payload["event"]["applied"] is False
    assert payload["alert_ids"] == []
    assert payload["contradiction_edges"] == []

    # The scenario's own assertion/source edges are written (engine behaviour);
    # no CONTRADICTS edge and no Alert node may be created.
    assert engine.counts()["edges"] - before_edges <= 3
    assert engine.store.get_edges(rel="CONTRADICTS") == []
    assert engine.store.get_nodes(label="Alert") == []


def test_trigger_demo_event_explicit_fact_payload(tools: TripwireTools) -> None:
    payload = tools.trigger_demo_event(
        new_fact={
            "subject": "Edge Cache",
            "subject_label": "System",
            "attribute": "cdn_provider",
            "value": "cloudflare",
            "statement": "Edge Cache now sits behind Cloudflare.",
        },
        source={
            "kind": "slack",
            "external_id": "nw-slack-test-001",
            "name": "CDN change note",
            "channel": "#platform-eng",
            "author": "Daniel Osei",
            "timestamp": "2026-03-01T09:00:00Z",
        },
        actor_id="person:daniel-osei",
    )
    assert "error" not in payload, payload
    assert payload["assertion"]["fact_id"]
    assert payload["event"]["scenario"] is None


def test_trigger_demo_event_validation(tools: TripwireTools) -> None:
    _assert_error(tools.trigger_demo_event(), "validation_error")
    _assert_error(tools.trigger_demo_event(scenario="not-a-scenario"), "validation_error")
    _assert_error(tools.trigger_demo_event(new_fact={"subject": "x"}), "validation_error")


# --------------------------------------------------------------------------- #
# Protocol level: the in-memory client transport
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_protocol_in_memory_lists_and_calls_tools() -> None:
    """List tools and call two core tools over the real MCP wire."""
    from mcp.client._memory import InMemoryTransport
    from mcp.client.session import ClientSession

    engine = _build_engine()
    server = build_server(engine)

    async with InMemoryTransport(server) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()

            listed = await session.list_tools()
            names = {tool.name for tool in listed.tools}
            assert set(CORE_TOOLS) <= names, names
            assert set(TOOL_NAMES) <= names, names
            assert len(names) == len(TOOL_NAMES)

            # Every tool must carry a description and a JSON object input schema.
            for tool in listed.tools:
                assert tool.description, tool.name
                assert tool.input_schema["type"] == "object"

            experts_result = await session.call_tool(
                "find_experts", {"query": "Frankfurt Hosting Partner", "limit": 3}
            )
            assert experts_result.is_error is False
            experts = _payload(experts_result)
            assert experts["experts"], experts
            assert experts["target_name"] == "Frankfurt Hosting Partner"
            assert experts["shadow_org_signal"]["hidden_expert_count"] >= 1

            contradiction_result = await session.call_tool(
                "find_contradictions", {"fact_id": COMPLIANCE_FACT_ID}
            )
            assert contradiction_result.is_error is False
            contradiction = _payload(contradiction_result)
            assert "detected" in contradiction
            assert "candidates" in contradiction


@pytest.mark.asyncio
async def test_protocol_structured_errors_travel_over_the_wire() -> None:
    """A failing tool returns a structured error, not a transport-level crash."""
    from mcp.client._memory import InMemoryTransport
    from mcp.client.session import ClientSession

    engine = _build_engine()
    server = build_server(engine)

    async with InMemoryTransport(server) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()

            result = await session.call_tool(
                "find_contradictions", {"fact_id": "fact:does-not-exist"}
            )
            assert result.is_error is False
            payload = _payload(result)
            assert payload["error"]["code"] == "not_found"
            assert payload["error"]["message"]

            invalid = await session.call_tool("list_alerts", {"status": "BOGUS"})
            assert invalid.is_error is False
            assert _payload(invalid)["error"]["code"] == "validation_error"


@pytest.mark.asyncio
async def test_protocol_dry_run_leaves_the_graph_untouched() -> None:
    """propagate_staleness must be non-destructive through the wire by default."""
    from mcp.client._memory import InMemoryTransport
    from mcp.client.session import ClientSession

    engine = _build_engine()
    before = engine.counts()
    server = build_server(engine)

    async with InMemoryTransport(server) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            result = await session.call_tool(
                "propagate_staleness", {"fact_id": COMPLIANCE_FACT_ID, "max_depth": 3}
            )
            assert result.is_error is False
            payload = _payload(result)
            assert payload["dry_run"] is True
            assert payload["applied"] is False

    after = engine.counts()
    assert after["nodes"] == before["nodes"]
    assert after["edges"] == before["edges"]


@pytest.mark.asyncio
async def test_protocol_stdio_subprocess_serves_the_same_surface() -> None:
    """`python -m tripwire.mcp_server` starts on stdio and exposes every tool."""
    from mcp import StdioServerParameters
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client

    env = dict(os.environ)
    env["TRIPWIRE_STORE"] = "memory"  # no FalkorDB attempt, no files written
    env["PYTHONPATH"] = str(REPO_ROOT) + os.pathsep + env.get("PYTHONPATH", "")

    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "tripwire.mcp_server"],
        env=env,
        cwd=str(REPO_ROOT),
    )

    try:
        async with stdio_client(params) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                init = await session.initialize()
                assert init.server_info.name == "tripwire"

                names = {tool.name for tool in (await session.list_tools()).tools}
                assert set(TOOL_NAMES) <= names, names

                result = await session.call_tool("graph_summary", {})
                assert result.is_error is False
                payload = _payload(result)
                assert payload["store"]["active_backend"] == "memory"
                assert payload["health"]["status"] in ("ok", "degraded")
    except Exception as exc:  # noqa: BLE001 - capability probe, see below
        if not _blocked_by_sandbox(exc):
            raise
        pytest.skip(
            "this sandbox denies subprocess pipe creation (WinError 5), so the stdio "
            f"transport cannot be exercised here: {exc!r}. The in-memory transport test "
            "above still covers the MCP protocol surface; run this test on an "
            "unrestricted host to exercise stdio."
        )


def _blocked_by_sandbox(exc: BaseException) -> bool:
    """True when ``exc`` is a sandbox denial of subprocess pipe creation.

    This distinguishes an environment restriction from a genuine protocol failure:
    only ``PermissionError`` / ``WinError 5`` counts, and the cause chain plus any
    exception groups are inspected so an ``asyncio`` wrapper does not hide it.
    """
    seen: set[int] = set()
    group_type = globals().get("BaseExceptionGroup", BaseException)
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, PermissionError):
            return True
        if isinstance(current, OSError) and getattr(current, "winerror", None) == 5:
            return True
        if isinstance(current, group_type) and hasattr(current, "exceptions"):
            if any(_blocked_by_sandbox(child) for child in current.exceptions):  # type: ignore[attr-defined]
                return True
        current = current.__cause__ or current.__context__
    return False
