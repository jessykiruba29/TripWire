"""Alert feed, detail, history and review."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query

from ...core.engine import GraphEngine
from ..deps import get_engine
from ..schemas import (
    AlertDetail,
    AlertHistoryResponse,
    AlertListResponse,
    AlertReviewRequest,
    AlertReviewResponse,
)

router = APIRouter(tags=["alerts"])


@router.get(
    "/api/alerts",
    response_model=AlertListResponse,
    summary="Paginated alert feed",
    description=(
        "Filter by `status`, `entity_id` and `severity`.  The response echoes "
        "`limit`/`offset` and reports `total`, `count` and a `status_counts` "
        "histogram."
    ),
)
def list_alerts(
    status: Optional[str] = Query(default=None),
    entity_id: Optional[str] = Query(default=None),
    severity: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    engine: GraphEngine = Depends(get_engine),
) -> dict:
    """Return ``engine.alerts(...)``."""
    return engine.alerts(
        status=status, entity_id=entity_id, severity=severity, limit=limit, offset=offset
    )


@router.get(
    "/api/alerts/{alert_id}",
    response_model=AlertDetail,
    summary="Fetch a single alert",
    description="The alert plus the entities it may affect.  Unknown ids return 404.",
)
def get_alert(alert_id: str, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return ``engine.get_alert(alert_id)``."""
    return engine.get_alert(alert_id)


@router.get(
    "/api/alerts/{alert_id}/history",
    response_model=AlertHistoryResponse,
    summary="Append-only alert history",
    description="Every recorded status change for an alert, in order.  Unknown ids return 404.",
)
def alert_history(alert_id: str, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return ``engine.alert_history(alert_id)``."""
    return engine.alert_history(alert_id)


@router.post(
    "/api/alerts/{alert_id}/review",
    response_model=AlertReviewResponse,
    summary="Transition an alert",
    description=(
        "Enforces the documented status machine.  A same-status update is an "
        "idempotent no-op.  An invalid transition returns 409; an unknown status "
        "returns 422; an unknown alert returns 404."
    ),
)
def review_alert(
    alert_id: str, body: AlertReviewRequest, engine: GraphEngine = Depends(get_engine)
) -> dict:
    """Return ``engine.review_alert(...)``."""
    return engine.review_alert(
        alert_id, body.status, actor_id=body.actor_id, note=body.note
    )
