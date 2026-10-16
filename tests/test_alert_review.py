"""Alert review contract: transition metadata and note preservation.

Two frontend-facing defects are locked down here:

1. The alert payload did not advertise which status changes the engine accepts, so
   the frontend had to re-derive the status model and could offer buttons the API
   would reject with a 409.
2. Re-reviewing an alert with its *current* status returned early and threw the
   reviewer's note away, so a note-only review silently lost information.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tripwire.api.app import create_app
from tripwire.config import Settings
from tripwire.core.engine import GraphEngine
from tripwire.core.schema import ALERT_STATUS_TRANSITIONS
from tripwire.core.store import MemoryGraphStore


@pytest.fixture()
def client() -> TestClient:
    engine = GraphEngine(MemoryGraphStore(), settings=Settings(store_backend="memory"))
    application = create_app(engine)
    with TestClient(application) as test_client:
        test_client.post("/api/demo/seed")
        engine.trigger_event({"scenario": "frankfurt_compliance_revoked"})
        yield test_client


def _first_alert_id(client: TestClient) -> str:
    body = client.get("/api/alerts").json()
    alerts = body["alerts"]
    assert alerts, "the scenario must raise at least one alert"
    return alerts[0]["id"]


def test_alert_payload_advertises_allowed_transitions(client: TestClient) -> None:
    alert_id = _first_alert_id(client)
    body = client.get(f"/api/alerts/{alert_id}").json()

    assert "allowed_transitions" in body, "clients must not have to guess the status model"
    current = body["status"]
    assert current in body["allowed_transitions"], "a note-only review keeps the status"
    for status in body["allowed_transitions"]:
        if status == current:
            continue
        assert status in ALERT_STATUS_TRANSITIONS.get(current, ()), (
            f"{status!r} is advertised but the engine would reject it"
        )


def test_allowed_transitions_match_the_engine_not_a_copy(client: TestClient) -> None:
    """Every advertised transition must actually be accepted by the API."""
    alert_id = _first_alert_id(client)
    body = client.get(f"/api/alerts/{alert_id}").json()
    current = body["status"]

    for status in body["allowed_transitions"]:
        if status == current:
            continue
        response = client.post(
            f"/api/alerts/{alert_id}/review", json={"status": status, "note": "api probe"}
        )
        assert response.status_code == 200, (
            f"{current} -> {status} was advertised but returned {response.status_code}"
        )
        # Put the alert back so the next advertised transition is tested from `current`.
        restore = client.post(
            f"/api/alerts/{alert_id}/review", json={"status": current, "note": "restore"}
        )
        assert restore.status_code in (200, 409)


def test_same_status_review_keeps_the_note(client: TestClient) -> None:
    alert_id = _first_alert_id(client)
    before = client.get(f"/api/alerts/{alert_id}").json()
    current = before["status"]

    response = client.post(
        f"/api/alerts/{alert_id}/review",
        json={"status": current, "note": "Reviewed with legal; awaiting the vendor letter."},
    )
    assert response.status_code == 200

    after = client.get(f"/api/alerts/{alert_id}").json()
    assert after["status"] == current, "a note-only review must not change the status"
    assert after["review_note"] == "Reviewed with legal; awaiting the vendor letter.", (
        "the reviewer's note must be preserved"
    )

    history = client.get(f"/api/alerts/{alert_id}/history").json()
    notes = [
        entry for entry in history["history"] if entry.get("event_type") == "ALERT_REVIEW_NOTE"
    ]
    assert notes, "a note-only review must appear in the alert history"
    assert notes[-1]["note"] == "Reviewed with legal; awaiting the vendor letter."


def test_same_status_review_without_a_note_is_a_pure_no_op(client: TestClient) -> None:
    """Idempotency must still hold: no note means no new history entry."""
    alert_id = _first_alert_id(client)
    current = client.get(f"/api/alerts/{alert_id}").json()["status"]

    before = client.get(f"/api/alerts/{alert_id}/history").json()["history"]
    response = client.post(f"/api/alerts/{alert_id}/review", json={"status": current})
    assert response.status_code == 200

    after = client.get(f"/api/alerts/{alert_id}/history").json()["history"]
    assert len(after) == len(before), "a note-less same-status review must not append history"
