"""Substring search across the graph."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ...core.engine import GraphEngine
from ..deps import get_engine
from ..schemas import SearchResponse

router = APIRouter(tags=["search"])


@router.get(
    "/api/search",
    response_model=SearchResponse,
    summary="Substring search over node names and statements",
    description="Case-insensitive substring match across node names, ids and statement/text properties.",
)
def search(
    q: str = Query(..., min_length=1, description="Search text (required, non-empty)."),
    limit: int = Query(default=25, ge=1, le=200),
    engine: GraphEngine = Depends(get_engine),
) -> dict:
    """Return ``engine.search(q, limit=...)``."""
    return engine.search(q, limit=limit)
