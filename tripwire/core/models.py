"""Core graph value objects.

``Node`` and ``Edge`` are intentionally small, immutable-ish records:

* ``Node`` - ``id``, ``label`` (one of :data:`tripwire.core.schema.NODE_TYPES`),
  ``name`` and a free-form ``props`` mapping.
* ``Edge`` - ``src``, ``rel``, ``dst`` and a free-form ``props`` mapping.  The
  triple ``(src, rel, dst)`` is the edge's identity, which makes relationship
  upserts idempotent: re-seeding adds no duplicate edges.

Documented property conventions live in :mod:`tripwire.core.schema` and
``docs/GRAPH_SCHEMA.md``.  The most important ones, present on the node types
where they are meaningful:

``valid_from`` / ``valid_to``
    Real-world validity interval - when the claim was true.
``recorded_at`` / ``recorded_to``
    Transaction-time interval - when Tripwire believed it.
``confidence``
    ``0.0``-``1.0`` extraction/verdict confidence.
``review_status``
    One of :data:`tripwire.core.schema.REVIEW_STATUSES`.
``source_ref``
    Provider locator (``slack:#eu-launch``, ``jira:NWL-412``) for provenance.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Mapping, Optional

from .schema import (
    REL_TYPES,
    NODE_TYPES,
    SchemaError,
    sanitize_props,
    validate_edge_payload,
    validate_node_payload,
)

__all__ = ["Node", "Edge", "Subgraph", "PathStep", "EvidencePath"]

# Properties that, once set, must not be silently overwritten by a re-upsert.
# ``recorded_at`` is the transaction time the system first learned something:
# re-ingesting the same source must not pretend Tripwire learned it today.
IMMUTABLE_ONCE_SET = ("created_at", "recorded_at", "first_seen_at")


@dataclass
class Node:
    """A graph vertex."""

    id: str
    label: str
    name: str
    props: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.props = sanitize_props(self.props)
        validate_node_payload(self.label, self.id, self.name, self.props)

    # -- property access -------------------------------------------------- #
    def get(self, key: str, default: Any = None) -> Any:
        """Read a property (``id``/``label``/``name`` resolve to real fields)."""
        if key in ("id", "label", "name"):
            return getattr(self, key)
        return self.props.get(key, default)

    def set(self, key: str, value: Any) -> None:
        """Set a single property, sanitising the value."""
        merged = sanitize_props({**self.props, key: value})
        self.props = merged

    def as_dict(self) -> dict[str, Any]:
        """Full serialisable form used by the API and JSON persistence."""
        return {"id": self.id, "label": self.label, "name": self.name, "props": dict(self.props)}

    def to_view(self) -> dict[str, Any]:
        """Flattened API/frontend shape: properties inlined alongside identity.

        The frontend graph renderer wants a flat payload, so ``label``/``type``
        and every property sit at the top level.  ``type`` duplicates ``label``
        for renderers that use the more common ``type`` key.
        """
        flattened = {"id": self.id, "label": self.label, "type": self.label, "name": self.name}
        flattened.update(self.props)
        return flattened

    def merge(self, other: "Node") -> "Node":
        """Merge ``other`` into this node, returning a new node.

        Rules:
        * ``other``'s non-``None`` properties win (later knowledge supersedes).
        * ``IMMUTABLE_ONCE_SET`` keys are never overwritten once present.
        * ``None`` values never erase existing data.
        """
        if other.label != self.label:
            raise SchemaError(
                f"cannot merge {other.label} {other.id!r} into {self.label} {self.id!r}"
            )
        merged = dict(self.props)
        for key, value in other.props.items():
            if value is None:
                continue
            if key in IMMUTABLE_ONCE_SET and merged.get(key) is not None:
                continue
            merged[key] = value
        if self.name == self.id and other.name:
            name = other.name
        else:
            name = other.name or self.name
        return Node(id=self.id, label=self.label, name=name, props=merged)

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "Node":
        """Rebuild a node from :meth:`as_dict` output, or a flattened view."""
        if "props" in payload:
            return cls(
                id=str(payload["id"]),
                label=str(payload.get("label") or payload.get("type")),
                name=str(payload.get("name") or payload["id"]),
                props=dict(payload.get("props") or {}),
            )
        props = {
            key: value
            for key, value in payload.items()
            if key not in ("id", "label", "type", "name")
        }
        return cls(
            id=str(payload["id"]),
            label=str(payload.get("label") or payload.get("type")),
            name=str(payload.get("name") or payload["id"]),
            props=props,
        )


@dataclass
class Edge:
    """A directed, typed graph edge; ``(src, rel, dst)`` is its identity."""

    src: str
    rel: str
    dst: str
    props: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.props = sanitize_props(self.props)
        validate_edge_payload(self.rel, self.src, self.dst)

    @property
    def key(self) -> tuple[str, str, str]:
        """Identity triple used for idempotent upserts."""
        return (self.src, self.rel, self.dst)

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form used by the API and JSON persistence."""
        return {"src": self.src, "rel": self.rel, "dst": self.dst, "props": dict(self.props)}

    def to_view(self) -> dict[str, Any]:
        """Flattened API/frontend shape for an edge."""
        flattened = {"id": f"{self.src}|{self.rel}|{self.dst}", "source": self.src,
                     "target": self.dst, "rel": self.rel, "type": self.rel}
        flattened.update(self.props)
        return flattened

    def get(self, key: str, default: Any = None) -> Any:
        """Read an edge property."""
        return self.props.get(key, default)

    def merge(self, other: "Edge") -> "Edge":
        """Merge ``other`` into this edge (non-``None`` values win)."""
        if other.key != self.key:
            raise SchemaError(f"cannot merge edge {other.key} into {self.key}")
        merged = dict(self.props)
        for key, value in other.props.items():
            if value is not None:
                merged[key] = value
        return Edge(src=self.src, rel=self.rel, dst=self.dst, props=merged)

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "Edge":
        """Rebuild from :meth:`as_dict` output or a flattened view."""
        if "props" in payload:
            props = dict(payload.get("props") or {})
        else:
            props = {
                key: value
                for key, value in payload.items()
                if key not in ("id", "source", "target", "src", "dst", "rel", "type")
            }
        return cls(
            src=str(payload.get("src") or payload.get("source")),
            rel=str(payload.get("rel") or payload.get("type")),
            dst=str(payload.get("dst") or payload.get("target")),
            props=props,
        )


