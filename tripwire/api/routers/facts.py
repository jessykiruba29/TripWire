"""Fact change explanations."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ...core.engine import GraphEngine
from ...core.errors import NotFoundError
from ..deps import get_engine
from ..schemas import FactExplanationResponse

router = APIRouter(tags=["facts"])


@router.get(
    "/api/facts/{fact_id}/explanation",
    response_model=FactExplanationResponse,
    summary="Explain a fact change",
    description=(
        "What a fact contradicts (or is contradicted by), its provenance and the "
        "entities it affected.  Unknown ids return 404."
    ),
)
def explain_fact(fact_id: str, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return ``engine.explain_fact(fact_id)``."""
    result = engine.explain_fact(fact_id)
    if not result.get("found", True):
        raise NotFoundError(f"fact {fact_id!r} does not exist", details={"fact_id": fact_id})
    return result
