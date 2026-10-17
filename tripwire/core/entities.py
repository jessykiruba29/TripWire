"""Canonical entity listings for the supported entity kinds.

Why this module exists
----------------------
``GET /api/graph`` returns the whole graph, so a client *can* filter it to the
people or the decisions itself.  Doing that is wrong for two reasons:

1. it silently changes meaning - a graph payload is truncated by ``node_limit``,
   so a client-side "list the decisions" answer depends on how much of the graph
   happened to fit in the payload;
2. it duplicates the relationship semantics (who owns what, who contributed) in
   the client, where it drifts from the engine.

This module is the single source of truth for "what is this entity, and what is
it connected to".  It reads the same :class:`~tripwire.core.index.GraphIndex`
snapshot every other reasoning module reads, so the listings cannot disagree with
``explain_decision`` or ``find_experts``, and it defines no new relationship
semantics of its own.

Shape contract (mirrors the rest of the API):

* ``label`` is the node **kind** (``"Decision"``), ``type`` is a lowercase copy
  for renderers that key on ``type``, and ``name`` is the **human display name**.
* every listed node is a flattened :meth:`~tripwire.core.models.Node.to_view`
  (identity + every property inlined), with a small, uniform block of derived
  navigation fields added: ``summary``, ``state``, ``relations`` and
  ``related_ids``.
* no field is invented.  A relationship the graph does not record is simply
  absent from ``relations``, and ``counts`` always reflects the full match set
  rather than the returned page.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional, Sequence

from .errors import ValidationError
from .index import GraphIndex
from .models import Node

__all__ = [
    "ENTITY_KINDS",
    "DEFAULT_LIMIT",
    "MAX_LIMIT",
    "list_entities",
    "entity_detail",
    "entity_counts",
    "kind_for_label",
]


#: Public entity kind -> the graph node label that backs it.
#:
#: The order is the order the API documents the kinds in.  ``events`` covers both
#: ``Event`` and ``Alert`` nodes: an alert is a recorded signal about a change,
#: which is exactly what an event is, and the two are never listed separately
#: because a client that showed them twice would double-count the same incident.
ENTITY_KINDS: dict[str, tuple[str, ...]] = {
    "decisions": ("Decision",),
    "people": ("Person",),
    "projects": ("Project",),
    "systems": ("System",),
    "teams": ("Team",),
    "assumptions": ("Assumption",),
    "events": ("Event", "Alert"),
}

DEFAULT_LIMIT = 50
MAX_LIMIT = 500


def kind_for_label(label: str) -> Optional[str]:
    """Reverse lookup: which entity kind does a node label belong to?"""
    wanted = str(label or "").strip().lower()
    for kind, labels in ENTITY_KINDS.items():
        if any(candidate.lower() == wanted for candidate in labels):
            return kind
    return None


# --------------------------------------------------------------------------- #
# Derived fields
# --------------------------------------------------------------------------- #

#: ``(relation key, direction, relationships, human meaning)``
#:
#: ``direction`` is ``out`` when the listed entity is the edge *source* and ``in``
#: when it is the *target*, so the API reports the direction the graph actually
#: stores rather than a reinterpreted one.
_RELATION_RULES: dict[str, tuple[tuple[str, str, tuple[str, ...], str], ...]] = {
    "decisions": (
        ("assumes", "out", ("ASSUMES",), "assumptions this decision rests on"),
        ("made_by", "in", ("MADE",), "people who made this decision"),
        ("impacts", "out", ("IMPACTS",), "projects this decision affects"),
        ("depends_on", "out", ("DEPENDS_ON",), "decisions this one depends on"),
        ("alerts", "in", ("AFFECTS",), "alerts raised about this decision"),
    ),
    "people": (
        ("member_of", "out", ("ON_TEAM",), "the team this person is on"),
        ("owns", "out", ("OWNS",), "systems and projects this person officially owns"),
        ("made", "out", ("MADE",), "decisions this person made"),
        ("authored", "out", ("AUTHORED",), "sources this person wrote"),
        ("resolved", "out", ("RESOLVED",), "tickets this person resolved"),
        ("reviews", "out", ("REVIEWS",), "alerts this person was assigned to review"),
    ),
    "projects": (
        ("uses", "out", ("USES",), "systems this project uses"),
        ("affected_by", "in", ("IMPACTS",), "decisions whose impact lands on this project"),
        ("team", "in", ("PART_OF",), "the team this project belongs to"),
        ("owned_by", "in", ("OWNS",), "the official owner"),
    ),
    "systems": (
        ("used_by", "in", ("USES",), "projects that use this system"),
        ("owned_by", "in", ("OWNS",), "the official owner"),
        ("about", "in", ("ABOUT",), "facts recorded about this system"),
    ),
    "teams": (
        ("members", "in", ("ON_TEAM",), "people on this team"),
        ("projects", "out", ("PART_OF",), "projects owned by this team"),
    ),
    "assumptions": (
        ("assumed_by", "in", ("ASSUMES",), "decisions that assume this"),
        ("supported_by", "out", ("SUPPORTED_BY",), "facts that support this assumption"),
    ),
    "events": (
        ("about", "out", ("ABOUT",), "entities this event concerns"),
        ("triggered_by", "in", ("TRIGGERED_BY",), "the entity that triggered this event"),
        ("affected", "out", ("AFFECTS",), "entities this alert affects"),
    ),
}

#: Per-kind property that carries the headline text, most specific first.
_SUMMARY_KEYS: dict[str, tuple[str, ...]] = {
    "decisions": ("statement", "stale_reason", "summary"),
    "people": ("blurb", "role", "summary"),
    "projects": ("blurb", "summary"),
    "systems": ("blurb", "summary"),
    "teams": ("focus", "summary"),
    "assumptions": ("statement", "summary"),
    "events": ("summary", "title", "reason", "statement"),
}


def _first(props: Mapping[str, Any], keys: Iterable[str]) -> Optional[str]:
    """First non-empty property among ``keys``, as text."""
    for key in keys:
        value = props.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def _relations(index: GraphIndex, kind: str, node: Node) -> dict[str, Any]:
    """Every recorded relationship of the configured kinds, with real ids.

    A relation whose edge set is empty is omitted entirely, so a client can treat
    "the key is absent" as "the graph records no such relationship" - it never has
    to guess whether an empty list means "none" or "not computed".
    """
    out: dict[str, Any] = {}
    for key, direction, rels, meaning in _RELATION_RULES.get(kind, ()):
        if direction == "out":
            ids = index.targets(node.id, rels)
            edges = index.out(node.id, rels)
        else:
            ids = index.sources(node.id, rels)
            edges = index.incoming(node.id, rels)
        if not ids:
            continue
        out[key] = {
            "meaning": meaning,
            "direction": direction,
            "relationships": list(rels),
            "ids": list(ids),
            "labels": [index.label(node_id) for node_id in ids],
            "names": [index.name(node_id) for node_id in ids],
            "count": len(ids),
            "edges": [edge.to_view() for edge in edges],
        }
    return out


def _entity_view(index: GraphIndex, kind: str, node: Node) -> dict[str, Any]:
    """A flattened node view plus the derived navigation fields."""
    view = node.to_view()
    relations = _relations(index, kind, node)
    view["kind"] = kind
    view["summary"] = _first(node.props, _SUMMARY_KEYS.get(kind, ())) or node.name
    view["state"] = _state_of(kind, node)
    view["relations"] = relations
    view["related_ids"] = sorted(
        {related_id for relation in relations.values() for related_id in relation["ids"]}
    )
    return view


def _state_of(kind: str, node: Node) -> str:
    """The node's own recorded status, normalised to a lowercase label.

    Deliberately *not* a second state model: this is the value the graph stores
    (``POTENTIALLY_STALE``, ``ACTIVE``, ``CONTRADICTED`` …), lowercased so it can
    be compared without case games.  A node with no status is ``unknown``.
    """
    for key in ("status", "state", "event_type"):
        value = node.props.get(key)
        if value is not None and str(value).strip():
            return str(value).strip().lower()
    if kind == "events":
        return "recorded"
    return "unknown"


# --------------------------------------------------------------------------- #
# Filtering
# --------------------------------------------------------------------------- #


def _matches(node: Node, *, status: str | None, q: str | None, extra: Mapping[str, Any]) -> bool:
    if status:
        wanted = status.strip().lower()
        recorded = str(node.props.get("status") or "").strip().lower()
        if recorded != wanted:
            return False
    if q:
        needle = q.strip().lower()
        haystack = " ".join(
            [
                node.name or "",
                node.id,
                str(node.props.get("statement") or ""),
                str(node.props.get("summary") or ""),
                str(node.props.get("blurb") or ""),
                str(node.props.get("role") or ""),
                str(node.props.get("text") or ""),
                str(node.props.get("focus") or ""),
            ]
        ).lower()
        if needle not in haystack:
            return False
    for key, value in extra.items():
        if value is None:
            continue
        recorded = node.props.get(key)
        if recorded is None:
            return False
        if str(recorded).strip().lower() != str(value).strip().lower():
            return False
    return True


def _sort_key(index: GraphIndex, kind: str, node: Node) -> tuple[Any, ...]:
    """Deterministic ordering: most connected first, then label, then id.

    Connectivity-first is what makes a list endpoint useful without the client
    sorting: the decision that actually depends on something leads the list, and
    the ordering is stable across calls because it falls back to the id.
    """
    degree = len(index.out(node.id)) + len(index.incoming(node.id))
    if kind == "events":
        # Events are chronology, not connectivity.
        moment = str(node.props.get("timestamp") or node.props.get("recorded_at") or "")
        return (0, -_sortable_time(moment), node.label, node.id)
    return (1, -degree, node.label, node.id)


def _sortable_time(value: str) -> float:
    from .timeutil import parse_iso

    moment = parse_iso(value)
    return moment.timestamp() if moment is not None else 0.0


def _resolve_filter_key(kind: str, name: str) -> Optional[str]:
    """Which node property does a filter name address, if any?"""
    if name == "status":
        return "status"
    if name == "review_status":
        return "review_status"
    if name == "criticality":
        return "criticality"
    if name == "role":
        return "role"
    if name == "doc_type":
        return "doc_type"
    if name == "event_type" and kind == "events":
        return "event_type"
    if name == "owner_id":
        return "owner_id"
    if name == "team_id":
        return "team_id"
    return None


# --------------------------------------------------------------------------- #
# Public entry points
# --------------------------------------------------------------------------- #


def entity_counts(index: GraphIndex) -> dict[str, int]:
    """How many nodes of each entity kind the snapshot holds.

    Counted over the whole snapshot, never over a page, so a client can render
    "showing 50 of 137" without a second call.
    """
    counts = {kind: 0 for kind in ENTITY_KINDS}
    for node in index.nodes.values():
        kind = kind_for_label(node.label)
        if kind is not None:
            counts[kind] += 1
    return counts


def list_entities(
    index: GraphIndex,
    kind: str,
    *,
    status: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = DEFAULT_LIMIT,
    offset: int = 0,
    filters: Optional[Mapping[str, str]] = None,
) -> dict[str, Any]:
    """List one entity kind from a graph snapshot.

    Parameters
    ----------
    index:
        The snapshot to read.  Nothing is fetched or cached here.
    kind:
        One of :data:`ENTITY_KINDS`.  Anything else is a ``ValidationError``
        (mapped to HTTP 422 by the API layer, like every other vocabulary check).
    status:
        Exact, case-insensitive match on the node's recorded ``status``.
    q:
        Case-insensitive substring match over the display name, id and the
        text-bearing properties.
    limit, offset:
        Window into the full, deterministically sorted match set.
    filters:
        Extra ``property=value`` equality filters.  Only documented keys are
        accepted; an unknown key is a ``ValidationError`` rather than a silently
        ignored filter, because a filter that quietly does nothing is worse than
        an error.

    Returns
    -------
    dict
        ``{kind, label, total, count, limit, offset, filters, counts, items}``.
    """
    key = str(kind or "").strip().lower()
    if key not in ENTITY_KINDS:
        raise ValidationError(
            f"unknown entity kind {kind!r}; expected one of {sorted(ENTITY_KINDS)}",
            details={"kind": kind, "supported": sorted(ENTITY_KINDS)},
        )
    if limit < 0:
        raise ValidationError("limit must be >= 0", details={"limit": limit})
    if offset < 0:
        raise ValidationError("offset must be >= 0", details={"offset": offset})

    extra: dict[str, Any] = {}
    applied: dict[str, str] = {}
    for name, value in (filters or {}).items():
        if value is None or str(value) == "":
            continue
        resolved = _resolve_filter_key(key, name)
        if resolved is None:
            raise ValidationError(
                f"unknown filter {name!r} for entity kind {key!r}",
                details={"filter": name, "kind": key},
            )
        extra[resolved] = value
        applied[name] = str(value)

    nodes = index.of_label(ENTITY_KINDS[key])
    matched = [node for node in nodes if _matches(node, status=status, q=q, extra=extra)]
    matched.sort(key=lambda node: _sort_key(index, key, node))

    window = matched[offset : offset + limit] if limit else []
    return {
        "kind": key,
        "label": ENTITY_KINDS[key][0],
        "labels": list(ENTITY_KINDS[key]),
        "total": len(matched),
        "count": len(window),
        "limit": limit,
        "offset": offset,
        "filters": {
            "status": status,
            "q": q,
            **applied,
        },
        "counts": entity_counts(index),
        "items": [_entity_view(index, key, node) for node in window],
    }


def entity_detail(index: GraphIndex, kind: str, entity_id: str) -> dict[str, Any]:
    """One entity of the given kind, or ``{"found": False}``.

    The response is the same entity view the list returns, so a client can render
    a detail page from either call without a second shape.
    """
    key = str(kind or "").strip().lower()
    if key not in ENTITY_KINDS:
        raise ValidationError(
            f"unknown entity kind {kind!r}; expected one of {sorted(ENTITY_KINDS)}",
            details={"kind": kind, "supported": sorted(ENTITY_KINDS)},
        )
    node = index.node(entity_id)
    if node is None or node.label not in ENTITY_KINDS[key]:
        return {
            "found": False,
            "kind": key,
            "entity_id": entity_id,
            "reason": (
                f"{entity_id!r} is not present in the graph as "
                f"{' or '.join(ENTITY_KINDS[key])}."
            ),
        }
    return {
        "found": True,
        "kind": key,
        "entity_id": entity_id,
        "entity": _entity_view(index, key, node),
    }
