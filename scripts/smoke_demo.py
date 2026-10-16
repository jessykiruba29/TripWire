"""Developer smoke test: seed the graph and run the headline demo flow offline.

Runs entirely against the in-process store with no Docker, no network and no LLM
credentials, so it is safe to run anywhere::

    python scripts/smoke_demo.py

It is a convenience check, not a substitute for the test-suite (``pytest``).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tripwire.config import Settings
from tripwire.core.engine import GraphEngine
from tripwire.core.store import MemoryGraphStore


def main() -> int:
    settings = Settings(store_backend="memory")
    engine = GraphEngine(MemoryGraphStore(), settings=settings)

    seeded = engine.seed_demo()
    print("=== SEED ===")
    print(json.dumps(seeded["manifest"]["expected_counts"], indent=2))
    print("actual:", json.dumps(seeded["actual_counts"]["by_label"], indent=2))
    print("matches:", json.dumps(seeded["state"]["dataset"]["matches_expected"], indent=2))

    second = engine.seed_demo()
    print("\n=== SEED IDEMPOTENCY ===")
    print("nodes after reseed:", second["nodes_after"], "edges after reseed:", second["edges_after"])

    result = engine.trigger_event({"scenario": "frankfurt_compliance_revoked"})
    print("\n=== CONTRADICTION ===")
    print("detected:", result["contradiction"]["detected"])
    print("primary:", json.dumps(result["contradiction"].get("primary"), indent=2)[:900])
    print("summary:", result["contradiction"]["summary"])

    print("\n=== IMPACTS ===")
    for impact in result["impacts"]:
        alert = impact.get("alert") or {}
        print(
            f"- {impact['entity_label']} {impact['entity_id']} "
            f"status {impact['status_before']} -> {impact['status_after']} "
            f"certainty={impact['certainty']} alternate={impact['has_alternate_evidence']} "
            f"alert={alert.get('alert_id')} ({alert.get('status')})"
        )
        for path in impact.get("paths", [])[:1]:
            print(f"    path: {path.get('narrative')}")

    print("\n=== PROPAGATION NOTES ===")
    for note in result["propagation"]["notes"]:
        print("-", note)

    print("\n=== UNRELATED DECISIONS (must stay ACTIVE) ===")
    for key in ("apac_decision", "dark_mode_decision", "warehouse_decision"):
        node = engine.store.get_node(engine.demo_state()["key_entities"][key])
        print(f"- {node.id}: {node.props.get('status')}")

    print("\n=== HIDDEN EXPERT ===")
    experts = engine.find_experts("EU Launch", limit=4)
    for expert in experts["experts"]:
        print(
            f"- #{expert['rank']} {expert['person_name']} ({expert['role']}) "
            f"score={expert['normalized_score']} owner={expert['is_official_owner']} "
            f"shadow={expert['shadow_signal']}"
        )
    print("hidden_experts:", [e["person_name"] for e in experts["hidden_experts"]])

    print("\n=== NO-ALERT SCENARIOS (restraint) ===")
    for scenario in ("additive_edge_cache_provider", "ambiguous_edge_cache_region",
                     "unrelated_mobile_theme_change", "pricing_rate_renewal_2027"):
        outcome = engine.trigger_event({"scenario": scenario})
        print(
            f"- {scenario}: detected={outcome['contradiction']['detected']} "
            f"summary={outcome['contradiction']['summary']} "
            f"impacts={len(outcome.get('impacts') or [])}"
        )

    print("\n=== REPLAY SAFETY (same event twice) ===")
    before = (engine.store.node_count(), engine.store.edge_count())
    replay = engine.trigger_event({"scenario": "frankfurt_compliance_revoked"})
    after = (engine.store.node_count(), engine.store.edge_count())
    print(f"nodes {before[0]} -> {after[0]}, edges {before[1]} -> {after[1]}")
    print("detected on replay:", replay["contradiction"]["detected"])
    print("alert ids:", replay["alert_ids"])

    print("\n=== REVIEWERS ASSIGNED ===")
    for impact in result["impacts"]:
        names = [r["person_name"] for r in impact.get("reviewers", [])]
        print(f"- {impact['entity_id']}: {names}")

    # A fresh graph so the unverified claim is evaluated against the *original*
    # belief (on a replayed graph the system already believes 'revoked', so the
    # second claim agrees with it rather than contradicting it).
    print("\n=== UNVERIFIED SCENARIO ON A FRESH GRAPH ===")
    fresh = GraphEngine(MemoryGraphStore(), settings=settings)
    fresh.seed_demo()
    unverified = fresh.trigger_event({"scenario": "frankfurt_compliance_revoked_unverified"})
    print("detected:", unverified["contradiction"]["detected"])
    print("kinds:", unverified["contradiction"]["summary"])
    old = fresh.store.get_node(fresh.demo_state()["key_entities"]["compliance_fact"])
    print("compliance fact status:", old.props.get("status"), "recorded_to:", old.props.get("recorded_to"))
    for impact in unverified["impacts"]:
        print(f"- {impact['entity_id']}: certainty={impact['certainty']} status_after={impact['status_after']}")

    print("\n=== HEALTH ===")
    print(json.dumps(engine.health(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
