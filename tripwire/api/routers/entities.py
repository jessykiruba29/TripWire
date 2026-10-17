"""Dedicated entity-list endpoints: decisions, people, projects, systems, teams,
assumptions and events.

Why these routes exist
----------------------
``GET /api/graph`` returns the whole graph, so a client *could* filter it down to
the decisions itself.  That is wrong for the reasons documented in
:mod:`tripwire.core.entities`: the graph payload is truncated by ``node_limit``,
and re-deriving relationships in the client duplicates engine semantics.  Every
route here delegates to :func:`tripwire.core.entities.list_entities` /
``entity_detail``, which read the same :class:`~tripwire.core.index.GraphIndex`
snapshot as ``explain_decision`` and ``find_experts`` - one source of truth.

Conventions preserved from the rest of the API:

* flat resource paths (``/api/sources``, ``/api/alerts``, ... -> ``/api/people``);
* pagination envelope with ``total`` / ``count`` / ``limit`` / ``offset``;
* errors use the shared envelope: unknown kind or filter -> 422, unknown entity
  id -> 404, store failures -> 503, all raised by the existing error taxonomy;
* response models are permissive (``extra="allow"``) so engine-owned fields are
  preserved verbatim.

Every route is registered *after* the specific routers in ``_ROUTERS``, and each
path is explicit (``/api/decisions``, never a catch-all ``/api/{kind}``), so no
existing route can be shadowed.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query, Request

from ...core.engine import GraphEngine
from ...core.entities import ENTITY_KINDS, entity_detail, list_entities
from ...core.errors import NotFoundError
from ..deps import get_engine
from ..schemas import EntityDetailResponse, EntityIndexResponse, EntityListResponse

router = APIRouter(tags=["entities"])

#: Query parameters this API owns; anything else is forwarded to the core as an
#: equality filter (and rejected there with a 422 when undocumented).
_RESERVED_QUERY_KEYS = frozenset({"status", "q", "limit", "offset"})

#: One-line purpose per kind, used for route summaries and the index endpoint.
_KIND_SUMMARIES: dict[str, str] = {
    "decisions": "Decisions the company has made, with their recorded status.",
    "people": "People recorded in the graph (authors, owners, reviewers, contributors).",
    "projects": "Projects and initiatives decisions can impact.",
    "systems": "Systems and services projects use and people own.",
    "teams": "Teams, with their members and owned projects.",
    "assumptions": "Assumptions decisions rest on, with their supporting facts.",
    "events": "Recorded events and alerts, newest first.",
}

_DETAIL_DESCRIPTION = (
    "One entity of this kind flattened into the same view the list endpoint "
    "returns (`label` = node kind, `name` = display name, plus derived "
    "`summary`, `state`, `relations`, `related_ids`).  An unknown id, or an id "
    "that exists under a different label, returns 404 with the standard error "
    "envelope."
)


def _extra_filters(request: Request) -> dict[str, str]:
    """Undocumented query parameters, forwarded to the core as equality filters.

    The core decides which filter names are valid for a kind and raises
    ``ValidationError`` (HTTP 422) for anything else, so a filter that quietly
    does nothing can never reach a client.
    """
    return {
        key: value
        for key, value in request.query_params.multi_items()
        if key not in _RESERVED_QUERY_KEYS
    }


def _list_kind(
    kind: str,
    request: Request,
    status: Optional[str],
    q: Optional[str],
    limit: int,
    offset: int,
    engine: GraphEngine,
) -> dict:
    """Shared implementation for ``GET /api/{kind}``."""
    return list_entities(
        engine.index(),
        kind,
        status=status,
        q=q,
        limit=limit,
        offset=offset,
        filters=_extra_filters(request),
    )


def _detail_kind(kind: str, entity_id: str, engine: GraphEngine) -> dict:
    """Shared implementation for ``GET /api/{kind}/{entity_id}``."""
    result = entity_detail(engine.index(), kind, entity_id)
    if not result.get("found"):
        raise NotFoundError(
            result.get("reason") or f"entity {entity_id!r} does not exist",
            details={"kind": kind, "entity_id": entity_id},
        )
    return result


def _add_kind_routes(kind: str) -> None:
    """Register the list and detail routes for one entity kind."""
    summary = _KIND_SUMMARIES[kind]

    def list_handler(
        request: Request,
        status: Optional[str] = Query(
            default=None, description="Exact, case-insensitive match on the recorded status."
        ),
        q: Optional[str] = Query(
            default=None, min_length=1,
            description="Case-insensitive substring over name, id and text properties.",
        ),
        limit: int = Query(default=50, ge=1, le=500, description="Page size."),
        offset: int = Query(default=0, ge=0, description="Page start into the sorted match set."),
        engine: GraphEngine = Depends(get_engine),
    ) -> dict:
        """List one entity kind from a fresh graph snapshot."""
        return _list_kind(kind, request, status, q, limit, offset, engine)

    list_handler.__name__ = f"list_{kind}"
    list_handler.__doc__ = (
        f"Return ``list_entities(..., kind={kind!r})``: deterministic ordering "
        "(most connected first, except events which are newest first), "
        "snapshot-wide counts, and the recorded relationships of each item."
    )
    router.get(
        f"/api/{kind}",
        response_model=EntityListResponse,
        summary=f"List {kind}",
        description=(
            f"{summary}  Paginated with `total`, `count`, `limit`, `offset` and a "
            "snapshot-wide `counts` histogram.  Query parameters: `status`, `q`, "
            "`limit`, `offset`, plus this kind's documented equality filters "
            "(unknown filters are rejected with 422)."
        ),
    )(list_handler)

    def detail_handler(
        entity_id: str, engine: GraphEngine = Depends(get_engine)
    ) -> dict:
        """Fetch one entity of this kind by canonical id."""
        return _detail_kind(kind, entity_id, engine)

    detail_handler.__name__ = f"get_{kind[:-1] if kind.endswith('s') else kind}_entity"
    detail_handler.__doc__ = f"Return ``entity_detail(..., kind={kind!r}, entity_id=...)``."
    router.get(
        f"/api/{kind}/{{entity_id}}",
        response_model=EntityDetailResponse,
        summary=f"One {kind[:-1] if kind.endswith('s') else kind}",
        description=_DETAIL_DESCRIPTION,
    )(detail_handler)


for _kind in ENTITY_KINDS:
    _add_kind_routes(_kind)
del _kind


@router.get(
    "/api/entities",
    response_model=EntityIndexResponse,
    summary="Entity-kind index with snapshot-wide counts",
    description=(
        "Every supported entity kind with its node label(s) and how many nodes "
        "of that kind the current snapshot holds.  Counts cover the whole "
        "snapshot, so a client can render navigation badges without paging "
        "through each list."
    ),
)
def entity_index(engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return ``{total, counts, kinds}`` for the current snapshot."""
    index = engine.index()
    counts: dict[str, int] = {}
    for kind, labels in ENTITY_KINDS.items():
        counts[kind] = len(index.of_label(labels))
    return {
        "total": sum(counts.values()),
        "counts": counts,
        "kinds": [
            {
                "kind": kind,
                "labels": list(labels),
                "label": labels[0],
                "summary": _KIND_SUMMARIES[kind],
                "count": counts[kind],
                "path": f"/api/{kind}",
            }
            for kind, labels in ENTITY_KINDS.items()
        ],
    }
