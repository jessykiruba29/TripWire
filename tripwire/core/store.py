"""Graph store abstraction and the in-process / JSON-backed implementations.

Why an abstraction
------------------
Tripwire must run in three environments: a FalkorDB container (the target
architecture), a plain developer machine without Docker, and CI.  Rather than
maintaining a *second* graph-reasoning implementation for each, the codebase
draws one hard boundary:

* **Stores** implement six primitive operations (``upsert_node``, ``upsert_edge``,
  ``delete_node``, ``delete_edge``, ``get_node``, ``get_nodes``, ``get_edges``,
  ``clear``).
* **All reasoning** - contradiction detection, staleness propagation, explanation,
  expert ranking - lives in plain Python *above* that boundary and is therefore
  shared verbatim by every backend.

The FalkorDB adapter (``tripwire.core.falkor_store``) additionally exposes an
optimised native Cypher traversal for staleness propagation.  The Python engine
stays authoritative, and ``tests/test_falkor_parity.py`` asserts the native
query returns exactly the same decisions as the shared implementation.

Read semantics
--------------
* ``where`` filters match node properties by equality; a list value means
  "property is one of", and the special key ``__type__`` matches the label.
* Results are always **deterministically ordered** (by label then id, edges by
  ``src``/``rel``/``dst``) so seeds, tests and API responses are reproducible.
* ``limit``/``offset`` implement pagination at the store level.

Write semantics
---------------
``upsert_*`` merges rather than replaces (see :meth:`Node.merge`), which is what
makes seeding idempotent: running the seeder twice changes no counts (spec S13).
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from abc import ABC, abstractmethod
from contextlib import contextmanager
from typing import Any, Iterable, Iterator, Mapping, Optional, Sequence

from .models import Edge, Node, Subgraph

__all__ = [
    "GraphStore",
    "MemoryGraphStore",
    "JsonGraphStore",
    "create_store",
    "normalize_where",
]


# --------------------------------------------------------------------------- #
# Filter helpers
# --------------------------------------------------------------------------- #
def _matches(value: Any, expected: Any) -> bool:
    """Equality / membership match supporting lists and ``None``."""
    if expected is None:
        return value is None
    if isinstance(expected, (list, tuple, set)):
        return value in expected
    return value == expected


def normalize_where(where: Mapping[str, Any] | None) -> dict[str, Any]:
    """Validate and copy a ``where`` mapping.

    ``__type__`` is translated to the node label by the store, so callers can
    write uniform filters without special-casing labels.
    """
    if not where:
        return {}
    normalized: dict[str, Any] = {}
    for key, value in where.items():
        if not isinstance(key, str) or not key:
            raise ValueError(f"where keys must be non-empty strings, got {key!r}")
        normalized[key] = value
    return normalized


def _node_matches(node: Node, where: Mapping[str, Any]) -> bool:
    """True when ``node`` satisfies every ``where`` clause."""
    for key, expected in where.items():
        if key == "__type__":
            if not _matches(node.label, expected):
                return False
        elif key in ("id", "label", "name"):
            if not _matches(getattr(node, key), expected):
                return False
        else:
            if not _matches(node.props.get(key), expected):
                return False
    return True


def _edge_matches(edge: Edge, where: Mapping[str, Any]) -> bool:
    """True when ``edge`` satisfies every ``where`` clause."""
    for key, expected in where.items():
        if key in ("src", "rel", "dst"):
            if not _matches(getattr(edge, key), expected):
                return False
        else:
            if not _matches(edge.props.get(key), expected):
                return False
    return True


# --------------------------------------------------------------------------- #
# Interface
# --------------------------------------------------------------------------- #
class GraphStore(ABC):
    """Primitive graph persistence contract shared by every backend."""

    backend: str = "abstract"

    # ---------------------------------------------------------------- writes
    @abstractmethod
    def upsert_node(self, node: Node) -> Node:
        """Create or merge a node; returns the stored node."""

    @abstractmethod
    def upsert_edge(self, edge: Edge) -> Edge:
        """Create or merge an edge; returns the stored edge."""

    def upsert_nodes(self, nodes: Iterable[Node]) -> list[Node]:
        """Bulk node upsert (order preserved)."""
        return [self.upsert_node(node) for node in nodes]

    def upsert_edges(self, edges: Iterable[Edge]) -> list[Edge]:
        """Bulk edge upsert (order preserved)."""
        return [self.upsert_edge(edge) for edge in edges]

    def upsert_subgraph(self, subgraph: Subgraph) -> Subgraph:
        """Upsert nodes first, then edges (endpoints must exist)."""
        self.upsert_nodes(subgraph.nodes)
        self.upsert_edges(subgraph.edges)
        return subgraph

    @abstractmethod
    def delete_node(self, node_id: str) -> bool:
        """Delete a node and any incident edges.  Returns whether it existed."""

    @abstractmethod
    def delete_edge(self, src: str, rel: str, dst: str) -> bool:
        """Delete a single edge by identity triple."""

    def delete_edges(self, edges: Iterable[Edge]) -> int:
        """Delete several edges; returns how many existed."""
        return sum(1 for edge in edges if self.delete_edge(edge.src, edge.rel, edge.dst))

    @abstractmethod
    def clear(self) -> None:
        """Remove every node and edge (used by the demo reset command)."""

    # ----------------------------------------------------------------- reads
    @abstractmethod
    def get_node(self, node_id: str) -> Optional[Node]:
        """Fetch one node or ``None``."""

    @abstractmethod
    def get_nodes(
        self,
        label: str | Sequence[str] | None = None,
        where: Mapping[str, Any] | None = None,
        limit: Optional[int] = None,
        offset: int = 0,
    ) -> list[Node]:
        """Query nodes deterministically ordered."""

    @abstractmethod
    def get_edges(
        self,
        src: str | Sequence[str] | None = None,
        rel: str | Sequence[str] | None = None,
        dst: str | Sequence[str] | None = None,
        where: Mapping[str, Any] | None = None,
        limit: Optional[int] = None,
        offset: int = 0,
    ) -> list[Edge]:
        """Query edges deterministically ordered."""

    @abstractmethod
    def node_count(self) -> int:
        """Total number of nodes."""

    @abstractmethod
    def edge_count(self) -> int:
        """Total number of edges."""

    # ------------------------------------------------------------ convenience
    def all_nodes(self) -> list[Node]:
        """Every node, deterministically ordered."""
        return self.get_nodes()

    def all_edges(self) -> list[Edge]:
        """Every edge, deterministically ordered."""
        return self.get_edges()

    def nodes_of_type(self, label: str | Sequence[str]) -> list[Node]:
        """Shorthand for ``get_nodes(label=...)``."""
        return self.get_nodes(label=label)

    def edges_into(self, node_id: str, rel: str | Sequence[str] | None = None) -> list[Edge]:
        """Edges whose destination is ``node_id``."""
        return self.get_edges(rel=rel, dst=node_id)

    def edges_out(self, node_id: str, rel: str | Sequence[str] | None = None) -> list[Edge]:
        """Edges whose source is ``node_id``."""
        return self.get_edges(src=node_id, rel=rel)

    def incident_edges(self, node_id: str) -> list[Edge]:
        """Every edge touching ``node_id`` (either direction), de-duplicated."""
        seen: set[tuple[str, str, str]] = set()
        out: list[Edge] = []
        for edge in self.get_edges(src=node_id) + self.get_edges(dst=node_id):
            if edge.key not in seen:
                seen.add(edge.key)
                out.append(edge)
        return out

    def neighbors(
        self,
        node_id: str,
        rels: Iterable[str] | None = None,
        *,
        direction: str = "both",
    ) -> list[tuple[Edge, str]]:
        """Return ``(edge, neighbor_id)`` pairs adjacent to ``node_id``.

        ``direction`` is ``"out"``, ``"in"`` or ``"both"``.  This is the single
        traversal primitive every reasoning module is built on, which is why the
        traversal logic does not need duplicating per backend.
        """
        allowed = set(rels) if rels else None
        pairs: list[tuple[Edge, str]] = []
        if direction in ("out", "both"):
            for edge in self.get_edges(src=node_id, rel=sorted(allowed) if allowed else None):
                pairs.append((edge, edge.dst))
        if direction in ("in", "both"):
            for edge in self.get_edges(dst=node_id, rel=sorted(allowed) if allowed else None):
                pairs.append((edge, edge.src))
        return pairs

    def subgraph(self, node_ids: Iterable[str]) -> Subgraph:
        """Induced subgraph over the supplied node ids."""
        keep = list(dict.fromkeys(node_ids))
        nodes = [node for node in (self.get_node(nid) for nid in keep) if node is not None]
        id_set = {node.id for node in nodes}
        edges = [
            edge
            for edge in self.all_edges()
            if edge.src in id_set and edge.dst in id_set
        ]
        return Subgraph(nodes=nodes, edges=edges)

    def counts_by_label(self) -> dict[str, int]:
        """Node counts grouped by label."""
        counts: dict[str, int] = {}
        for node in self.all_nodes():
            counts[node.label] = counts.get(node.label, 0) + 1
        return dict(sorted(counts.items()))

    def counts_by_rel(self) -> dict[str, int]:
        """Edge counts grouped by relationship type."""
        counts: dict[str, int] = {}
        for edge in self.all_edges():
            counts[edge.rel] = counts.get(edge.rel, 0) + 1
        return dict(sorted(counts.items()))

    def stats(self) -> dict[str, Any]:
        """Summary used by ``/api/health`` and ``/api/demo/state``."""
        return {
            "backend": self.backend,
            "nodes": self.node_count(),
            "edges": self.edge_count(),
            "nodes_by_label": self.counts_by_label(),
            "edges_by_rel": self.counts_by_rel(),
        }

    def health(self) -> dict[str, Any]:
        """Cheap liveness probe that never raises."""
        try:
            return {"backend": self.backend, "ok": True, "nodes": self.node_count(),
                    "edges": self.edge_count()}
        except Exception as exc:  # pragma: no cover - defensive
            return {"backend": self.backend, "ok": False, "error": str(exc)}

    # --------------------------------------------------------------- batching
    @contextmanager
    def batch(self) -> Iterator["GraphStore"]:
        """Context manager hinting that writes should be bundled.

        The memory/json stores are already cheap; the FalkorDB adapter flushes
        accumulated writes here, which keeps bulk seeding fast without changing
        call sites.
        """
        yield self

    def close(self) -> None:
        """Release resources (no-op for in-process stores)."""


# --------------------------------------------------------------------------- #
# In-process store
# --------------------------------------------------------------------------- #
class MemoryGraphStore(GraphStore):
    """Deterministic in-process graph store.

    Fast enough for the whole demo (hundreds to low thousands of nodes) and
    dependency-free, so the demo, the test-suite and the MCP server all work with
    no Docker, no network and no credentials.
    """

    backend = "memory"

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._nodes: dict[str, Node] = {}
        self._edges: dict[tuple[str, str, str], Edge] = {}
        self._by_label: dict[str, set[str]] = {}
        self._out: dict[str, set[tuple[str, str, str]]] = {}
        self._in: dict[str, set[tuple[str, str, str]]] = {}

    # ---------------------------------------------------------------- writes
    def upsert_node(self, node: Node) -> Node:
        """Insert or merge ``node`` (idempotent)."""
        with self._lock:
            existing = self._nodes.get(node.id)
            merged = existing.merge(node) if existing else node
            self._nodes[node.id] = merged
            self._by_label.setdefault(merged.label, set()).add(merged.id)
            return merged

    def upsert_edge(self, edge: Edge) -> Edge:
        """Insert or merge ``edge`` keyed by ``(src, rel, dst)``."""
        with self._lock:
            if edge.src not in self._nodes or edge.dst not in self._nodes:
                missing = edge.src if edge.src not in self._nodes else edge.dst
                raise KeyError(
                    f"cannot create {edge.rel} edge: endpoint {missing!r} is not in the graph"
                )
            existing = self._edges.get(edge.key)
            merged = existing.merge(edge) if existing else edge
            self._edges[edge.key] = merged
            self._out.setdefault(merged.src, set()).add(merged.key)
            self._in.setdefault(merged.dst, set()).add(merged.key)
            return merged

    def delete_node(self, node_id: str) -> bool:
        """Delete a node plus every incident edge."""
        with self._lock:
            node = self._nodes.pop(node_id, None)
            if node is None:
                return False
            self._by_label.get(node.label, set()).discard(node_id)
            for key in set(self._out.get(node_id, set())) | set(self._in.get(node_id, set())):
                self._remove_edge_key(key)
            self._out.pop(node_id, None)
            self._in.pop(node_id, None)
            return True

    def delete_edge(self, src: str, rel: str, dst: str) -> bool:
        """Delete one edge by identity triple."""
        with self._lock:
            return self._remove_edge_key((src, rel, dst))

    def _remove_edge_key(self, key: tuple[str, str, str]) -> bool:
        edge = self._edges.pop(key, None)
        if edge is None:
            return False
        self._out.get(edge.src, set()).discard(key)
        self._in.get(edge.dst, set()).discard(key)
        return True

    def clear(self) -> None:
        """Wipe the graph."""
        with self._lock:
            self._nodes.clear()
            self._edges.clear()
            self._by_label.clear()
            self._out.clear()
            self._in.clear()

    # ----------------------------------------------------------------- reads
    def get_node(self, node_id: str) -> Optional[Node]:
        """Fetch one node."""
        return self._nodes.get(node_id)

    def get_nodes(
        self,
        label: str | Sequence[str] | None = None,
        where: Mapping[str, Any] | None = None,
        limit: Optional[int] = None,
        offset: int = 0,
    ) -> list[Node]:
        """Query nodes; deterministic order, optional limit/offset."""
        filters = normalize_where(where)
        with self._lock:
            if label is None:
                candidates: Iterable[Node] = list(self._nodes.values())
            else:
                labels = [label] if isinstance(label, str) else list(label)
                seen: set[str] = set()
                candidates = []
                for one in labels:
                    for nid in self._by_label.get(one, set()):
                        if nid not in seen:
                            seen.add(nid)
                            candidates.append(self._nodes[nid])
            result = [node for node in candidates if _node_matches(node, filters)]
        result.sort(key=lambda node: (node.label, node.id))
        if offset:
            result = result[offset:]
        if limit is not None:
            result = result[:limit]
        return result

    def get_edges(
        self,
        src: str | Sequence[str] | None = None,
        rel: str | Sequence[str] | None = None,
        dst: str | Sequence[str] | None = None,
        where: Mapping[str, Any] | None = None,
        limit: Optional[int] = None,
        offset: int = 0,
    ) -> list[Edge]:
        """Query edges; uses adjacency indexes when a single endpoint is given."""
        filters = normalize_where(where)
        with self._lock:
            keys: Optional[set[tuple[str, str, str]]] = None
            if isinstance(src, str):
                keys = set(self._out.get(src, set()))
            if isinstance(dst, str):
                incoming = set(self._in.get(dst, set()))
                keys = incoming if keys is None else (keys & incoming)
            candidates = (
                [self._edges[key] for key in keys if key in self._edges]
                if keys is not None
                else list(self._edges.values())
            )
            srcs = {src} if isinstance(src, str) else (set(src) if src else None)
            dsts = {dst} if isinstance(dst, str) else (set(dst) if dst else None)
            rels = {rel} if isinstance(rel, str) else (set(rel) if rel else None)
            result = [
                edge
                for edge in candidates
                if (srcs is None or edge.src in srcs)
                and (dsts is None or edge.dst in dsts)
                and (rels is None or edge.rel in rels)
                and _edge_matches(edge, filters)
            ]
        result.sort(key=lambda edge: (edge.src, edge.rel, edge.dst))
        if offset:
            result = result[offset:]
        if limit is not None:
            result = result[:limit]
        return result

    def node_count(self) -> int:
        """Total nodes."""
        return len(self._nodes)

    def edge_count(self) -> int:
        """Total edges."""
        return len(self._edges)

    # ------------------------------------------------------------ (de)serialise
    def to_dict(self) -> dict[str, Any]:
        """Full serialisable snapshot."""
        return {
            "format": "tripwire-graph-v1",
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "nodes": [node.as_dict() for node in self.all_nodes()],
            "edges": [edge.as_dict() for edge in self.all_edges()],
        }

    def load_dict(self, payload: Mapping[str, Any]) -> None:
        """Replace the graph from a snapshot produced by :meth:`to_dict`."""
        self.clear()
        for raw in payload.get("nodes") or []:
            self.upsert_node(Node.from_dict(raw))
        for raw in payload.get("edges") or []:
            # Skip dangling edges rather than aborting a whole restore: a partial
            # snapshot should degrade, not explode.
            try:
                self.upsert_edge(Edge.from_dict(raw))
            except KeyError:
                continue


# --------------------------------------------------------------------------- #
# JSON-file store
# --------------------------------------------------------------------------- #
class JsonGraphStore(MemoryGraphStore):
    """In-process store persisted to a single JSON file.

    This is what lets the HTTP API and a stdio MCP server (separate processes)
    share one graph without Docker.  Writes are atomic (temp file + ``os.replace``)
    and readers transparently reload when the file changes on disk, so a process
    that only reads sees updates made by a process that writes.

    Limitations (documented, not hidden): there is no cross-process transaction,
    so concurrent writers are last-write-wins.  Use FalkorDB when several writers
    must run at once.
    """

    backend = "json"

    def __init__(self, path: str, *, autoload: bool = True, autosave: bool = True) -> None:
        super().__init__()
        self.path = os.path.abspath(path)
        self.autosave = autosave
        self._mtime: float = 0.0
        # Re-entrancy guard.  ``save()`` serialises the graph by calling
        # ``to_dict()`` -> ``all_nodes()`` -> ``get_nodes()``, and the reader
        # overrides below call ``reload_if_changed()`` -> ``load()``.  Without this
        # guard that cycle is infinite (load -> clear -> save -> get_nodes ->
        # reload -> load ...), which crashed every second process opening an
        # existing state file.  ``_io_active`` makes every nested I/O call a no-op.
        self._io_lock = threading.RLock()
        self._io_active = False
        if autoload:
            self.load()

    @contextmanager
    def _io(self) -> Iterator[bool]:
        """Yield ``True`` when this call owns the I/O cycle, ``False`` when nested."""
        with self._io_lock:
            if self._io_active:
                yield False
                return
            self._io_active = True
            try:
                yield True
            finally:
                self._io_active = False

    # ------------------------------------------------------------- persistence
    def load(self) -> bool:
        """Load from disk when the file exists.  Returns whether it was loaded."""
        with self._io() as owns:
            if not owns:
                return False
            return self._load_now()

    def _load_now(self) -> bool:
        """Read the file and replace the graph.

        Must be called while the caller already owns the I/O guard: nesting
        :meth:`load` inside another guarded call would make the inner call a no-op
        and silently skip the reload.
        """
        if not os.path.exists(self.path):
            return False
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError):
            return False
        self.load_dict(payload)
        self._mtime = self._current_mtime()
        return True

    def save(self) -> None:
        """Atomically persist the graph."""
        with self._io() as owns:
            if not owns:
                return
            directory = os.path.dirname(self.path) or "."
            os.makedirs(directory, exist_ok=True)
            payload = self.to_dict()
            fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".tripwire-", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, ensure_ascii=False, indent=1, sort_keys=True)
                os.replace(tmp_path, self.path)
            finally:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            self._mtime = self._current_mtime()

    def _current_mtime(self) -> float:
        try:
            return os.path.getmtime(self.path)
        except OSError:
            return 0.0

    def reload_if_changed(self) -> bool:
        """Reload when another process wrote the file.  Returns whether it did."""
        with self._io() as owns:
            if not owns:
                return False
            mtime = self._current_mtime()
            if mtime and mtime != self._mtime:
                return self._load_now()
            return False

    def _maybe_persist(self) -> None:
        if self.autosave:
            self.save()

    # ---------------------------------------------------- write pass-throughs
    def upsert_node(self, node: Node) -> Node:
        """Upsert and persist."""
        stored = super().upsert_node(node)
        self._maybe_persist()
        return stored

    def upsert_edge(self, edge: Edge) -> Edge:
        """Upsert and persist."""
        stored = super().upsert_edge(edge)
        self._maybe_persist()
        return stored

    def delete_node(self, node_id: str) -> bool:
        """Delete and persist."""
        removed = super().delete_node(node_id)
        if removed:
            self._maybe_persist()
        return removed

    def delete_edge(self, src: str, rel: str, dst: str) -> bool:
        """Delete and persist."""
        removed = super().delete_edge(src, rel, dst)
        if removed:
            self._maybe_persist()
        return removed

    def clear(self) -> None:
        """Clear the graph and persist the empty state."""
        super().clear()
        self._maybe_persist()

    def upsert_subgraph(self, subgraph: Subgraph) -> Subgraph:
        """Bulk upsert with a single flush (used by the seeder)."""
        previous, self.autosave = self.autosave, False
        try:
            super().upsert_subgraph(subgraph)
        finally:
            self.autosave = previous
        self._maybe_persist()
        return subgraph

    def health(self) -> dict[str, Any]:
        """Health including the backing file, reloaded if another writer changed it."""
        self.reload_if_changed()
        info = super().health()
        info["path"] = self.path
        info["exists"] = os.path.exists(self.path)
        return info

    def get_nodes(self, *args: Any, **kwargs: Any) -> list[Node]:  # type: ignore[override]
        """Read-after-write visibility for cross-process readers."""
        self.reload_if_changed()
        return super().get_nodes(*args, **kwargs)

    def get_node(self, node_id: str) -> Optional[Node]:
        """Read-after-write visibility for cross-process readers."""
        self.reload_if_changed()
        return super().get_node(node_id)

    def get_edges(self, *args: Any, **kwargs: Any) -> list[Edge]:  # type: ignore[override]
        """Read-after-write visibility for cross-process readers."""
        self.reload_if_changed()
        return super().get_edges(*args, **kwargs)

    def node_count(self) -> int:
        """Read-after-write visibility for cross-process readers."""
        self.reload_if_changed()
        return super().node_count()

    def edge_count(self) -> int:
        """Read-after-write visibility for cross-process readers."""
        self.reload_if_changed()
        return super().edge_count()

    def all_nodes(self) -> list[Node]:
        """Read-after-write visibility for cross-process readers."""
        self.reload_if_changed()
        return super().all_nodes()

    def all_edges(self) -> list[Edge]:
        """Read-after-write visibility for cross-process readers."""
        self.reload_if_changed()
        return super().all_edges()


# --------------------------------------------------------------------------- #
# Factory
# --------------------------------------------------------------------------- #
def create_store(
    backend: str = "json",
    *,
    path: str | None = None,
    falkor: Mapping[str, Any] | None = None,
) -> GraphStore:
    """Build a store from explicit configuration.

    ``backend`` is one of:

    ``memory``
        Ephemeral in-process graph (tests, fast experiments).
    ``json``
        In-process graph persisted to ``path`` (works without Docker).
    ``falkordb``
        Real FalkorDB server over the Redis protocol; ``falkor`` supplies
        ``host``/``port``/``username``/``password``/``graph``.

    The FalkorDB import is lazy so the demo keeps running on machines without the
    client installed or the server reachable (spec S16).
    """
    normalised = (backend or "json").strip().lower()
    if normalised in ("memory", "inmemory", "in-memory"):
        return MemoryGraphStore()
    if normalised == "json":
        return JsonGraphStore(path or os.path.join(os.getcwd(), "data", "graph.json"))
    if normalised in ("falkordb", "falkor"):
        from .falkor_store import FalkorGraphStore  # local import: optional dependency

        options = dict(falkor or {})
        return FalkorGraphStore(**options)
    raise ValueError(
        f"unknown store backend {backend!r}; expected 'memory', 'json' or 'falkordb'"
    )
