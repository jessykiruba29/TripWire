"""Staleness propagation."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ...core.engine import GraphEngine
from ...core.errors import NotFoundError
from ..deps import get_engine
from ..schemas import PropagationResponse, StalenessRequest

router = APIRouter(tags=["reasoning"])


@router.post(
    "/api/staleness/propagate",
    response_model=PropagationResponse,
    summary="Plan (and optionally apply) staleness propagation",
    description=(
        "Plans which decisions and projects are affected when `fact_id` changes. "
        "With `dry_run: true` (the default) the plan is returned and **nothing is "
        "written**.  With `dry_run: false` the plan is applied: affected decisions "
        "are flagged `POTENTIALLY_STALE` (never `STALE`) and alerts are raised.  "
        "Unknown fact ids return 404."
    ),
)
def propagate(body: StalenessRequest, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Plan propagation via the engine; apply it only when not a dry run."""
    if engine.store.get_node(body.fact_id) is None:
        raise NotFoundError(
            f"fact {body.fact_id!r} does not exist", details={"fact_id": body.fact_id}
        )
    plan = engine.plan_staleness(body.fact_id, max_depth=body.max_depth)
    payload = plan.as_dict()
    if body.dry_run:
        return {**payload, "dry_run": True, "applied": False}
    applied = engine.apply_staleness(plan)
    return {
        **payload,
        "dry_run": False,
        "applied": True,
        "applied_summary": applied,
        "impacts": applied.get("impacts", []),
        "alert_ids": sorted(
            {
                impact["alert"]["alert_id"]
                for impact in applied.get("impacts", [])
                if impact.get("alert")
            }
        ),
    }
