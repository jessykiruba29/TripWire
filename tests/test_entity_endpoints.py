"""HTTP contract tests for the dedicated entity endpoints.

Covers ``GET /api/entities`` and ``GET /api/{kind}`` / ``GET /api/{kind}/{id}``
for all seven kinds: response schema, ``label`` vs ``name`` semantics,
pagination, filters (including rejected ones), empty graphs, error envelopes and
the storage-failure mapping.  One group runs against the configured JSON backend
rather than the in-memory store, so the contract is proven backend-independent.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tripwire.api.app import create_app
from tripwire.api.schemas import EntityDetailResponse, EntityIndexResponse, EntityListResponse
from tripwire.config import Settings
from tripwire.core.engine import GraphEngine
from tripwire.core.entities import ENTITY_KINDS
from tripwire.core.errors import StoreUnavailableError
from tripwire.core.store import MemoryGraphStore
from tripwire.dataset.northwind import KEY_IDS

EU_LAUNCH = KEY_IDS["eu_launch_decision"]
JONAS = KEY_IDS.get("jonas", "person:jonas-berg")

KIND_LABELS = {kind: labels[0] for kind, labels in ENTITY_KINDS.items()}
KINDS = list(ENTITY_KINDS)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture()
def engine() -> GraphEngine:
    """A fresh engine over an isolated in-memory store."""
    return GraphEngine(MemoryGraphStore(), settings=Settings(store_backend="memory"))


@pytest.fixture()
def client(engine: GraphEngine) -> TestClient:
    """Unseeded application."""
    app = create_app(engine)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def seeded(client: TestClient) -> TestClient:
    """Application seeded through the API."""
    response = client.post("/api/demo/seed", json={"force": False})
    assert response.status_code == 200, response.text
    return client


@pytest.fixture()
def configured_client(tmp_path) -> TestClient:
    """Application built from *settings* over the configured JSON backend.

    This is the offline default the server actually uses when FalkorDB is not
    running (``TRIPWIRE_STORE=json``), so it proves the endpoints do not depend
    on the in-memory test double.
    """
    settings = Settings(store_backend="json", state_path=str(tmp_path / "graph.json"))
    engine = GraphEngine.from_settings(settings)
    app = create_app(engine)
    with TestClient(app) as test_client:
        assert test_client.post("/api/demo/seed", json={"force": False}).status_code == 200
        yield test_client


class _BrokenStore(MemoryGraphStore):
    """A store that fails like an unreachable graph database."""

    backend = "broken"

    def all_nodes(self):  # type: ignore[no-untyped-def]
        raise StoreUnavailableError("graph database is unreachable (test double)")

    def all_edges(self):  # type: ignore[no-untyped-def]
        raise StoreUnavailableError("graph database is unreachable (test double)")


# --------------------------------------------------------------------------- #
# Index endpoint
# --------------------------------------------------------------------------- #
def test_entity_index_shape(seeded: TestClient) -> None:
    response = seeded.get("/api/entities")
    assert response.status_code == 200
    body = response.json()
    EntityIndexResponse.model_validate(body)  # declared response model must fit
    assert [entry["kind"] for entry in body["kinds"]] == KINDS
    assert body["total"] == sum(body["counts"].values())
    for entry in body["kinds"]:
        assert entry["label"] == KIND_LABELS[entry["kind"]]
        assert entry["path"] == f"/api/{entry['kind']}"
        assert entry["count"] == body["counts"][entry["kind"]]
    # The seed baseline: every kind is populated, events has at least the seed event.
    assert body["counts"]["decisions"] == 7
    assert body["counts"]["people"] >= 5
    assert body["counts"]["events"] >= 1


def test_entity_index_counts_match_demo_state(seeded: TestClient) -> None:
    counts = seeded.get("/api/entities").json()["counts"]
    by_label = seeded.get("/api/demo/state").json()["counts"]["by_label"]
    assert counts["decisions"] == by_label["Decision"]
    assert counts["people"] == by_label["Person"]
    assert counts["projects"] == by_label["Project"]
    assert counts["systems"] == by_label["System"]
    assert counts["teams"] == by_label["Team"]
    assert counts["assumptions"] == by_label["Assumption"]
    # events = Event + Alert nodes
    assert counts["events"] == by_label.get("Event", 0) + by_label.get("Alert", 0)


# --------------------------------------------------------------------------- #
# Lists
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("kind", KINDS)
def test_list_every_kind_has_the_declared_schema(seeded: TestClient, kind: str) -> None:
    response = seeded.get(f"/api/{kind}")
    assert response.status_code == 200, response.text
    body = response.json()
    EntityListResponse.model_validate(body)
    assert body["kind"] == kind
    assert body["label"] == KIND_LABELS[kind]
    assert body["total"] >= 1, f"the seeded demo must have {kind}"
    assert body["count"] == len(body["items"]) == min(body["limit"], body["total"])
    assert set(body["counts"]) == set(KINDS)
    for item in body["items"]:
        assert item["id"] and isinstance(item["id"], str)
        assert item["kind"] == kind
        assert item["label"] in ENTITY_KINDS[kind]
        assert item["type"] == item["label"]
        assert item["name"]  # human display name, never empty
        assert item["summary"]
        assert isinstance(item["state"], str) and item["state"]
        assert isinstance(item["relations"], dict)
        assert isinstance(item["related_ids"], list)
        # label is the kind, not the id: the two must never be conflated.
        assert item["label"] != item["id"]


def test_label_is_kind_and_name_is_display_text(seeded: TestClient) -> None:
    items = seeded.get("/api/decisions", params={"limit": 100}).json()["items"]
    decision = next(item for item in items if item["id"] == EU_LAUNCH)
    assert decision["label"] == "Decision"
    assert decision["name"].startswith("Launch Northwind")
    assert decision["id"].startswith("decision:")


def test_list_relations_agree_with_the_graph(seeded: TestClient) -> None:
    items = seeded.get("/api/decisions").json()["items"]
    decision = next(item for item in items if item["id"] == EU_LAUNCH)
    assumes = decision["relations"]["assumes"]
    assert assumes["direction"] == "out"
    assert assumes["relationships"] == ["ASSUMES"]
    assert "assumption:data-residency-eu" in assumes["ids"]
    for edge in assumes["edges"]:
        assert edge["source"] == EU_LAUNCH
        assert edge["rel"] == "ASSUMES"
    # Every related id must exist in the graph payload - no fabricated ids.
    graph = seeded.get("/api/graph", params={"node_limit": 500}).json()
    known = {node["id"] for node in graph["nodes"]}
    for related in decision["related_ids"]:
        assert related in known


def test_pagination_windows_are_stable(seeded: TestClient) -> None:
    full = seeded.get("/api/decisions", params={"limit": 100}).json()
    page1 = seeded.get("/api/decisions", params={"limit": 3, "offset": 0}).json()
    page2 = seeded.get("/api/decisions", params={"limit": 3, "offset": 3}).json()
    assert full["total"] == page1["total"] == page2["total"] == 7
    assert page1["count"] == 3 and page2["count"] == 3
    ids = [item["id"] for item in full["items"]]
    assert [item["id"] for item in page1["items"]] == ids[0:3]
    assert [item["id"] for item in page2["items"]] == ids[3:6]


def test_empty_graph_returns_empty_lists_not_errors(client: TestClient) -> None:
    index = client.get("/api/entities").json()
    assert index["total"] == 0
    assert all(count == 0 for count in index["counts"].values())
    for kind in KINDS:
        response = client.get(f"/api/{kind}")
        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 0 and body["items"] == []
        assert body["count"] == 0


def test_q_filter_matches_and_misses_cleanly(seeded: TestClient) -> None:
    hit = seeded.get("/api/decisions", params={"q": "pricing"}).json()
    assert hit["total"] >= 1
    assert all("pricing" in (item["name"] + item["id"]).lower() for item in hit["items"])
    miss = seeded.get("/api/decisions", params={"q": "no-such-thing-xyz"}).json()
    assert miss["total"] == 0 and miss["items"] == []


def test_status_filter_is_exact_and_unknown_status_is_empty(seeded: TestClient) -> None:
    active = seeded.get("/api/decisions", params={"status": "ACTIVE"}).json()
    assert active["total"] == 7
    assert all(item["state"] == "active" for item in active["items"])
    assert active["filters"]["status"] == "ACTIVE"
    none = seeded.get("/api/decisions", params={"status": "NOT_A_STATUS"}).json()
    assert none["total"] == 0 and none["items"] == []


def test_documented_extra_filter_works(seeded: TestClient) -> None:
    response = seeded.get("/api/people", params={"role": "engineer"})
    assert response.status_code == 200
    body = response.json()
    assert all(
        str(item.get("role", "")).lower() == "engineer" for item in body["items"]
    )


def test_unknown_filter_is_422_with_details(seeded: TestClient) -> None:
    response = seeded.get("/api/people", params={"colour": "blue"})
    assert response.status_code == 422
    body = response.json()
    assert body["error"] == "validation_error"
    assert body["details"]["filter"] == "colour"


@pytest.mark.parametrize(
    "params",
    [{"limit": 0}, {"limit": -1}, {"limit": 9999}, {"offset": -1}],
)
def test_invalid_pagination_is_422(seeded: TestClient, params: dict) -> None:
    response = seeded.get("/api/decisions", params=params)
    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"


def test_events_are_newest_first_and_include_alerts(seeded: TestClient) -> None:
    seeded.post("/api/demo/trigger-event", json={"scenario": "frankfurt_compliance_revoked"})
    body = seeded.get("/api/events", params={"limit": 100}).json()
    assert body["total"] >= 2
    labels = {item["label"] for item in body["items"]}
    assert labels <= {"Event", "Alert"}
    assert "Alert" in labels
    # alerts raised through the alert API must be listable as events too
    alert_ids = {alert["id"] for alert in seeded.get("/api/alerts").json()["alerts"]}
    event_ids = {item["id"] for item in body["items"]}
    assert alert_ids <= event_ids
    # chronology: timestamps (when present) never increase down the list
    moments = [
        item.get("timestamp") or item.get("recorded_at") or "" for item in body["items"]
    ]
    present = [moment for moment in moments if moment]
    assert present == sorted(present, reverse=True)


# --------------------------------------------------------------------------- #
# Detail endpoints
# --------------------------------------------------------------------------- #
def test_detail_returns_the_same_view_as_the_list(seeded: TestClient) -> None:
    listed = seeded.get("/api/decisions").json()["items"]
    decision = next(item for item in listed if item["id"] == EU_LAUNCH)
    response = seeded.get(f"/api/decisions/{EU_LAUNCH}")
    assert response.status_code == 200
    body = response.json()
    EntityDetailResponse.model_validate(body)
    assert body["found"] is True
    assert body["kind"] == "decisions"
    assert body["entity_id"] == EU_LAUNCH
    assert body["entity"] == decision


def test_detail_exists_for_every_kind(seeded: TestClient) -> None:
    for kind in KINDS:
        items = seeded.get(f"/api/{kind}").json()["items"]
        assert items, f"seeded demo must contain {kind}"
        entity_id = items[0]["id"]
        response = seeded.get(f"/api/{kind}/{entity_id}")
        assert response.status_code == 200, f"{kind}: {response.text}"
        body = response.json()
        assert body["found"] and body["entity"]["id"] == entity_id
        assert body["entity"]["label"] in ENTITY_KINDS[kind]


def test_detail_unknown_id_is_404_envelope(seeded: TestClient) -> None:
    response = seeded.get("/api/decisions/decision:does-not-exist")
    assert response.status_code == 404
    body = response.json()
    assert body["error"] == "not_found"
    assert body["details"] == {"kind": "decisions", "entity_id": "decision:does-not-exist"}
    assert "message" in body


def test_detail_wrong_kind_is_404(seeded: TestClient) -> None:
    response = seeded.get(f"/api/people/{EU_LAUNCH}")
    assert response.status_code == 404
    assert response.json()["error"] == "not_found"


def test_person_jonas_is_listed_as_a_contributor_not_owner(seeded: TestClient) -> None:
    """The Frankfurt scenario's hidden expert must be listable, not an owner."""
    response = seeded.get(f"/api/people/{JONAS}")
    assert response.status_code == 200, response.text
    person = response.json()["entity"]
    assert person["label"] == "Person"
    owns = person["relations"].get("owns", {"ids": []})["ids"]
    assert "system:frankfurt-hosting-partner" not in owns


