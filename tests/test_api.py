"""HTTP API contract tests for :mod:`tripwire.api`.

Every test builds an isolated application backed by an in-memory graph store, so
the suite needs no Docker, no network and no LLM credentials.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tripwire.api.app import create_app
from tripwire.config import Settings
from tripwire.core.engine import GraphEngine
from tripwire.core.store import MemoryGraphStore
from tripwire.dataset.northwind import COMPLIANCE_FACT_ID, KEY_IDS

EU_LAUNCH = KEY_IDS["eu_launch_decision"]
LEGAL_SIGNOFF = KEY_IDS["legal_signoff_decision"]
UNRELATED_DECISIONS = (
    KEY_IDS["apac_decision"],
    KEY_IDS["dark_mode_decision"],
    KEY_IDS["warehouse_decision"],
)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture()
def engine() -> GraphEngine:
    """A fresh engine over an isolated in-memory store."""
    return GraphEngine(MemoryGraphStore(), settings=Settings(store_backend="memory"))


@pytest.fixture()
def client(engine: GraphEngine) -> TestClient:
    """A TestClient bound to a freshly built, unseeded application."""
    app = create_app(engine)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def seeded(client: TestClient) -> TestClient:
    """A TestClient whose graph has been seeded through the API."""
    response = client.post("/api/demo/seed", json={"force": False})
    assert response.status_code == 200, response.text
    return client


def _decision_statuses(client: TestClient) -> dict[str, str | None]:
    """Map of decision id -> status, read back through the graph endpoint."""
    response = client.get("/api/graph", params={"label": "Decision"})
    assert response.status_code == 200
    return {node["id"]: node.get("status") for node in response.json()["nodes"]}


# --------------------------------------------------------------------------- #
# Health / demo lifecycle
# --------------------------------------------------------------------------- #
def test_health(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["active_backend"] == "memory"
    assert body["configured_backend"] == "memory"
    assert body["seeded"] is False
    # The permissive response model must preserve the engine's extra fields.
    assert "store" in body and "checked_at" in body


def test_demo_state_after_seed(seeded: TestClient) -> None:
    response = seeded.get("/api/demo/state")
    assert response.status_code == 200
    body = response.json()
    assert body["seeded"] is True
    matches = body["dataset"]["matches_expected"]
    assert matches and all(matches.values()), matches
    by_label = body["counts"]["by_label"]
    assert by_label["Decision"] == 7
    assert by_label["Fact"] == 13
    assert body["store"]["active_backend"] == "memory"


def test_graph_payload_shape(seeded: TestClient) -> None:
    response = seeded.get("/api/graph")
    assert response.status_code == 200
    body = response.json()
    assert set(("nodes", "edges", "meta")) <= set(body)
    meta = body["meta"]
    assert meta["node_count"] == len(body["nodes"])
    assert meta["edge_count"] == len(body["edges"])
    assert meta["total_nodes"] >= meta["node_count"]
    assert isinstance(meta["truncated"], bool)


def test_graph_label_filter_and_limits(seeded: TestClient) -> None:
    response = seeded.get(
        "/api/graph", params={"label": "Decision", "node_limit": 2, "edge_limit": 1}
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["nodes"]) == 2
    assert len(body["edges"]) <= 1
    assert body["meta"]["truncated"] is True
    assert all(node["label"] == "Decision" for node in body["nodes"])


def test_graph_unknown_label_is_422(seeded: TestClient) -> None:
    response = seeded.get("/api/graph", params={"label": "NotAType"})
    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"


# --------------------------------------------------------------------------- #
# Trigger event: the headline scenario
# --------------------------------------------------------------------------- #
def test_trigger_event_headline_scenario(seeded: TestClient) -> None:
    response = seeded.post(
        "/api/demo/trigger-event", json={"scenario": "frankfurt_compliance_revoked"}
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["contradiction"]["detected"] is True
    assert body["assertion"]["fact_id"]
    assert body["alert_ids"], "the headline scenario must raise alerts"

    impacts = {impact["entity_id"]: impact for impact in body["impacts"]}
    assert EU_LAUNCH in impacts
    assert impacts[EU_LAUNCH]["status_after"] == "POTENTIALLY_STALE"
    assert impacts[EU_LAUNCH]["certainty"] == "potential"

    # The regulatory sign-off decision loses its only support -> confirmed.
    assert LEGAL_SIGNOFF in impacts
    assert impacts[LEGAL_SIGNOFF]["certainty"] == "confirmed"
    assert impacts[LEGAL_SIGNOFF]["status_after"] == "POTENTIALLY_STALE"

    # Nothing is ever written as STALE by propagation.
    assert all(impact["status_after"] != "STALE" for impact in body["impacts"])

    statuses = _decision_statuses(seeded)
    assert statuses[EU_LAUNCH] == "POTENTIALLY_STALE"
    for decision_id in UNRELATED_DECISIONS:
        assert statuses[decision_id] == "ACTIVE", decision_id


def test_trigger_event_unknown_scenario_is_422(seeded: TestClient) -> None:
    response = seeded.post("/api/demo/trigger-event", json={"scenario": "not_a_scenario"})
    assert response.status_code == 422
    body = response.json()
    assert body["error"] == "validation_error"
    assert "not_a_scenario" in body["message"]


def test_trigger_event_empty_body_is_422(seeded: TestClient) -> None:
    response = seeded.post("/api/demo/trigger-event", json={})
    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"


def test_trigger_event_explicit_fact(seeded: TestClient) -> None:
    payload = {
        "new_fact": {
            "subject": "Frankfurt Hosting Partner",
            "subject_label": "System",
            "attribute": "compliance_status",
            "value": "revoked",
            "statement": "Partner certification revoked (explicit fact).",
        },
        "source": {
            "kind": "slack",
            "external_id": "api-test-evt-1",
            "name": "Explicit revocation",
            "author": "Aisha Khan",
            "timestamp": "2026-02-20T09:00:00Z",
        },
        "use_llm": False,
    }
    response = seeded.post("/api/demo/trigger-event", json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["assertion"]["created"] is True
    assert body["contradiction"]["detected"] is True


# --------------------------------------------------------------------------- #
# Reset / seed
# --------------------------------------------------------------------------- #
def test_reset_restores_state(seeded: TestClient) -> None:
    seeded.post("/api/demo/trigger-event", json={"scenario": "frankfurt_compliance_revoked"})
    assert _decision_statuses(seeded)[EU_LAUNCH] == "POTENTIALLY_STALE"

    response = seeded.post("/api/demo/reset")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reset"] is True
    assert body["seeded"] is True

    state = seeded.get("/api/demo/state").json()
    assert state["seeded"] is True
    assert state["alerts"]["total"] == 0
    assert _decision_statuses(seeded)[EU_LAUNCH] == "ACTIVE"


def test_seed_is_idempotent(seeded: TestClient) -> None:
    before = seeded.get("/api/demo/state").json()["counts"]["nodes"]
    response = seeded.post("/api/demo/seed", json={"force": False})
    assert response.status_code == 200
    after = seeded.get("/api/demo/state").json()["counts"]["nodes"]
    assert before == after


# --------------------------------------------------------------------------- #
# Decisions / facts
# --------------------------------------------------------------------------- #
def test_decision_explanation(seeded: TestClient) -> None:
    response = seeded.get(f"/api/decisions/{EU_LAUNCH}/explanation")
    assert response.status_code == 200
    body = response.json()
    assert body["found"] is True
    assert body["decision"]["id"] == EU_LAUNCH
    assert body["assumption_count"] >= 1
    assert "dependencies" in body


def test_unknown_decision_explanation_is_404(seeded: TestClient) -> None:
    response = seeded.get("/api/decisions/decision:does-not-exist/explanation")
    assert response.status_code == 404
    body = response.json()
    assert body["error"] == "not_found"
    assert set(("error", "message", "details")) <= set(body)


def test_fact_explanation_and_unknown_404(seeded: TestClient) -> None:
    ok = seeded.get(f"/api/facts/{COMPLIANCE_FACT_ID}/explanation")
    assert ok.status_code == 200
    assert ok.json()["found"] is True
    missing = seeded.get("/api/facts/fact:missing/explanation")
    assert missing.status_code == 404
    assert missing.json()["error"] == "not_found"


def test_decision_status_transition_and_stale_confirmation(seeded: TestClient) -> None:
    # Unknown status -> 422.
    bad = seeded.post(f"/api/decisions/{EU_LAUNCH}/status", json={"status": "NOPE"})
    assert bad.status_code == 422
    assert bad.json()["error"] == "validation_error"

    # STALE without confirmation -> 422 (never automatic).
    unconfirmed = seeded.post(f"/api/decisions/{EU_LAUNCH}/status", json={"status": "STALE"})
    assert unconfirmed.status_code == 422

    # STALE with confirmation -> 200.
    confirmed = seeded.post(
        f"/api/decisions/{EU_LAUNCH}/status",
        json={"status": "STALE", "confirm": True, "actor_id": "person:tester", "note": "api test"},
    )
    assert confirmed.status_code == 200
    assert confirmed.json()["status"] == "STALE"

    # Unknown decision -> 404.
    missing = seeded.post(
        "/api/decisions/decision:nope/status", json={"status": "ACTIVE"}
    )
    assert missing.status_code == 404
    assert missing.json()["error"] == "not_found"


def test_dependencies_endpoint(seeded: TestClient) -> None:
    # A transaction time after the decision was made: the dependency walk sees the
    # assumptions and supporting facts as they were recorded by that point.
    response = seeded.get(
        f"/api/decisions/{EU_LAUNCH}/dependencies", params={"at": "2026-03-01T00:00:00Z"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["found"] is True
    assert body["decision_id"] == EU_LAUNCH
    assert body["assumption_count"] >= 1
    assert body["assumptions"], body
    assert isinstance(body["status_at_query"], str)


def test_dependencies_endpoint_at_before_decision(seeded: TestClient) -> None:
    # Before the decision existed, the snapshot has no linked assumptions.
    response = seeded.get(
        f"/api/decisions/{EU_LAUNCH}/dependencies", params={"at": "2026-01-01T00:00:00Z"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["found"] is True
    assert body["assumption_count"] == 0


def test_dependencies_endpoint_unknown_decision_is_404(seeded: TestClient) -> None:
    response = seeded.get(
        "/api/decisions/decision:nope/dependencies", params={"at": "2026-03-01T00:00:00Z"}
    )
    assert response.status_code == 404
    assert response.json()["error"] == "not_found"


# --------------------------------------------------------------------------- #
# Experts
# --------------------------------------------------------------------------- #
def test_experts_hidden_expert_ranked_first(seeded: TestClient) -> None:
    response = seeded.get("/api/experts", params={"q": "EU Launch"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["experts"], body
    top = body["experts"][0]
    assert top["person_id"] == "person:jonas-berg"
    assert top["rank"] == 1
    assert top["shadow_signal"] is True
    assert top["is_official_owner"] is False


def test_experts_query_post_matches_get(seeded: TestClient) -> None:
    get_body = seeded.get("/api/experts", params={"q": "EU Launch", "limit": 3}).json()
    post = seeded.post("/api/experts/query", json={"query": "EU Launch", "limit": 3})
    assert post.status_code == 200
    assert post.json()["experts"][0]["person_id"] == get_body["experts"][0]["person_id"]


def test_experts_missing_query_is_422(seeded: TestClient) -> None:
    response = seeded.get("/api/experts")
    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"


# --------------------------------------------------------------------------- #
# Contradictions / staleness
# --------------------------------------------------------------------------- #
def test_contradictions_find_candidate(seeded: TestClient) -> None:
    response = seeded.post(
        "/api/contradictions/find",
        json={
            "candidate": {
                "subject": "Frankfurt Hosting Partner",
                "attribute": "compliance_status",
                "value": "revoked",
            },
            "use_llm": False,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["contradiction_found"] is True
    assert any(
        c.get("existing_fact_id") == COMPLIANCE_FACT_ID for c in body["candidates"]
    )


def test_contradictions_find_requires_input(seeded: TestClient) -> None:
    response = seeded.post("/api/contradictions/find", json={})
    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"


def test_contradictions_find_by_fact_id(seeded: TestClient) -> None:
    response = seeded.post(
        "/api/contradictions/find", json={"fact_id": COMPLIANCE_FACT_ID}
    )
    assert response.status_code == 200
    assert "candidates" in response.json()


def test_staleness_dry_run_does_not_write(seeded: TestClient, engine: GraphEngine) -> None:
    before = engine.counts()
    response = seeded.post(
        "/api/staleness/propagate", json={"fact_id": COMPLIANCE_FACT_ID, "dry_run": True}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["dry_run"] is True
    assert body["applied"] is False
    assert body["affected"], body

    after = engine.counts()
    assert before["nodes"] == after["nodes"]
    assert before["edges"] == after["edges"]

    # The decision must be untouched by a dry run.
    assert _decision_statuses(seeded)[EU_LAUNCH] == "ACTIVE"


def test_staleness_apply_writes(seeded: TestClient, engine: GraphEngine) -> None:
    before = engine.counts()
    response = seeded.post(
        "/api/staleness/propagate", json={"fact_id": COMPLIANCE_FACT_ID, "dry_run": False}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["dry_run"] is False
    assert body["applied"] is True

    after = engine.counts()
    assert (after["nodes"], after["edges"]) != (before["nodes"], before["edges"])
    assert _decision_statuses(seeded)[EU_LAUNCH] == "POTENTIALLY_STALE"


def test_staleness_unknown_fact_is_404(seeded: TestClient) -> None:
    response = seeded.post("/api/staleness/propagate", json={"fact_id": "fact:nope"})
    assert response.status_code == 404
    assert response.json()["error"] == "not_found"


# --------------------------------------------------------------------------- #
# Alerts
# --------------------------------------------------------------------------- #
def _first_alert(client: TestClient) -> dict:
    body = client.get("/api/alerts").json()
    assert body["alerts"], body
    return body["alerts"][0]


def test_alert_list_pagination(seeded: TestClient) -> None:
    seeded.post("/api/demo/trigger-event", json={"scenario": "frankfurt_compliance_revoked"})
    response = seeded.get("/api/alerts", params={"limit": 2, "offset": 0})
    assert response.status_code == 200
    body = response.json()
    for key in ("total", "count", "limit", "offset", "status_counts", "alerts"):
        assert key in body, key
    assert body["limit"] == 2
    assert body["offset"] == 0
    assert body["total"] >= body["count"]
    assert body["count"] <= 2


def test_alert_detail_and_history(seeded: TestClient) -> None:
    seeded.post("/api/demo/trigger-event", json={"scenario": "frankfurt_compliance_revoked"})
    alert = _first_alert(seeded)
    alert_id = alert["id"]

    detail = seeded.get(f"/api/alerts/{alert_id}")
    assert detail.status_code == 200
    assert detail.json()["id"] == alert_id

    history = seeded.get(f"/api/alerts/{alert_id}/history")
    assert history.status_code == 200
    assert history.json()["alert_id"] == alert_id
    assert "history" in history.json()


def test_alert_review_invalid_transition_is_409(seeded: TestClient) -> None:
    seeded.post("/api/demo/trigger-event", json={"scenario": "frankfurt_compliance_revoked"})
    alert = _first_alert(seeded)
    alert_id = alert["id"]
    status = alert["status"]

    if status == "NEW":
        moved = seeded.post(
            f"/api/alerts/{alert_id}/review", json={"status": "NEEDS_REVIEW"}
        )
        assert moved.status_code == 200

    # Moving a reviewed alert back to NEW is not a documented transition.
    response = seeded.post(f"/api/alerts/{alert_id}/review", json={"status": "NEW"})
    assert response.status_code == 409, response.text
    body = response.json()
    assert body["error"] == "invalid_transition"
    assert body["details"]["from"] in {"NEEDS_REVIEW", "CONFIRMED_STALE", "DISMISSED", "RESOLVED"}


def test_alert_unknown_status_is_422(seeded: TestClient) -> None:
    seeded.post("/api/demo/trigger-event", json={"scenario": "frankfurt_compliance_revoked"})
    alert_id = _first_alert(seeded)["id"]
    response = seeded.post(f"/api/alerts/{alert_id}/review", json={"status": "NOT_A_STATUS"})
    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"


def test_alert_unknown_id_is_404(seeded: TestClient) -> None:
    response = seeded.get("/api/alerts/alert:missing")
    assert response.status_code == 404
    assert response.json()["error"] == "not_found"


# --------------------------------------------------------------------------- #
# History
# --------------------------------------------------------------------------- #
def test_history_endpoints(seeded: TestClient) -> None:
    belief = seeded.get("/api/history/belief", params={"at": "2026-03-01T00:00:00Z"})
    assert belief.status_code == 200
    assert set(("at", "label", "total", "facts")) <= set(belief.json())

    valid = seeded.get("/api/history/valid", params={"at": "2026-02-15T00:00:00Z"})
    assert valid.status_code == 200
    assert set(("at", "subject_id", "attribute", "total", "facts")) <= set(valid.json())

    changes = seeded.get("/api/history/changes", params={"since": "2026-01-01T00:00:00Z"})
    assert changes.status_code == 200
    assert changes.json()["since"] == "2026-01-01T00:00:00Z"

    timeline = seeded.get(f"/api/history/facts/{COMPLIANCE_FACT_ID}")
    assert timeline.status_code == 200
    assert timeline.json()["fact_id"] == COMPLIANCE_FACT_ID
    assert "entries" in timeline.json()

    source = seeded.get(f"/api/history/facts/{COMPLIANCE_FACT_ID}/source-of-change")
    assert source.status_code == 200
    assert source.json()["fact_id"] == COMPLIANCE_FACT_ID


def test_history_missing_required_param_is_422(seeded: TestClient) -> None:
    response = seeded.get("/api/history/belief")
    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"


# --------------------------------------------------------------------------- #
# Paths / search / sources / scenarios
# --------------------------------------------------------------------------- #
def test_paths_endpoint(seeded: TestClient) -> None:
    response = seeded.get(
        "/api/paths", params={"source": COMPLIANCE_FACT_ID, "target": EU_LAUNCH}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["found"] is True
    assert body["paths"]

    unknown = seeded.get("/api/paths", params={"source": "fact:nope", "target": EU_LAUNCH})
    assert unknown.status_code == 200
    assert unknown.json()["found"] is False


def test_search_endpoint(seeded: TestClient) -> None:
    response = seeded.get("/api/search", params={"q": "Frankfurt", "limit": 5})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] >= 1
    assert len(body["results"]) <= 5

    missing_q = seeded.get("/api/search")
    assert missing_q.status_code == 422


def test_sources_list_and_detail(seeded: TestClient) -> None:
    listing = seeded.get("/api/sources", params={"limit": 5, "offset": 0})
    assert listing.status_code == 200
    body = listing.json()
    assert body["total"] == 60
    assert body["count"] == 5
    assert body["limit"] == 5
    assert body["offset"] == 0

    source_id = body["sources"][0]["id"]
    detail = seeded.get(f"/api/sources/{source_id}")
    assert detail.status_code == 200
    assert detail.json()["source"]["id"] == source_id
    assert "states" in detail.json()

    missing = seeded.get("/api/sources/document:nope:nope")
    assert missing.status_code == 404
    assert missing.json()["error"] == "not_found"


def test_sources_type_filter(seeded: TestClient) -> None:
    response = seeded.get("/api/sources", params={"type": "slack", "limit": 100})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 40
    assert all(src["label"] == "Message" for src in body["sources"])


def test_scenarios_catalog(client: TestClient) -> None:
    response = client.get("/api/dataset/scenarios")
    assert response.status_code == 200
    body = response.json()
    names = {scenario["name"] for scenario in body["scenarios"]}
    assert "frankfurt_compliance_revoked" in names
    assert body["total"] == len(body["scenarios"])
    headline = next(s for s in body["scenarios"] if s["name"] == "frankfurt_compliance_revoked")
    assert headline["description"]


# --------------------------------------------------------------------------- #
# Ingestion (delegates to the shared engine pipeline)
# --------------------------------------------------------------------------- #
def test_ingest_adapters_are_listed_even_when_unseeded(client: TestClient) -> None:
    """The adapter catalogue is static metadata: it must work on an empty graph."""
    response = client.get("/api/ingest/adapters")
    assert response.status_code == 200
    assert response.json()["adapters"]


def test_ingest_rejects_an_invalid_record(client: TestClient) -> None:
    """Ingestion is implemented, so a malformed record is a 400 - not a 501."""
    response = client.post(
        "/api/ingest", json={"source": "slack", "record": {"channel": "#eu-launch"}}
    )
    assert response.status_code == 400
    body = response.json()
    assert body["error"] == "ingestion_error"
    assert body["details"]["missing_field"] == "external_id"


def test_ingest_accepts_a_valid_record(seeded: TestClient) -> None:
    """A well-formed record is ingested through the shared engine pipeline.

    The seeded fixture matters: the deterministic extractor anchors its patterns to
    entities already in the graph, so it has something to link against.
    """
    response = seeded.post(
        "/api/ingest",
        json={
            "source": "slack",
            "record": {
                "external_id": "test-msg-9001",
                "channel": "#data-compliance",
                "author": "Aisha Khan",
                "timestamp": "2026-03-01T09:00:00Z",
                "mentions": ["Frankfurt Hosting Partner"],
                "text": (
                    "Frankfurt Hosting Partner has revoked its EU compliance certification. "
                    "Flagging this for the launch review."
                ),
            },
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source"]["external_id"] == "test-msg-9001"
    assert body["source"]["adapter"] == "slack"
    assert body["extractor"]["name"] in ("deterministic", "llm")
    # Extracted claims are unverified candidates, never established truth.
    assert body["counts"]["needs_review"] >= 1
    assert body["events"]["ingestion_event_id"]
    assert all(claim["verified"] is False for claim in body["facts"])


def test_ingest_adapters_are_documented(client: TestClient) -> None:
    """The adapter catalogue is now served from the real ingestion module."""
    response = client.get("/api/ingest/adapters")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True
    names = {adapter["name"] for adapter in body["adapters"]}
    assert {"slack", "ticket", "prd", "meeting_note"} <= names
    for adapter in body["adapters"]:
        assert adapter["input_shape"], adapter["name"]
        assert adapter["integration_type"] == "file_or_webhook_record"


# --------------------------------------------------------------------------- #
# Error envelope / OpenAPI
# --------------------------------------------------------------------------- #
def test_error_envelope_shape_is_consistent(client: TestClient) -> None:
    for response in (
        client.get("/api/decisions/decision:nope/explanation"),
        client.get("/api/experts"),
        client.get("/api/alerts/alert:nope"),
    ):
        body = response.json()
        assert {"error", "message", "details"} <= set(body)
        assert isinstance(body["error"], str) and body["error"]
        assert isinstance(body["message"], str) and body["message"]
        assert isinstance(body["details"], dict)


def test_openapi_metadata(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    assert schema["info"]["title"] == "Tripwire API"
    assert any(p.startswith("/api/") for p in schema["paths"])
    # Every documented tag is referenced by at least one operation.
    tag_names = {t["name"] for t in schema.get("tags", [])}
    assert {"health", "demo", "alerts", "history", "ingest"} <= tag_names
