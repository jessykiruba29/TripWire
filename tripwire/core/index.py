"""In-memory traversal index over a graph snapshot.

Every reasoning module (contradiction detection, staleness propagation,
explanation, expert finding, bi-temporal history) needs the same three things:

1. O(1) node/edge lookup,
2. deterministic breadth-first traversal with cycle safety,
3. reconstruction of the *actual* evidence path that connected two entities.

Implementing those once - here, over a plain node/edge snapshot - is what keeps
the reasoning logic backend-independent: the same code runs against the JSON
store and against FalkorDB, and there is no second copy to drift.

A :class:`GraphIndex` is an immutable snapshot.  Callers that mutate the graph
rebuild the index (see :func:`tripwire.core.engine.GraphEngine._index`), which
keeps reasoning predictable: nothing changes underneath a traversal.
"""

from __future__ import annotations

from collections import deque
from typing import Any, Iterable, Mapping, Optional, Sequence

from .models import Edge, EvidencePath, Node, PathStep

__all__ = ["GraphIndex", "Reachability", "DIRECTION_OUT", "DIRECTION_IN", "DIRECTION_BOTH"]

DIRECTION_OUT = "out"
DIRECTION_IN = "in"
DIRECTION_BOTH = "both"


class Reachability:
    """Result of a breadth-first traversal from one or more roots.

    Stores a shortest-path tree, so every reached node can be turned back into
    the concrete edge chain that reached it.  Because it is a *tree*, cycles in
    the graph cannot produce duplicate or infinite paths, which is exactly the
    behaviour the specification demands for staleness propagation (spec S7).
    """

    def __init__(self, roots: Iterable[str], directed: bool = True) -> None:
        self.roots: list[str] = list(dict.fromkeys(roots))
        self.directed = directed
        self.depth: dict[str, int] = {root: 0 for root in self.roots}
        self.parent: dict[str, tuple[str, Edge]] = {}
        self.order: list[str] = list(self.roots)

    def has(self, node_id: str) -> bool:
        """True when ``node_id`` was reached."""
        return node_id in self.depth

    def reached(self, exclude_roots: bool = False) -> list[str]:
        """Reached node ids, discovery order (deterministic)."""
        if not exclude_roots:
            return list(self.order)
        return [node_id for node_id in self.order if node_id not in self.depth or self.depth[node_id] > 0]

    def add(self, node_id: str, source: str, edge: Edge) -> None:
        """Record the shortest path to ``node_id`` via ``edge`` from ``source``."""
        if node_id in self.depth:
            return
        self.depth[node_id] = self.depth[source] + 1
        self.parent[node_id] = (source, edge)
        self.order.append(node_id)


