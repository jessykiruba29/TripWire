"""Demo lifecycle: state, trigger-event, seed and reset."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends

from ...core.engine import GraphEngine
from ..deps import get_engine
from ..schemas import (
    DemoStateResponse,
    SeedRequest,
    SeedResponse,
    TriggerEventRequest,
    TriggerEventResponse,
)

router = APIRouter(tags=["demo"])


@router.get(
    "/api/demo/state",
    response_model=DemoStateResponse,
    summary="Full demonstration status",
    description=(
        "Store backend and health, dataset manifest vs. actual counts, alert "
        "histogram, bitemporal history summary, key entity ids and the public "
        "(secret-free) configuration summary."
    ),
)
def demo_state(engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return ``engine.demo_state()``."""
    return engine.demo_state()


@router.post(
    "/api/demo/trigger-event",
    response_model=TriggerEventResponse,
    summary="Run the contradiction -> propagation -> alert flow",
    description=(
        "Accepts either `{'scenario': '<name>'}` for a deterministic offline demo "
        "event or an explicit `{'new_fact': {...}, 'source': {...}}` payload. "
        "`apply` defaults to true.  Every step is idempotent, so replaying an "
        "event produces no duplicates."
    ),
)
def trigger_event(body: TriggerEventRequest, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Forward the payload to ``engine.trigger_event``."""
    payload = body.model_dump(exclude_none=True)
    return engine.trigger_event(payload, apply=True)


@router.post(
    "/api/demo/seed",
    response_model=SeedResponse,
    summary="Seed the deterministic Northwind Labs dataset",
    description="Idempotent: re-seeding writes no new nodes or edges unless `force` is set.",
)
def seed_demo(
    body: Optional[SeedRequest] = None, engine: GraphEngine = Depends(get_engine)
) -> dict:
    """Return ``engine.seed_demo(force=...)``."""
    force = bool(body.force) if body else False
    return engine.seed_demo(force=force)


@router.post(
    "/api/demo/reset",
    response_model=SeedResponse,
    summary="Reset to the pristine demonstration state",
    description="Clears the graph and re-seeds the Northwind Labs dataset (always a forced re-seed).",
)
def reset(body: Optional[SeedRequest] = None, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return ``engine.reset()``."""
    return engine.reset()
