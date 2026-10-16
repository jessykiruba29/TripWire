"""Graph creation, retrieval, store semantics, seeding and entity resolution.

Covers spec S15: *graph creation and retrieval*, *seed idempotency and reset*,
*entity resolution and duplicate prevention*.
"""

from __future__ import annotations

import pytest

from tripwire.config import Settings
from tripwire.core.engine import GraphEngine
from tripwire.core.errors import SchemaError, StoreUnavailableError
from tripwire.core.models import Edge, Node
from tripwire.core.schema import NODE_TYPES, REL_TYPES
from tripwire.core.store import JsonGraphStore, MemoryGraphStore, create_store
from tripwire.dataset.northwind import dataset_manifest


@pytest.fixture()
def engine() -> GraphEngine:
    """A fresh, unseeded engine over an in-memory store."""
    return GraphEngine(MemoryGraphStore(), settings=Settings(store_backend="memory"))


@pytest.fixture()
def seeded(engine: GraphEngine) -> GraphEngine:
    """A seeded engine."""
    engine.seed_demo()
    return engine


def tiny_store() -> MemoryGraphStore:
    """A two-node store used for primitive-level assertions."""
    store = MemoryGraphStore()
    store.upsert_node(Node(id="person:a", label="Person", name="A"))
    store.upsert_node(Node(id="project:p", label="Project", name="P"))
    return store


# --------------------------------------------------------------------------- #
# Primitives
# --------------------------------------------------------------------------- #
def test_store_creates_and_retrieves_nodes_and_edges() -> None:
    store = tiny_store()
    store.upsert_edge(Edge(src="person:a", rel="MADE", dst="project:p"))

    assert store.node_count() == 2
    assert store.edge_count() == 1
    assert store.get_node("person:a").name == "A"
    assert store.get_edge if hasattr(store, "get_edge") else True  # documented optional
    edges = store.get_edges(src="person:a", rel="MADE")
    assert [(e.src, e.rel, e.dst) for e in edges] == [("person:a", "MADE", "project:p")]
    assert store.neighbors("project:p", direction="in")[0][1] == "person:a"


def test_store_rejects_edges_to_missing_endpoints() -> None:
    store = tiny_store()
    with pytest.raises(KeyError):
        store.upsert_edge(Edge(src="person:a", rel="MADE", dst="project:missing"))


def test_store_rejects_unknown_labels_and_relationships() -> None:
    store = tiny_store()
    with pytest.raises(SchemaError):
        store.upsert_node(Node(id="x:1", label="Widget", name="W"))
    with pytest.raises(SchemaError):
        store.upsert_edge(Edge(src="person:a", rel="FRIENDS_WITH", dst="project:p"))


def test_upsert_merges_and_never_erases_with_none() -> None:
    store = tiny_store()
    store.upsert_node(Node(id="system:s", label="System", name="S", props={"region": "eu", "tier": "1"}))
    store.upsert_node(Node(id="system:s", label="System", name="S", props={"region": None, "tier": "2"}))

    node = store.get_node("system:s")
    assert node.props["region"] == "eu", "a None value must not erase existing data"
    assert node.props["tier"] == "2", "later non-None values win"


def test_recorded_at_is_immutable_once_set() -> None:
    """Re-ingesting a source must not pretend Tripwire learned it today."""
    store = tiny_store()
    store.upsert_node(
        Node(id="fact:f", label="Fact", name="F", props={"recorded_at": "2026-01-01T00:00:00Z"})
    )
    store.upsert_node(
        Node(id="fact:f", label="Fact", name="F", props={"recorded_at": "2026-09-09T00:00:00Z"})
    )
    assert store.get_node("fact:f").props["recorded_at"] == "2026-01-01T00:00:00Z"


def test_delete_node_removes_incident_edges() -> None:
    store = tiny_store()
    store.upsert_edge(Edge(src="person:a", rel="MADE", dst="project:p"))
    assert store.delete_node("project:p") is True
    assert store.edge_count() == 0


def test_clear_wipes_the_graph() -> None:
    store = tiny_store()
    store.clear()
    assert store.node_count() == 0 and store.edge_count() == 0


def test_create_store_factory_and_unknown_backend() -> None:
    assert isinstance(create_store("memory"), MemoryGraphStore)
    with pytest.raises(ValueError):
        create_store("nonsense")