class GraphIndex:
    """Immutable snapshot with adjacency indexes and traversal helpers."""

    def __init__(self, nodes: Iterable[Node], edges: Iterable[Edge]) -> None:
        self.nodes: dict[str, Node] = {node.id: node for node in nodes}
        self.edges: list[Edge] = list(edges)
        self.out_edges: dict[str, list[Edge]] = {}
        self.in_edges: dict[str, list[Edge]] = {}
        for edge in self.edges:
            self.out_edges.setdefault(edge.src, []).append(edge)
            self.in_edges.setdefault(edge.dst, []).append(edge)
        # Deterministic adjacency ordering keeps every derived result stable.
        for bucket in (self.out_edges, self.in_edges):
            for key in bucket:
                bucket[key].sort(key=lambda e: (e.rel, e.src, e.dst))

    # ------------------------------------------------------------------ build
    @classmethod
    def from_store(cls, store: Any) -> "GraphIndex":
        """Snapshot the whole graph from any :class:`GraphStore`."""
        return cls(store.all_nodes(), store.all_edges())

    # ---------------------------------------------------------------- lookups
    def node(self, node_id: Optional[str]) -> Optional[Node]:
        """Fetch a node by id."""
        return self.nodes.get(node_id) if node_id else None

    def name(self, node_id: Optional[str]) -> str:
        """Display name for a node id (falls back to the raw id)."""
        node = self.node(node_id)
        return node.name if node else str(node_id)

    def label(self, node_id: Optional[str]) -> Optional[str]:
        """Node label, or ``None`` when unknown."""
        node = self.node(node_id)
        return node.label if node else None

    def prop(self, node_id: Optional[str], key: str, default: Any = None) -> Any:
        """Read a node property."""
        node = self.node(node_id)
        return node.props.get(key, default) if node else default

    def of_label(
        self,
        label: str | Sequence[str],
        where: Mapping[str, Any] | None = None,
    ) -> list[Node]:
        """Nodes of one or more labels, filterable by property equality."""
        labels = {label} if isinstance(label, str) else set(label)
        result = []
        for node in self.nodes.values():
            if node.label not in labels:
                continue
            if where and any(node.props.get(key) != value for key, value in where.items()):
                continue
            result.append(node)
        result.sort(key=lambda node: (node.label, node.id))
        return result

    def edges_of(self, rel: str | Sequence[str]) -> list[Edge]:
        """All edges with one of the supplied relationship types."""
        rels = {rel} if isinstance(rel, str) else set(rel)
        return [edge for edge in self.edges if edge.rel in rels]

    # -------------------------------------------------------------- adjacency
    def out(self, node_id: str, rels: Iterable[str] | None = None) -> list[Edge]:
        """Outgoing edges, optionally filtered by relationship type."""
        return _filter_rel(self.out_edges.get(node_id, []), rels)

    def incoming(self, node_id: str, rels: Iterable[str] | None = None) -> list[Edge]:
        """Incoming edges, optionally filtered by relationship type."""
        return _filter_rel(self.in_edges.get(node_id, []), rels)

    def sources(self, node_id: str, rels: Iterable[str] | None = None) -> list[str]:
        """Ids of nodes with an edge *into* ``node_id`` (deduplicated, ordered)."""
        return _dedupe(edge.src for edge in self.incoming(node_id, rels))

    def targets(self, node_id: str, rels: Iterable[str] | None = None) -> list[str]:
        """Ids of nodes *pointed at* by ``node_id`` (deduplicated, ordered)."""
        return _dedupe(edge.dst for edge in self.out(node_id, rels))

    # -------------------------------------------------------------- traversal
    def traverse(
        self,
        roots: Iterable[str],
        rels: Iterable[str] | None = None,
        *,
        direction: str = DIRECTION_OUT,
        max_depth: int = 1,
        allow_labels: Iterable[str] | None = None,
        stop_labels: Iterable[str] | None = None,
    ) -> Reachability:
        """Breadth-first traversal producing a shortest-path tree.

        * ``direction`` - follow out-edges, in-edges, or both.
        * ``max_depth`` - hop budget; bounds the walk so cycles terminate.
        * ``allow_labels`` - only these labels may be *entered* (roots always are).
        * ``stop_labels`` - never expand beyond nodes with these labels.

        Cycle safety comes from the visited map: a node is entered once, so a
        bounded walk over a cyclic graph terminates and yields each node's
        shortest path exactly once - no duplicate alerts (spec S7).
        """
        rel_set = set(rels) if rels else None
        allow = set(allow_labels) if allow_labels else None
        stop = set(stop_labels) if stop_labels else set()
        reach = Reachability(roots)
        queue: deque[str] = deque(reach.roots)
        while queue:
            current = queue.popleft()
            if reach.depth[current] >= max_depth:
                continue
            current_label = self.label(current)
            if current_label in stop:
                continue
            for edge, neighbor in self._neighbors(current, rel_set, direction):
                if neighbor not in self.nodes or reach.has(neighbor):
                    continue
                neighbor_label = self.label(neighbor)
                if allow is not None and neighbor_label not in allow:
                    continue
                reach.add(neighbor, current, edge)
                queue.append(neighbor)
        return reach

    def _neighbors(
        self, node_id: str, rels: set[str] | None, direction: str
    ) -> list[tuple[Edge, str]]:
        """Adjacent ``(edge, neighbor_id)`` pairs honouring direction and rels."""
        pairs: list[tuple[Edge, str]] = []
        if direction in (DIRECTION_OUT, DIRECTION_BOTH):
            pairs.extend((edge, edge.dst) for edge in self.out(node_id, rels))
        if direction in (DIRECTION_IN, DIRECTION_BOTH):
            pairs.extend((edge, edge.src) for edge in self.incoming(node_id, rels))
        return pairs

    def path_from(
        self, reach: Reachability, target: str, *, start: Optional[str] = None
    ) -> EvidencePath:
        """Turn a reached node into the concrete edge chain that reached it.

        The chain is oriented as a **walk** from a traversal root.  Rendering it in
        storage order would produce a path whose steps do not follow one another -
        a reversed chain such as ``assumption -SUPPORTED_BY-> fact`` followed by
        ``assumption -ASSUMES-> decision`` used to collapse into a bogus
        ``assumption -> assumption`` path with an invalid edge direction.  Walking
        from the root makes every step continue from the previous one, and each step
        records ``edge_direction`` so the true storage direction is never hidden.
        """
        if not reach.has(target):
            return EvidencePath(steps=[])
        chain: list[Edge] = []
        cursor = target
        while cursor in reach.parent:
            previous, edge = reach.parent[cursor]
            chain.append(edge)
            cursor = previous
        chain.reverse()
        if start is not None:
            return self.walk_path(start, chain)
        # Try every root: with a multi-root traversal only one of them may be the
        # origin of this particular chain.  Keep the longest continuous walk, and
        # return nothing rather than a fabricated sequence when none connects.
        walks = [path for path in (self.walk_path(root, chain) for root in reach.roots) if path.steps]
        if not walks:
            return EvidencePath(steps=[])
        return max(walks, key=lambda path: len(path.steps))

    def edge_chain_to_path(self, chain: Iterable[Edge]) -> EvidencePath:
        """Enrich an edge chain with labels/names for API and MCP output."""
        steps: list[PathStep] = []
        for edge in chain:
            steps.append(
                PathStep(
                    src=edge.src,
                    rel=edge.rel,
                    dst=edge.dst,
                    src_name=self.name(edge.src),
                    dst_name=self.name(edge.dst),
                    src_label=self.label(edge.src),
                    dst_label=self.label(edge.dst),
                    props=dict(edge.props),
                )
            )
        return EvidencePath(steps=steps)

    def walk_path(self, start: str, chain: Sequence[Edge]) -> EvidencePath:
        """Orient a connected edge chain into a readable walk starting at ``start``.

        Traversal edges are usually followed *against* their stored direction
        (an assumption points at the fact it rests on; a dependent decision points
        at the decision it depends on).  Presenting that chain in storage order
        would read backwards, so each step is emitted in walk order and the true
        storage direction is recorded in ``props['edge_direction']`` - the output
        stays honest about which way the edge really points.

        A chain that is not connected from ``start`` is truncated instead of
        being silently fabricated into a plausible-looking path.
        """
        steps: list[PathStep] = []
        current = start
        for edge in chain:
            if edge.src == current:
                nxt, direction = edge.dst, "forward"
            elif edge.dst == current:
                nxt, direction = edge.src, "reverse"
            else:
                break
            props = dict(edge.props)
            props["edge_direction"] = direction
            props.setdefault("stored_src", edge.src)
            props.setdefault("stored_dst", edge.dst)
            steps.append(
                PathStep(
                    src=current,
                    rel=edge.rel,
                    dst=nxt,
                    src_name=self.name(current),
                    dst_name=self.name(nxt),
                    src_label=self.label(current),
                    dst_label=self.label(nxt),
                    props=props,
                )
            )
            current = nxt
        return EvidencePath(steps=steps)

    def all_paths(
        self,
        start: str,
        target: str,
        *,
        rels: Iterable[str] | None = None,
        direction: str = DIRECTION_OUT,
        max_depth: int = 6,
        limit: int = 5,
    ) -> list[EvidencePath]:
        """Enumerate simple paths between two nodes (bounded, cycle-safe).

        Used by ``explain_path`` when a caller names two entities explicitly.
        Depth- and count-bounded by design: an unbounded enumeration on a cyclic
        graph is a denial-of-service vector, not a feature (spec S16).
        """
        rel_set = set(rels) if rels else None
        found: list[EvidencePath] = []
        # Iterative DFS with an explicit on-path set guarantees simple paths.
        stack: list[tuple[str, list[Edge], set[str]]] = [(start, [], {start})]
        while stack and len(found) < limit:
            current, chain, on_path = stack.pop()
            if len(chain) > max_depth:
                continue
            if current == target and chain:
                # Walk-oriented, not storage-ordered: a chain followed against the
                # stored edge direction must still read as a continuous path.
                found.append(self.walk_path(start, chain))
                continue
            if current == target:
                continue
            for edge, neighbor in reversed(self._neighbors(current, rel_set, direction)):
                if neighbor in on_path or neighbor not in self.nodes:
                    continue
                stack.append((neighbor, chain + [edge], on_path | {neighbor}))
        found.sort(key=lambda path: (len(path.steps), path.key))
        return found

    # ------------------------------------------------------------------ misc
    def node_count(self) -> int:
        """Number of nodes in the snapshot."""
        return len(self.nodes)

    def edge_count(self) -> int:
        """Number of edges in the snapshot."""
        return len(self.edges)

    def describe_node(self, node_id: str) -> dict[str, Any]:
        """Compact node summary used in explanations and API payloads."""
        node = self.node(node_id)
        if node is None:
            return {"id": node_id, "label": None, "name": node_id, "found": False}
        summary = node.to_view()
        summary["found"] = True
        return summary

    def provenance_for(self, node_id: str, *, max_depth: int = 2) -> list[dict[str, Any]]:
        """Source artifacts that (transitively) support a claim.

        Returns the ``Message``/``Document`` records reachable through
        provenance relationships, together with the path that links them, so an
        explanation can always point at a real record rather than asserting one
        exists.
        """
        from .schema import PROVENANCE_REL_TYPES  # local import avoids a cycle

        reach = self.traverse(
            [node_id],
            rels=PROVENANCE_REL_TYPES,
            direction=DIRECTION_IN,
            max_depth=max_depth,
            allow_labels=("Message", "Document", "Event", "Fact", "Assumption", "Alert"),
        )
        artifacts = []
        for reached in reach.order:
            if reached == node_id:
                continue
            if self.label(reached) in ("Message", "Document"):
                artifacts.append(
                    {
                        "id": reached,
                        "label": self.label(reached),
                        "name": self.name(reached),
                        "props": dict(self.node(reached).props),
                        "path": self.path_from(reach, reached).as_dict(),
                    }
                )
        artifacts.sort(key=lambda item: (item["label"], item["id"]))
        return artifacts


def _filter_rel(edges: Sequence[Edge], rels: Iterable[str] | None) -> list[Edge]:
    if not rels:
        return list(edges)
    allowed = {rels} if isinstance(rels, str) else set(rels)
    return [edge for edge in edges if edge.rel in allowed]


def _dedupe(items: Iterable[str]) -> list[str]:
    """Order-preserving de-duplication."""
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out