@dataclass
class PathStep:
    """One hop of an evidence path, resolved to displayable records."""

    src: str
    rel: str
    dst: str
    src_name: Optional[str] = None
    dst_name: Optional[str] = None
    src_label: Optional[str] = None
    dst_label: Optional[str] = None
    props: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form."""
        return {
            "src": self.src,
            "rel": self.rel,
            "dst": self.dst,
            "src_name": self.src_name,
            "dst_name": self.dst_name,
            "src_label": self.src_label,
            "dst_label": self.dst_label,
            "props": dict(self.props),
        }

    def describe(self) -> str:
        """Human-readable hop, e.g. ``EU Launch (Decision) -[ASSUMES]-> ...``."""
        left = f"{self.src_name or self.src} ({self.src_label or '?'})"
        right = f"{self.dst_name or self.dst} ({self.dst_label or '?'})"
        return f"{left} -[{self.rel}]-> {right}"


@dataclass
class EvidencePath:
    """An ordered chain of hops from a root entity to a downstream entity."""

    steps: list[PathStep] = field(default_factory=list)

    @property
    def node_ids(self) -> list[str]:
        """Every node id touched by the path, in traversal order."""
        if not self.steps:
            return []
        ids = [self.steps[0].src]
        ids.extend(step.dst for step in self.steps)
        return ids

    @property
    def rels(self) -> list[str]:
        """Relationship types along the path."""
        return [step.rel for step in self.steps]

    @property
    def key(self) -> tuple[str, ...]:
        """Structural identity used to de-duplicate paths (spec S7)."""
        return tuple(f"{step.src}|{step.rel}|{step.dst}" for step in self.steps)

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form, including a rendered one-line explanation."""
        return {
            "nodes": self.node_ids,
            "rels": self.rels,
            "length": len(self.steps),
            "steps": [step.as_dict() for step in self.steps],
            "narrative": self.narrative(),
        }

    def narrative(self) -> str:
        """Readable rendering of the whole path."""
        return " -> ".join(
            [self.steps[0].src_name or self.steps[0].src]
            + [f"-[{s.rel}]-> {s.dst_name or s.dst}" for s in self.steps]
        ) if self.steps else ""


@dataclass
class Subgraph:
    """A node/edge container - used for API responses and export/import."""

    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)

    def __iter__(self) -> Iterator[Any]:
        yield from self.nodes
        yield from self.edges

    def node_ids(self) -> set[str]:
        """Set of node ids present."""
        return {node.id for node in self.nodes}

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form with flattened views for the frontend."""
        return {
            "nodes": [node.to_view() for node in self.nodes],
            "edges": [edge.to_view() for edge in self.edges],
        }

    def subgraph_for(self, node_ids: Iterable[str]) -> "Subgraph":
        """Induced subgraph: keep the given nodes and edges wholly inside them."""
        keep = set(node_ids)
        return Subgraph(
            nodes=[node for node in self.nodes if node.id in keep],
            edges=[edge for edge in self.edges if edge.src in keep and edge.dst in keep],
        )


def coerce_props(value: Mapping[str, Any] | None) -> dict[str, Any]:
    """Public helper mirroring :func:`tripwire.core.schema.sanitize_props`."""
    return sanitize_props(value or {})


def assert_known_label(label: str) -> None:
    """Raise :class:`SchemaError` when ``label`` is not a known node type."""
    if label not in NODE_TYPES:
        raise SchemaError(f"unknown node type {label!r}")


def assert_known_rel(rel: str) -> None:
    """Raise :class:`SchemaError` when ``rel`` is not a known relationship."""
    if rel not in REL_TYPES:
        raise SchemaError(f"unknown relationship type {rel!r}")