def test_falkordb_backend_degrades_when_unreachable() -> None:
    """An unreachable database must raise a typed error, not hang or crash.

    This is a *connectivity* test: it asserts the adapter's documented behaviour
    when no FalkorDB server is running (the normal case on this machine).
    """
    from tripwire.core.falkor_store import FalkorGraphStore

    with pytest.raises(StoreUnavailableError) as excinfo:
        FalkorGraphStore(host="127.0.0.1", port=6399, socket_timeout=1.0)
    assert excinfo.value.code == "store_unavailable"
    assert "docker compose" in excinfo.value.message


# --------------------------------------------------------------------------- #
# JSON store
# --------------------------------------------------------------------------- #
def test_json_store_persists_and_reloads(tmp_path) -> None:
    path = str(tmp_path / "graph.json")
    first = JsonGraphStore(path)
    first.upsert_node(Node(id="team:t", label="Team", name="T"))
    first.upsert_node(Node(id="person:p", label="Person", name="P"))
    first.upsert_edge(Edge(src="person:p", rel="ON_TEAM", dst="team:t"))
    assert first.node_count() == 2

    second = JsonGraphStore(path)
    assert second.node_count() == 2
    assert second.edge_count() == 1
    assert second.get_node("person:p").name == "P"


def test_json_store_second_write_does_not_recurse(tmp_path) -> None:
    """Regression test: a second mutating process used to hit infinite recursion.

    ``save()`` serialises the graph (which reads nodes) while the reader overrides
    reload from disk, so without a re-entrancy guard ``load``/``save`` recursed
    until the interpreter crashed.
    """
    path = str(tmp_path / "graph.json")
    JsonGraphStore(path).upsert_node(Node(id="team:t", label="Team", name="T"))

    second = JsonGraphStore(path)
    second.upsert_node(Node(id="person:p", label="Person", name="P"))
    second.clear()
    second.upsert_node(Node(id="system:s", label="System", name="S"))

    third = JsonGraphStore(path)
    assert [node.id for node in third.all_nodes()] == ["system:s"]


def test_json_store_reloads_when_another_writer_changes_the_file(tmp_path) -> None:
    path = str(tmp_path / "graph.json")
    writer = JsonGraphStore(path)
    writer.upsert_node(Node(id="team:t", label="Team", name="T"))

    reader = JsonGraphStore(path)
    assert reader.node_count() == 1

    writer.upsert_node(Node(id="team:u", label="Team", name="U"))
    assert reader.node_count() == 2, "the reader must observe the other process's write"


# --------------------------------------------------------------------------- #
# Seeding
# --------------------------------------------------------------------------- #
def test_seed_matches_the_manifest_counts(seeded: GraphEngine) -> None:
    state = seeded.demo_state()
    expected = dataset_manifest()["expected_counts"]
    actual = state["counts"]["by_label"]

    for label, count in expected.items():
        assert actual.get(label) == count, f"{label}: expected {count}, got {actual.get(label)}"
    assert state["dataset"]["matches_expected"] == {label: True for label in expected}
    assert state["seeded"] is True


def test_seed_is_idempotent(engine: GraphEngine) -> None:
    engine.seed_demo()
    after_first = (engine.store.node_count(), engine.store.edge_count())

    engine.seed_demo()
    after_second = (engine.store.node_count(), engine.store.edge_count())

    assert after_second == after_first, "re-seeding must not duplicate records"


def test_seed_creates_only_schema_valid_nodes_and_edges(seeded: GraphEngine) -> None:
    for node in seeded.store.all_nodes():
        assert node.label in NODE_TYPES
    for edge in seeded.store.all_edges():
        assert edge.rel in REL_TYPES


def test_seed_creates_no_dangling_edges(seeded: GraphEngine) -> None:
    ids = {node.id for node in seeded.store.all_nodes()}
    dangling = [edge for edge in seeded.store.all_edges() if edge.src not in ids or edge.dst not in ids]
    assert dangling == []


