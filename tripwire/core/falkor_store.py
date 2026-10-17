"""FalkorDB graph store adapter.

This is the production backend named in the specification.  It implements the
same primitive contract as :class:`tripwire.core.store.MemoryGraphStore`, so the
entire reasoning engine is reused unchanged - there is no second, drifting
implementation of graph reasoning.

Design notes
------------
**Cypher injection.**  Labels and relationship types cannot be parameterised in
Cypher, so they are *never* interpolated from caller input: every label and
relationship is checked against :data:`tripwire.core.schema.NODE_TYPES` /
:data:`tripwire.core.schema.REL_TYPES` first.  Property *values* are always passed
through the driver's parameter map, and property *names* must match
``^[A-Za-z_][A-Za-z0-9_]*$``.  No endpoint accepts raw Cypher (spec S16).

**Merge semantics.**  ``MERGE`` + ``SET n += $props`` would blindly overwrite, so
that a re-seed could clobber ``recorded_at``.  The adapter therefore reads the
existing node, merges in Python with the *same* :meth:`Node.merge` rules the
in-process store uses, and writes the merged result.  Bulk seeding prefetches the
whole graph once instead of per-node reads.

**Native traversal.**  :meth:`FalkorGraphStore.native_candidate_decisions`
implements the (corrected) variable-length Cypher traversal from the proposal.
It is used as an *optimisation* only: the Python engine in
:mod:`tripwire.core.staleness` remains authoritative, and
``tests/test_falkor_parity.py`` asserts both produce identical decisions.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, Optional, Sequence

from .errors import StoreError, StoreUnavailableError
from .models import Edge, Node, Subgraph
from .schema import NODE_TYPES, REL_TYPES
from .store import GraphStore, normalize_where

__all__ = ["FalkorGraphStore", "CORRECTED_PROPAGATION_CYPHER", "PROPOSED_PROPAGATION_CYPHER"]

_PROP_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

#: The illustrative query from the original proposal, reproduced verbatim for
#: documentation and comparison.  **It is not executed as-is** - see
#: :data:`CORRECTED_PROPAGATION_CYPHER` and ``docs/GRAPH_SCHEMA.md``.
PROPOSED_PROPAGATION_CYPHER = (
    "MATCH p = (f:Fact {id:$oldFactId})<-[:SUPPORTED_BY]-(:Assumption)"
    "<-[:ASSUMES]-(d:Decision)<-[:DEPENDS_ON*0..3]-(d2:Decision) "
    "SET d2.status='STALE', d2.stale_reason=$oldFactId RETURN p"
)

#: The corrected, read-only candidate-discovery query actually used.
#:
#: Corrections applied after validating against the real schema
#: (``docs/GRAPH_SCHEMA.md`` records the full rationale):
#:
#: 1. ``SET ...='STALE'`` is removed.  A single changed fact must not
#:    auto-invalidate a decision (spec S7/S8); the engine writes
#:    ``POTENTIALLY_STALE`` after evaluating alternate supporting evidence.
#: 2. ``DEPENDS_ON`` is traversed **decision -> dependent decision** only for the
#:    seed's own dependents; the reverse ``*0..N`` expansion is executed per seed
#:    decision so paths cannot explode into a cartesian product across multiple
#:    assumptions.
#: 3. ``OPTIONAL MATCH`` is not used for the dependent hop, so a decision with no
#:    dependents still surfaces as directly affected rather than being dropped.
#: 4. ``DISTINCT`` is applied because variable-length patterns return one row per
#:    path and would otherwise produce duplicate alerts (spec S7).
#: 5. Length is bounded, which makes cycles safe; the walk is de-duplicated by
#:    visited-node set in the engine.
CORRECTED_PROPAGATION_CYPHER = """
MATCH (f:Fact {id: $fact_id})<-[:SUPPORTED_BY]-(a:Assumption)<-[:ASSUMES]-(d:Decision)
RETURN DISTINCT a.id AS assumption_id, d.id AS decision_id
ORDER BY decision_id, assumption_id
"""

#: Native expansion used once per seed decision; ``{depth}`` is validated as a
#: small integer before substitution because Cypher bounds must be literals.
NATIVE_DEPENDENTS_CYPHER = """
MATCH (seed:Decision {id: $decision_id})<-[:DEPENDS_ON*0..{depth}]-(dependent:Decision)
RETURN DISTINCT dependent.id AS decision_id, length(shortestPath((seed)<-[:DEPENDS_ON*0..{depth}]-(dependent))) AS hops
"""


class FalkorGraphStore(GraphStore):
    """GraphStore backed by a FalkorDB server over the Redis protocol."""

    backend = "falkordb"

    def __init__(
        self,
        host: str = "localhost",
        port: int = 6379,
        username: str | None = None,
        password: str | None = None,
        graph: str = "tripwire",
        *,
        socket_timeout: float | None = 15.0,
        create_indices: bool = True,
    ) -> None:
        try:
            from falkordb import FalkorDB as _FalkorDB
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise StoreUnavailableError(
                "the 'falkordb' Python client is not installed; "
                "install it with `pip install falkordb` or use the json/memory backend",
                details={"backend": "falkordb"},
            ) from exc

        self.host = host
        self.port = int(port)
        self.graph_name = graph
        self._indices_ready = False
        try:
            self._client = _FalkorDB(
                host=host,
                port=int(port),
                username=username,
                password=password,
                socket_timeout=socket_timeout,
                socket_connect_timeout=socket_timeout,
            )
            self._graph = self._client.select_graph(graph)
            # Probe the *connection*, not the graph. A brand-new graph has no key
            # yet, and any query against it raises "Invalid graph operation on empty
            # key" - which made a fresh deployment impossible to bootstrap even
            # though the server was perfectly healthy.
            self._client.connection.ping()
            # Materialise the graph key. select_graph() only returns a handle: the key
            # does not exist until something is written, and until then *every* query
            # - including `MATCH (n) RETURN count(n)` - fails with "Invalid graph
            # operation on empty key". Creating then deleting one throwaway node
            # bootstraps an empty graph safely.
            try:
                known = {str(name) for name in self._client.list_graphs()}
            except Exception:  # noqa: BLE001 - older servers / empty keyspace
                known = set()
            if graph not in known:
                self._graph.query("CREATE (n:__tripwire_init) DELETE n")
        except Exception as exc:  # noqa: BLE001 - surface as a typed error
            raise StoreUnavailableError(
                f"cannot reach FalkorDB at {host}:{port} (graph {graph!r}): {exc}. "
                "Start it with `docker compose up -d falkordb` or set "
                "TRIPWIRE_STORE=json for the offline demo.",
                details={"host": host, "port": int(port), "graph": graph},
            ) from exc
        if create_indices:
            # Index creation needs an existing graph key, so on a first-run database
            # this is deferred until the first write materialises the graph.
            try:
                existing = {str(name) for name in self._client.list_graphs()}
            except Exception:  # noqa: BLE001 - older servers, empty keyspace
                existing = set()
            if graph in existing:
                self.ensure_indices()

    # ----------------------------------------------------------------- helpers
    @staticmethod
    def _validate_label(label: str) -> str:
        if label not in NODE_TYPES:
            raise StoreError(f"unknown node label {label!r}; refusing to build Cypher")
        return label

    @staticmethod
    def _validate_rel(rel: str) -> str:
        if rel not in REL_TYPES:
            raise StoreError(f"unknown relationship {rel!r}; refusing to build Cypher")
        return rel

    @staticmethod
    def _validate_prop_name(name: str) -> str:
        if not _PROP_NAME.match(name):
            raise StoreError(f"unsafe property name {name!r}; refusing to build Cypher")
        return name

    def _run(self, cypher: str, params: Mapping[str, Any] | None = None) -> Any:
        try:
            return self._graph.query(cypher, params or {})
        except Exception as exc:  # noqa: BLE001
            raise StoreError(
                f"FalkorDB query failed: {exc}", details={"cypher": cypher.strip()[:400]}
            ) from exc

    def _read(self, cypher: str, params: Mapping[str, Any] | None = None) -> Any:
        try:
            return self._graph.ro_query(cypher, params or {})
        except Exception as exc:  # noqa: BLE001
            raise StoreError(
                f"FalkorDB read failed: {exc}", details={"cypher": cypher.strip()[:400]}
            ) from exc

    # ---------------------------------------------------------------- indices
    def ensure_indices(self) -> None:
        """Create a range index on ``id`` for each label (idempotent).

        FalkorDB raises if an index already exists, so failures are swallowed -
        the goal is "index present", not "index created by me".
        """
        if self._indices_ready:
            return
        for label in NODE_TYPES:
            try:
                self._graph.create_node_range_index(self._validate_label(label), "id")
            except Exception:  # noqa: BLE001 - already exists or unsupported
                pass
        self._indices_ready = True

    # ------------------------------------------------------------ row mapping
    @staticmethod
    def _row_to_node(row: Sequence[Any]) -> Node:
        node_id, labels, name, props = row[0], row[1], row[2], row[3]
        clean = {k: v for k, v in dict(props or {}).items() if k not in ("id", "name")}
        label = (list(labels) or ["Unknown"])[0]
        return Node(id=str(node_id), label=str(label), name=str(name or node_id), props=clean)

    @staticmethod
    def _row_to_edge(row: Sequence[Any]) -> Edge:
        src, rel, dst, props = row[0], row[1], row[2], row[3]
        return Edge(src=str(src), rel=str(rel), dst=str(dst), props=dict(props or {}))

    _NODE_RETURN = "RETURN n.id AS id, labels(n) AS labels, n.name AS name, properties(n) AS props"

    # ---------------------------------------------------------------- writes
    def _node_write(self, node: Node) -> None:
        label = self._validate_label(node.label)
        props = {k: v for k, v in node.props.items() if v is not None}
        props["id"] = node.id
        props["name"] = node.name
        self._run(
            f"MERGE (n:{label} {{id: $id}}) SET n += $props",
            {"id": node.id, "props": props},
        )

    def upsert_node(self, node: Node) -> Node:
        """Merge a node using the shared merge rules, then write it."""
        existing = self.get_node(node.id)
        merged = existing.merge(node) if existing else node
        self._node_write(merged)
        return merged

    def upsert_edge(self, edge: Edge) -> Edge:
        """Merge an edge (endpoints must already exist)."""
        self._validate_rel(edge.rel)
        existing_rows = self._read(
            "MATCH (a {id: $src})-[r]->(b {id: $dst}) "
            "WHERE type(r) = $rel RETURN a.id, type(r), b.id, properties(r)",
            {"src": edge.src, "rel": edge.rel, "dst": edge.dst},
        ).result_set
        existing = self._row_to_edge(existing_rows[0]) if existing_rows else None
        merged = existing.merge(edge) if existing else edge
        props = {k: v for k, v in merged.props.items() if v is not None}
        self._run(
            "MATCH (a {id: $src}), (b {id: $dst}) "
            f"MERGE (a)-[r:{merged.rel}]->(b) SET r += $props",
            {"src": merged.src, "dst": merged.dst, "props": props},
        )
        return merged

    def upsert_subgraph(self, subgraph: Subgraph) -> Subgraph:
        """Bulk upsert with a single prefetch of existing nodes.

        Avoids one read per node and keeps merge semantics identical to the
        in-process store, which matters for seed idempotency.
        """
        existing = {node.id: node for node in self.all_nodes()}
        for node in subgraph.nodes:
            prior = existing.get(node.id)
            merged = prior.merge(node) if prior else node
            self._node_write(merged)
        for edge in subgraph.edges:
            self.upsert_edge(edge)
        return subgraph

    def delete_node(self, node_id: str) -> bool:
        """Delete a node and its incident edges."""
        result = self._run("MATCH (n {id: $id}) DETACH DELETE n RETURN 1", {"id": node_id})
        return bool(result.result_set)

    def delete_edge(self, src: str, rel: str, dst: str) -> bool:
        """Delete one edge by identity triple."""
        self._validate_rel(rel)
        result = self._run(
            f"MATCH (a {{id: $src}})-[r:{rel}]->(b {{id: $dst}}) DELETE r RETURN 1",
            {"src": src, "dst": dst},
        )
        return bool(result.result_set)

    def clear(self) -> None:
        """Drop the entire graph (used by the demo reset command)."""
        try:
            self._graph.delete()
        except Exception as exc:  # noqa: BLE001
            raise StoreError(f"failed to clear graph {self.graph_name!r}: {exc}") from exc
        self._indices_ready = False
        self.ensure_indices()

    # ----------------------------------------------------------------- reads
    def get_node(self, node_id: str) -> Optional[Node]:
        """Fetch one node."""
        rows = self._read(
            f"MATCH (n {{id: $id}}) {self._NODE_RETURN}", {"id": node_id}
        ).result_set
        return self._row_to_node(rows[0]) if rows else None

    def _where_clause(
        self, where: Mapping[str, Any] | None, var: str
    ) -> tuple[str, dict[str, Any], list[str]]:
        """Build a parameterised WHERE fragment.

        Returns ``(clause, params, extra_labels)``.  ``__type__`` selects node
        labels and is therefore lifted out of the WHERE clause.
        """
        filters = normalize_where(where)
        clauses: list[str] = []
        params: dict[str, Any] = {}
        labels: list[str] = []
        for index, (key, expected) in enumerate(sorted(filters.items())):
            if key == "__type__":
                wanted = [expected] if isinstance(expected, str) else list(expected)
                labels.extend(self._validate_label(item) for item in wanted)
                continue
            prop = self._validate_prop_name(key)
            param = f"p{index}"
            if expected is None:
                clauses.append(f"{var}.`{prop}` IS NULL")
            elif isinstance(expected, (list, tuple, set)):
                clauses.append(f"{var}.`{prop}` IN ${param}")
                params[param] = list(expected)
            else:
                clauses.append(f"{var}.`{prop}` = ${param}")
                params[param] = expected
        return (" AND ".join(clauses), params, labels)

    def get_nodes(
        self,
        label: str | Sequence[str] | None = None,
        where: Mapping[str, Any] | None = None,
        limit: Optional[int] = None,
        offset: int = 0,
    ) -> list[Node]:
        """Query nodes with a parameterised, validated predicate."""
        labels: list[str] = []
        if label is not None:
            wanted = [label] if isinstance(label, str) else list(label)
            labels = [self._validate_label(item) for item in wanted]
        clause, params, from_where = self._where_clause(where, "n")
        for extra in from_where:
            if extra not in labels:
                labels.append(extra)
        match = f"MATCH (n:{'|'.join(labels)})" if labels else "MATCH (n)"
        cypher = f"{match} WHERE {clause}" if clause else match
        cypher += f" {self._NODE_RETURN} ORDER BY n.id"
        if offset:
            cypher += f" SKIP {int(offset)}"
        if limit is not None:
            cypher += f" LIMIT {int(limit)}"
        return [self._row_to_node(row) for row in self._read(cypher, params).result_set]

    def get_edges(
        self,
        src: str | Sequence[str] | None = None,
        rel: str | Sequence[str] | None = None,
        dst: str | Sequence[str] | None = None,
        where: Mapping[str, Any] | None = None,
        limit: Optional[int] = None,
        offset: int = 0,
    ) -> list[Edge]:
        """Query edges with a parameterised, validated predicate."""
        rel_part = ""
        if rel is not None:
            rels = [rel] if isinstance(rel, str) else list(rel)
            rel_part = ":" + "|".join(self._validate_rel(item) for item in rels)
        clauses: list[str] = []
        params: dict[str, Any] = {}
        for name, value in (("src", src), ("dst", dst)):
            if isinstance(value, str):
                clauses.append(f"{'a' if name == 'src' else 'b'}.id = $ep_{name}")
                params[f"ep_{name}"] = value
            elif value:
                clauses.append(f"{'a' if name == 'src' else 'b'}.id IN $ep_{name}")
                params[f"ep_{name}"] = list(value)
        prop_clause, prop_params, _ = self._where_clause(where, "r")
        if prop_clause:
            clauses.append(prop_clause)
            params.update(prop_params)
        cypher = f"MATCH (a)-[r{rel_part}]->(b)"
        if clauses:
            cypher += " WHERE " + " AND ".join(clauses)
        cypher += " RETURN a.id AS src, type(r) AS rel, b.id AS dst, properties(r) AS props"
        cypher += " ORDER BY src, rel, dst"
        if offset:
            cypher += f" SKIP {int(offset)}"
        if limit is not None:
            cypher += f" LIMIT {int(limit)}"
        return [self._row_to_edge(row) for row in self._read(cypher, params).result_set]

    def node_count(self) -> int:
        """Total nodes."""
        rows = self._read("MATCH (n) RETURN count(n)").result_set
        return int(rows[0][0]) if rows else 0

    def edge_count(self) -> int:
        """Total edges."""
        rows = self._read("MATCH ()-[r]->() RETURN count(r)").result_set
        return int(rows[0][0]) if rows else 0

    # ------------------------------------------------------- native traversal
    def native_candidate_decisions(self, fact_id: str, depth: int = 3) -> dict[str, Any]:
        """Corrected Cypher traversal from the proposal (read-only).

        Returns ``{"assumptions": [...], "seed_decisions": [...],
        "dependents": {seed_decision_id: [dependent_decision_id, ...]}}``.

        Only used as an optimisation: :func:`tripwire.core.staleness.propagate`
        reconstructs and validates paths in Python, and a parity test asserts
        identical decision sets.
        """
        if not isinstance(depth, int) or not 0 <= depth <= 8:
            raise StoreError(f"depth must be an int within [0, 8], got {depth!r}")
        seeds = self._read(
            CORRECTED_PROPAGATION_CYPHER, {"fact_id": fact_id}
        ).result_set
        assumptions: list[str] = []
        seed_decisions: list[str] = []
        for assumption_id, decision_id in seeds:
            if assumption_id not in assumptions:
                assumptions.append(assumption_id)
            if decision_id not in seed_decisions:
                seed_decisions.append(decision_id)
        dependents: dict[str, list[str]] = {}
        cypher = NATIVE_DEPENDENTS_CYPHER.format(depth=depth)
        for decision_id in seed_decisions:
            rows = self._read(cypher, {"decision_id": decision_id}).result_set
            dependents[decision_id] = sorted({str(row[0]) for row in rows})
        return {
            "assumptions": assumptions,
            "seed_decisions": seed_decisions,
            "dependents": dependents,
        }

    def run_explain(self, cypher: str, params: Mapping[str, Any] | None = None) -> Any:
        """Return FalkorDB's execution plan for an *internal* query.

        Provided for diagnostics and documentation only.  Callers cannot reach
        this from the HTTP API or MCP tools: no endpoint accepts raw Cypher
        (spec S16).
        """
        return self._graph.explain(cypher, params or {})

    def health(self) -> dict[str, Any]:
        """Liveness probe that never raises."""
        try:
            self._graph.ro_query("RETURN 1")
            return {
                "backend": self.backend,
                "ok": True,
                "nodes": self.node_count(),
                "edges": self.edge_count(),
                "host": self.host,
                "port": self.port,
                "graph": self.graph_name,
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "backend": self.backend,
                "ok": False,
                "error": str(exc),
                "host": self.host,
                "port": self.port,
                "graph": self.graph_name,
            }

    def close(self) -> None:
        """Close the underlying connection pool."""
        try:
            self._client.close()
        except Exception:  # noqa: BLE001 - best-effort cleanup
            pass

    def stats(self) -> dict[str, Any]:
        """Summary including server identity for the health endpoint."""
        info = super().stats()
        info.update({"host": self.host, "port": self.port, "graph": self.graph_name})
        return info

    def list_labels(self) -> list[str]:
        """Distinct labels actually present (diagnostics)."""
        rows = self._read("CALL db.labels()").result_set
        return sorted(str(row[0]) for row in rows)

    def list_rel_types(self) -> list[str]:
        """Distinct relationship types actually present (diagnostics)."""
        rows = self._read("CALL db.relationshipTypes()").result_set
        return sorted(str(row[0]) for row in rows)