# --------------------------------------------------------------------------- #
# Configured backend (JSON store, not the memory test double)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("kind", KINDS)
def test_contract_holds_on_the_configured_json_backend(
    configured_client: TestClient, kind: str
) -> None:
    response = configured_client.get(f"/api/{kind}", params={"limit": 2})
    assert response.status_code == 200, response.text
    body = response.json()
    EntityListResponse.model_validate(body)
    assert body["kind"] == kind
    assert body["total"] >= 1
    assert len(body["items"]) == min(2, body["total"])
    for item in body["items"]:
        assert item["label"] in ENTITY_KINDS[kind]
        assert item["id"]


def test_configured_backend_is_reported(configured_client: TestClient) -> None:
    health = configured_client.get("/api/health").json()
    assert health["active_backend"] == "json"
    ids = {item["id"] for item in configured_client.get("/api/decisions").json()["items"]}
    assert EU_LAUNCH in ids


# --------------------------------------------------------------------------- #
# Storage failures and route isolation
# --------------------------------------------------------------------------- #
def test_storage_failure_is_503_envelope() -> None:
    engine = GraphEngine(_BrokenStore(), settings=Settings(store_backend="memory"))
    with TestClient(create_app(engine)) as broken:
        for path in ("/api/entities", "/api/decisions", f"/api/decisions/{EU_LAUNCH}"):
            response = broken.get(path)
            assert response.status_code == 503, path
            body = response.json()
            assert body["error"] == "store_unavailable"
            assert "unreachable" in body["message"]


