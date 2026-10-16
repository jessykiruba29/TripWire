"""Contribution-based expert finding."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ...core.engine import GraphEngine
from ..deps import get_engine
from ..schemas import ExpertQueryRequest, ExpertReportResponse

router = APIRouter(tags=["experts"])


@router.get(
    "/api/experts",
    response_model=ExpertReportResponse,
    summary="Rank people by demonstrated contribution",
    description=(
        "Answers 'who actually understands this system?' as opposed to 'who owns it "
        "on the org chart'.  `q` is required.  Unknown targets return an empty "
        "ranking with an explanation rather than a fabricated one."
    ),
)
def experts(
    q: str = Query(..., min_length=1, description="System or project name/id."),
    limit: int = Query(default=5, ge=1, le=50),
    engine: GraphEngine = Depends(get_engine),
) -> dict:
    """Return ``engine.find_experts(q, limit=...)``."""
    return engine.find_experts(q, limit=limit)


@router.post(
    "/api/experts/query",
    response_model=ExpertReportResponse,
    summary="Convenience POST for the expert query",
    description="Identical behaviour to `GET /api/experts`, for clients that prefer a body.",
)
def experts_query(body: ExpertQueryRequest, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return ``engine.find_experts(body.query, limit=body.limit)``."""
    return engine.find_experts(body.query, limit=body.limit)
