"""Source artifacts (Message / Document nodes) and the facts they state."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query

from ...core.engine import GraphEngine
from ...core.errors import NotFoundError
from ..deps import get_engine
from ..schemas import SourceDetailResponse, SourceListResponse

router = APIRouter(tags=["sources"])

_SOURCE_LABELS = ("Message", "Document")


def _matches_type(node, wanted: str) -> bool:
    """True when ``wanted`` names the node label, source system or doc_type."""
    text = wanted.strip().lower()
    if not text:
        return True
    return text in {
        str(node.label).lower(),
        str(node.props.get("source_system") or "").lower(),
        str(node.props.get("doc_type") or "").lower(),
    }


@router.get(
    "/api/sources",
    response_model=SourceListResponse,
    summary="List source artifacts",
    description=(
        "Paginated `Message` and `Document` nodes with an optional `type` filter "
        "matching the node label, source system or document type."
    ),
)
def list_sources(
    type: Optional[str] = Query(default=None, description="Label, source system or doc_type."),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    engine: GraphEngine = Depends(get_engine),
) -> dict:
    """List source artifacts from a fresh graph snapshot."""
    index = engine.index()
    nodes = index.of_label(_SOURCE_LABELS)
    if type:
        nodes = [node for node in nodes if _matches_type(node, type)]
    total = len(nodes)
    window = nodes[offset : offset + limit]
    return {
        "total": total,
        "count": len(window),
        "limit": limit,
        "offset": offset,
        "sources": [node.to_view() for node in window],
    }


@router.get(
    "/api/sources/{source_id}",
    response_model=SourceDetailResponse,
    summary="One source artifact with the facts it states",
    description="Returns the artifact and every `Fact` it `STATES`.",
)
def get_source(source_id: str, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return a single source artifact plus its stated facts."""
    index = engine.index()
    node = index.node(source_id)
    if node is None or node.label not in _SOURCE_LABELS:
        raise NotFoundError(
            f"source artifact {source_id!r} does not exist",
            details={"source_id": source_id},
        )
    fact_ids = index.targets(source_id, ["STATES"])
    states = [
        stated.to_view()
        for stated in (index.node(fact_id) for fact_id in fact_ids)
        if stated is not None
    ]
    return {"source": node.to_view(), "states": states, "states_count": len(states)}
