"""Bitemporal history endpoints."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query

from ...core.engine import GraphEngine
from ..deps import get_engine
from ..schemas import (
    FactTimelineResponse,
    HistoryBeliefResponse,
    HistoryChangesResponse,
    HistoryValidResponse,
    SourceOfChangeResponse,
)

router = APIRouter(tags=["history"])


@router.get(
    "/api/history/belief",
    response_model=HistoryBeliefResponse,
    summary="What Tripwire believed at a transaction time",
    description="Answers 'what did we know on that date?' using the transaction-time clock.",
)
def history_belief(
    at: str = Query(..., description="Transaction time (ISO-8601)."),
    label: str = Query(default="Fact", description="Node label to reconstruct."),
    limit: int = Query(default=200, ge=1, le=1000),
    engine: GraphEngine = Depends(get_engine),
) -> dict:
    """Return ``engine.history_belief(at, label=..., limit=...)``."""
    return engine.history_belief(at, label=label, limit=limit)


@router.get(
    "/api/history/valid",
    response_model=HistoryValidResponse,
    summary="Which facts were true in the real world at an instant",
    description="Uses the real-world validity clock, independent of when Tripwire learned each fact.",
)
def history_valid(
    at: str = Query(..., description="Real-world instant (ISO-8601)."),
    subject_id: Optional[str] = Query(default=None),
    attribute: Optional[str] = Query(default=None),
    engine: GraphEngine = Depends(get_engine),
) -> dict:
    """Return ``engine.history_valid(at, subject_id=..., attribute=...)``."""
    return engine.history_valid(at, subject_id=subject_id, attribute=attribute)


@router.get(
    "/api/history/changes",
    response_model=HistoryChangesResponse,
    summary="What the system learned since a point in time",
    description="Facts recorded after `since`, plus the recorded events.",
)
def history_changes(
    since: str = Query(..., description="Transaction time (ISO-8601)."),
    engine: GraphEngine = Depends(get_engine),
) -> dict:
    """Return ``engine.history_changes(since)``."""
    return engine.history_changes(since)


@router.get(
    "/api/history/facts/{fact_id}",
    response_model=FactTimelineResponse,
    summary="Full timeline for a fact",
    description=(
        "Intervals (valid + transaction time), contradictions, recording events and "
        "sources for a fact.  Unknown ids return `found: false` with an empty timeline."
    ),
)
def history_fact(fact_id: str, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return ``engine.history_fact(fact_id)``."""
    return engine.history_fact(fact_id)


@router.get(
    "/api/history/facts/{fact_id}/source-of-change",
    response_model=SourceOfChangeResponse,
    summary="Which source changed the understanding of a fact",
    description=(
        "The `Message`/`Document` artifacts that state a fact (or the fact it "
        "contradicts), plus the events that recorded the change.  Unknown ids return "
        "`found: false`."
    ),
)
def history_source_of_change(fact_id: str, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return ``engine.history_source_of_change(fact_id)``."""
    return engine.history_source_of_change(fact_id)
