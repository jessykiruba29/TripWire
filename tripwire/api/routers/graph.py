"""Graph payload and relationship-path lookups."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query

from ...core.engine import GraphEngine
from ..deps import get_engine
from ..schemas import GraphResponse, PathResponse

router = APIRouter(tags=["graph"])


@router.get(
    "/api/graph",
    response_model=GraphResponse,
    summary="Serialisable graph payload",
    description=(
        "Nodes and edges as flattened views for the frontend.  `label` may be "
        "repeated to keep only those node types.  `around` + `depth` restrict the "
        "payload to a neighbourhood of one node.  `meta` reports totals and whether "
        "the payload was truncated."
    ),
)
def graph(
    label: Optional[list[str]] = Query(default=None, description="Node type filter (repeatable)."),
    node_limit: Optional[int] = Query(default=None, ge=0),
    edge_limit: Optional[int] = Query(default=None, ge=0),
    around: Optional[str] = Query(default=None, description="Focus node id."),
    depth: int = Query(default=1, ge=0, le=6),
    include_alerts: bool = Query(default=True),
    engine: GraphEngine = Depends(get_engine),
) -> dict:
    """Return ``engine.graph_payload(...)``."""
    return engine.graph_payload(
        labels=label,
        node_limit=node_limit,
        edge_limit=edge_limit,
        around=around,
        depth=depth,
        include_alerts=include_alerts,
    )


@router.get(
    "/api/paths",
    response_model=PathResponse,
    summary="Relationship paths between two entities",
    description=(
        "Bounded, cycle-safe simple paths between `source` and `target`.  Reports "
        "`found: false` with a reason when the graph connects them by nothing - it "
        "never fabricates a path."
    ),
)
def paths(
    source: str = Query(..., description="Source node id."),
    target: str = Query(..., description="Target node id."),
    max_depth: int = Query(default=6, ge=1, le=10),
    rel: Optional[list[str]] = Query(default=None, description="Relationship filter (repeatable)."),
    engine: GraphEngine = Depends(get_engine),
) -> dict:
    """Return ``engine.explain_path(...)``."""
    return engine.explain_path(source, target, rels=rel, max_depth=max_depth)