def test_entity_routes_do_not_shadow_existing_routes(seeded: TestClient) -> None:
    """Registration order must leave every pre-existing route working."""
    assert seeded.get("/api/health").status_code == 200
    assert seeded.get("/api/demo/state").status_code == 200
    assert seeded.get("/api/sources").status_code == 200
    assert seeded.get("/api/alerts").status_code == 200
    assert seeded.get(f"/api/decisions/{EU_LAUNCH}/explanation").status_code == 200
    assert (
        seeded.get(
            f"/api/decisions/{EU_LAUNCH}/dependencies",
            params={"at": "2026-02-03T00:00:00Z"},
        ).status_code
        == 200
    )
    assert seeded.get("/api/search", params={"q": "eu"}).status_code == 200
    # unknown two-segment paths stay 404 (there is no catch-all entity route)
    assert seeded.get("/api/nosuchthing/whatever").status_code == 404
    assert seeded.get("/api/nosuchthing").status_code == 404


def test_openapi_documents_the_entity_routes(seeded: TestClient) -> None:
    spec = seeded.get("/openapi.json").json()
    for kind in KINDS:
        assert f"/api/{kind}" in spec["paths"], kind
        assert any(
            key.startswith(f"/api/{kind}/{{") for key in spec["paths"]
        ), f"missing detail route for {kind}"
    assert "/api/entities" in spec["paths"]