def test_reset_restores_the_pristine_demonstration_state(engine: GraphEngine) -> None:
    engine.seed_demo()
    engine.trigger_event({"scenario": "frankfurt_compliance_revoked"})
    assert engine.store.get_node("decision:eu-launch").props["status"] == "POTENTIALLY_STALE"

    result = engine.reset()
    assert result["reset"] is True

    manifest = dataset_manifest()["expected_counts"]
    counts = engine.counts()["by_label"]
    for label, expected in manifest.items():
        assert counts.get(label) == expected, label
    assert engine.alerts()["total"] == 0, "reset must remove previously raised alerts"
    assert engine.store.get_node("decision:eu-launch").props["status"] == "ACTIVE"


# --------------------------------------------------------------------------- #
# Entity resolution / de-duplication
# --------------------------------------------------------------------------- #
def test_entity_resolution_is_case_and_separator_insensitive(seeded: GraphEngine) -> None:
    for variant in ("frankfurt hosting partner", "Frankfurt  Hosting Partner", "FRANKFURT HOSTING PARTNER"):
        assert seeded.ensure_entity(variant, label="System").id == "system:frankfurt-hosting-partner"


def test_entity_resolution_accepts_an_id_directly(seeded: GraphEngine) -> None:
    assert seeded.ensure_entity("system:frankfurt-hosting-partner").id == "system:frankfurt-hosting-partner"


def test_restating_the_same_fact_does_not_create_a_second_fact(seeded: GraphEngine) -> None:
    """A restatement is recorded once: no duplicate Fact, and the event converges.

    The restatement *is* logged as a ``FACT_RESTATED`` event (that history is
    legitimate), but the event id is stable, so a third restatement adds nothing.
    """
    restate = lambda: seeded.assert_fact(  # noqa: E731 - local test helper
        subject="Frankfurt Hosting Partner",
        attribute="pilot_status",
        value="agreed",
        statement="The partner pilot is agreed.",
        valid_from="2026-03-01T00:00:00Z",
    )

    first = restate()
    facts_after_first = len(seeded.store.get_nodes(label="Fact"))
    second = restate()
    after_second = (seeded.store.node_count(), seeded.store.edge_count())
    third = restate()

    assert first.fact_id == second.fact_id == third.fact_id
    assert first.created is True and second.created is False and third.created is False
    assert len(seeded.store.get_nodes(label="Fact")) == facts_after_first
    assert (seeded.store.node_count(), seeded.store.edge_count()) == after_second, (
        "a repeated restatement must converge, adding no further events or edges"
    )


def test_contradicting_claims_get_distinct_fact_ids(seeded: GraphEngine) -> None:
    """Conflicting claims must be separate records, never an overwrite."""
    valid = seeded.assert_fact(
        subject="Billing Service", attribute="licence_status", value="valid",
        statement="Licence valid.", valid_from="2026-01-01T00:00:00Z",
    )
    revoked = seeded.assert_fact(
        subject="Billing Service", attribute="licence_status", value="revoked",
        statement="Licence revoked.", valid_from="2026-01-01T00:00:00Z",
    )
    assert valid.fact_id != revoked.fact_id
    assert seeded.store.get_node(valid.fact_id) is not None
    assert seeded.store.get_node(revoked.fact_id) is not None


def test_same_claim_for_a_different_period_is_a_distinct_fact(seeded: GraphEngine) -> None:
    first = seeded.assert_fact(
        subject="Frankfurt Hosting Partner", attribute="pricing", value="rate_a",
        statement="Rate A.", valid_from="2026-01-01T00:00:00Z",
    )
    second = seeded.assert_fact(
        subject="Frankfurt Hosting Partner", attribute="pricing", value="rate_a",
        statement="Rate A renewed.", valid_from="2027-01-01T00:00:00Z",
    )
    assert first.fact_id != second.fact_id


def test_repeated_ingestion_of_one_source_is_a_no_op(seeded: GraphEngine) -> None:
    record = {
        "source": "slack",
        "record": {
            "external_id": "dedupe-1",
            "channel": "#eu-launch",
            "author": "Priya Raman",
            "timestamp": "2026-03-02T09:00:00Z",
            "mentions": ["EU Launch"],
            "text": "Kicking off the EU Launch readiness review.",
        },
    }
    first = seeded.ingest_source(record)
    after_first = seeded.store.node_count()
    second = seeded.ingest_source(record)

    assert first["source"]["id"] == second["source"]["id"]
    assert second["source"]["duplicate_source"] is True
    assert seeded.store.node_count() == after_first, "re-ingesting must not add nodes"
