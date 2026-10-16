"""Contradiction detection."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ...core.engine import GraphEngine
from ..deps import get_engine
from ..schemas import ContradictionsRequest, ContradictionsResponse

router = APIRouter(tags=["reasoning"])


@router.post(
    "/api/contradictions/find",
    response_model=ContradictionsResponse,
    summary="Classify a fact against existing knowledge",
    description=(
        "Provide exactly one of `fact_id` (an existing fact) or `candidate` (a "
        "hypothetical `{subject, attribute, value}`).  The result classifies each "
        "candidate as contradiction / unverified / ambiguous / temporal / additive / "
        "unrelated.  This endpoint never writes."
    ),
)
def find_contradictions(
    body: ContradictionsRequest, engine: GraphEngine = Depends(get_engine)
) -> dict:
    """Return ``engine.find_contradictions(...)``."""
    candidate = body.candidate.model_dump(exclude_none=True) if body.candidate else None
    return engine.find_contradictions(
        fact_id=body.fact_id, candidate=candidate, use_llm=body.use_llm
    )
