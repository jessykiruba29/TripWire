"""Regression tests: every reported path must be a real, continuous walk.

Bug this locks down
-------------------
``/api/paths`` (and ``GraphIndex.provenance_for``) rendered traversal chains in
*storage* order.  A chain followed against the stored edge direction - the normal
case, because ``Assumption -SUPPORTED_BY-> Fact`` and ``Decision -ASSUMES->
Assumption`` are walked backwards from the fact - collapsed into a path such as::

    assumption -SUPPORTED_BY-> assumption      # repeats a node
    assumption -ASSUMES->      decision        # direction does not follow

The frontend correctly refused to display it, because the chain was not a walk.
The fix orients every step in walk order and records ``edge_direction``.

These tests assert the structural properties that make a path displayable, so the
bug cannot silently return for any pair of entities.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tripwire.api.app import create_app
from tripwire.config import Settings
from tripwire.core.engine import GraphEngine
from tripwire.core.models import Node
from tripwire.core.store import MemoryGraphStore


@pytest.fixture()
def client() -> TestClient:
    engine = GraphEngine(MemoryGraphStore(), settings=Settings(store_backend="memory"))
    application = create_app(engine)
    with TestClient(application) as test_client:
        test_client.post("/api/demo/seed")
        # Trigger the headline scenario so the graph contains the STALED edges that
        # propagation writes; those are forward edges and must render as "forward".
        engine.trigger_event({"scenario": "frankfurt_compliance_revoked"})
        yield test_client


@pytest.fixture()
def engine(client: TestClient) -> GraphEngine:
    return client.app.state.engine


def assert_valid_walk(path: dict, *, source: str | None = None) -> None:
    """Assert the structural invariants of a displayable evidence path."""
    steps = path["steps"]
    assert steps, "a reported path must contain at least one step"

    if source is not None:
        assert steps[0]["src"] == source, "the walk must begin at the requested source"

    seen = {steps[0]["src"]}
    for index, step in enumerate(steps):
        assert step["src"] != step["dst"], f"step {index} is a self-loop: {step['src']}"
        if index:
            assert step["src"] == steps[index - 1]["dst"], (
                f"step {index} does not continue from the previous step "
                f"({steps[index - 1]['dst']!r} -> {step['src']!r})"
            )
        assert step["dst"] not in seen, (
            f"node {step['dst']!r} repeats inside one simple path"
        )
        seen.add(step["dst"])

        direction = step["props"].get("edge_direction")
        assert direction in ("forward", "reverse"), (
            f"step {index} must declare edge_direction, got {direction!r}"
        )
        stored = (step["props"].get("stored_src"), step["props"].get("stored_dst"))
        if direction == "forward":
            assert stored == (step["src"], step["dst"])
        else:
            assert stored == (step["dst"], step["src"])
        assert path["steps"][index]["rel"] == step["rel"]


CONNECTED_PAIRS = [
    # The headline chain: changed fact back to the decision that assumed it.
    ("fact:frankfurt-partner-compliance-valid", "decision:eu-launch"),
    # Reversed direction, exercising the OUT traversal.
    ("decision:eu-launch", "fact:frankfurt-partner-compliance-valid"),
    # Two hops out through the dependency chain.
    ("fact:frankfurt-partner-compliance-valid", "decision:pricing-eu"),
    # Fact to project, which crosses IMPACTS.
    ("fact:frankfurt-partner-compliance-valid", "project:pricing-v2"),
    ("fact:frankfurt-partner-compliance-valid", "assumption:data-residency-eu"),
]


@pytest.mark.parametrize(("source", "target"), CONNECTED_PAIRS)
def test_api_paths_returns_only_valid_walks(
    client: TestClient, source: str, target: str
) -> None:
    response = client.get("/api/paths", params={"source": source, "target": target})
    assert response.status_code == 200
    body = response.json()
    assert body["found"] is True, f"expected {source} -> {target} to be connected"
    assert body["paths"], "found=True must come with at least one path"
    for path in body["paths"]:
        assert_valid_walk(path, source=source)
        assert path["steps"][-1]["dst"] == target


def test_paths_never_report_a_repeated_endpoint(client: TestClient) -> None:
    """The original symptom was a path reading ``assumption -> assumption``."""
    response = client.get(
        "/api/paths",
        params={
            "source": "fact:frankfurt-partner-compliance-valid",
            "target": "decision:eu-launch",
        },
    )
    body = response.json()
    for path in body["paths"]:
        first, last = path["steps"][0], path["steps"][-1]
        assert not (first["src"] == last["dst"] and len(path["steps"]) > 1), (
            "a multi-step path must not start and end on the same node"
        )


def test_reverse_walk_declares_reverse_direction(client: TestClient) -> None:
    """Walking against storage order must be labelled, not hidden."""
    response = client.get(
        "/api/paths",
        params={
            "source": "fact:frankfurt-partner-compliance-valid",
            "target": "decision:eu-launch",
        },
    )
    directions = {
        step["props"]["edge_direction"]
        for path in response.json()["paths"]
        for step in path["steps"]
    }
    assert "reverse" in directions, "the assumption/decision hops are stored backwards"
    assert "forward" in directions, "the STALED edge really does point at the decision"


def test_disconnected_pair_is_reported_honestly(client: TestClient) -> None:
    engine: GraphEngine = client.app.state.engine
    engine.put_node(Node(id="system:isolated-a", label="System", name="Isolated A"))
    engine.put_node(Node(id="system:isolated-b", label="System", name="Isolated B"))

    response = client.get(
        "/api/paths", params={"source": "system:isolated-a", "target": "system:isolated-b"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["found"] is False
    assert body["paths"] == []
    assert body["reason"], "an unconnected pair must explain why no path exists"


def _collect_paths(payload: object, found: list[dict]) -> None:
    """Every path object anywhere in a response, however deeply nested."""
    if isinstance(payload, dict):
        steps = payload.get("steps")
        if isinstance(steps, list) and steps:
            found.append(payload)
        for value in payload.values():
            _collect_paths(value, found)
    elif isinstance(payload, list):
        for value in payload:
            _collect_paths(value, found)


def test_every_path_in_a_decision_explanation_is_a_valid_walk(client: TestClient) -> None:
    """``provenance_for`` shared the same defect; walk the whole explanation payload."""
    response = client.get("/api/decisions/decision:eu-launch/explanation")
    assert response.status_code == 200

    paths: list[dict] = []
    _collect_paths(response.json(), paths)
    assert paths, "the EU launch explanation must expose at least one evidence path"
    for path in paths:
        assert_valid_walk(path)
