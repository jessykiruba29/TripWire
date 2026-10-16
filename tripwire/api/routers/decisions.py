"""Decision explanations, status changes and historical dependencies."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ...core.engine import GraphEngine
from ...core.errors import NotFoundError
from ..deps import get_engine
from ..schemas import (
    DecisionExplanationResponse,
    DecisionStatusRequest,
    DecisionStatusResponse,
    DependenciesResponse,
)

router = APIRouter(tags=["decisions"])


@router.get(
    "/api/decisions/{decision_id}/explanation",
    response_model=DecisionExplanationResponse,
    summary="Explain a decision",
    description=(
        "Assumptions, supporting facts, evidence paths, alerts, surviving "
        "alternate evidence and the people behind a decision.  Unknown ids return "
        "404."
    ),
)
def explain_decision(decision_id: str, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return ``engine.explain_decision(decision_id)``."""
    result = engine.explain_decision(decision_id)
    if not result.get("found", True):
        raise NotFoundError(
            f"decision {decision_id!r} does not exist", details={"decision_id": decision_id}
        )
    return result


@router.post(
    "/api/decisions/{decision_id}/status",
    response_model=DecisionStatusResponse,
    summary="Change a decision status through an audited path",
    description=(
        "Validated against the decision status vocabulary.  Moving a decision to "
        "`STALE` requires `confirm: true` - Tripwire never invalidates a decision "
        "automatically.  Unknown ids return 404; an unknown status returns 422 and "
        "an unconfirmed STALE request returns 422."
    ),
)
def set_decision_status(
    decision_id: str,
    body: DecisionStatusRequest,
    engine: GraphEngine = Depends(get_engine),
) -> dict:
    """Return ``engine.set_decision_status(...)``."""
    return engine.set_decision_status(
        decision_id,
        body.status,
        actor_id=body.actor_id,
        note=body.note,
        confirm=body.confirm,
    )


@router.get(
    "/api/decisions/{decision_id}/dependencies",
    response_model=DependenciesResponse,
    summary="What a decision depended on at a transaction time",
    description=(
        "Bitemporal view: the assumptions and supporting facts the decision rested "
        "on at the given `at` transaction time.  Links added later do not appear in "
        "an earlier snapshot.  Unknown ids return 404."
    ),
)
def decision_dependencies(
    decision_id: str,
    at: str = Query(..., description="Transaction time (ISO-8601)."),
    engine: GraphEngine = Depends(get_engine),
) -> dict:
    """Return ``engine.history_dependencies(decision_id, at)``."""
    result = engine.history_dependencies(decision_id, at)
    if not result.get("found", True):
        raise NotFoundError(
            f"decision {decision_id!r} does not exist", details={"decision_id": decision_id}
        )
    return result
