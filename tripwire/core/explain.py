"""Provenance and explanations (``explain_path``).

Every alert must be explainable using **actual graph relationships and source
records** (spec S9).  The single most important rule here: an explanation never
claims evidence exists when the graph contains no supporting path.  When nothing
connects two entities the response says so explicitly, with ``found: false``, a
`missing` list and a human-readable reason - it does not synthesise a plausible
story.

Output is structured for direct rendering: nodes, edges, people, sources,
timestamps, confidence, review status, alternate evidence and the reason a
decision was flagged.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional, Sequence

from .index import DIRECTION_BOTH, DIRECTION_IN, DIRECTION_OUT, GraphIndex
from .models import Edge, Node
from .timeutil import now_iso

__all__ = [
    "explain_decision",
    "explain_fact_change",
    "explain_path",
    "explain_alert",
    "provenance_chain",
    "decision_dependencies",
]


# --------------------------------------------------------------------------- #
# Building blocks
# --------------------------------------------------------------------------- #
def source_artifacts(index: GraphIndex, fact_id: str) -> list[dict[str, Any]]:
    """Source messages/documents that state a fact, with author and timestamp."""
    artifacts: list[dict[str, Any]] = []
    for artifact_id in index.sources(fact_id, ["STATES"]):
        artifact = index.node(artifact_id)
        if artifact is None:
            continue
        author_ids = index.sources(artifact_id, ["AUTHORED"])
        artifacts.append(
            {
                "source_id": artifact_id,
                "label": artifact.label,
                "name": artifact.name,
                "doc_type": artifact.props.get("doc_type"),
                "timestamp": artifact.props.get("timestamp"),
                "source_ref": artifact.props.get("source_ref"),
                "url": artifact.props.get("url"),
                "author_id": author_ids[0] if author_ids else artifact.props.get("author_id"),
                "author_name": index.name(author_ids[0]) if author_ids else None,
                "channel": artifact.props.get("channel"),
                "confidence": artifact.props.get("confidence"),
                "excerpt": artifact.props.get("text") or artifact.props.get("summary"),
            }
        )
    artifacts.sort(key=lambda item: (item["timestamp"] or "", item["source_id"]))
    return artifacts


def provenance_chain(index: GraphIndex, fact_id: str) -> dict[str, Any]:
    """Full provenance for a fact: the claim, its status and its real sources."""
    node = index.node(fact_id)
    if node is None:
        return {"fact_id": fact_id, "found": False, "sources": []}
    return {
        "fact_id": fact_id,
        "found": True,
        "name": node.name,
        "statement": node.props.get("statement"),
        "value": node.props.get("value"),
        "attribute": node.props.get("attribute"),
        "subject_id": node.props.get("subject_id"),
        "subject_name": node.props.get("subject_name") or index.name(node.props.get("subject_id")),
        "status": node.props.get("status"),
        "confidence": node.props.get("confidence"),
        "verified": node.props.get("verified", True),
        "valid_from": node.props.get("valid_from"),
        "valid_to": node.props.get("valid_to"),
        "recorded_at": node.props.get("recorded_at"),
        "recorded_to": node.props.get("recorded_to"),
        "sources": source_artifacts(index, fact_id),
    }


def decision_dependencies(index: GraphIndex, decision_id: str) -> list[dict[str, Any]]:
    """Assumptions a decision rests on, each with its supporting facts."""
    dependencies: list[dict[str, Any]] = []
    for edge in index.out(decision_id, ["ASSUMES"]):
        assumption = index.node(edge.dst)
        if assumption is None:
            continue
        facts = []
        for support in index.out(assumption.id, ["SUPPORTED_BY"]):
            fact = index.node(support.dst)
            if fact is None:
                continue
            facts.append(
                {
                    **provenance_chain(index, fact.id),
                    "edge_recorded_at": support.props.get("recorded_at"),
                }
            )
        dependencies.append(
            {
                "assumption_id": assumption.id,
                "name": assumption.name,
                "statement": assumption.props.get("statement"),
                "status": assumption.props.get("status"),
                "confidence": assumption.props.get("confidence"),
                "edge_recorded_at": edge.props.get("recorded_at"),
                "facts": facts,
            }
        )
    dependencies.sort(key=lambda item: item["assumption_id"])
    return dependencies


def _contributors(index: GraphIndex, decision: Node, limit: int = 6) -> list[dict[str, Any]]:
    """People directly connected to a decision (maker, author of its sources)."""
    people: dict[str, dict[str, Any]] = {}
    for person_id in index.sources(decision.id, ["MADE"]):
        people[person_id] = {
            "person_id": person_id,
            "person_name": index.name(person_id),
            "relation": "MADE",
            "detail": "Made this decision",
        }
    for dependency in decision_dependencies(index, decision.id):
        for fact in dependency["facts"]:
            for source in fact["sources"]:
                author_id = source.get("author_id")
                if author_id and author_id not in people:
                    people[author_id] = {
                        "person_id": author_id,
                        "person_name": index.name(author_id),
                        "relation": "AUTHORED_SOURCE",
                        "detail": f"Authored source for '{fact['name']}'",
                    }
    ordered = sorted(people.values(), key=lambda item: (item["relation"], item["person_id"]))
    return ordered[:limit]


# --------------------------------------------------------------------------- #
# Explanations
# --------------------------------------------------------------------------- #
def explain_decision(
    index: GraphIndex,
    decision_id: str,
    *,
    store: Any = None,
    max_paths: int = 4,
) -> dict[str, Any]:
    """Explain a decision fully: dependencies, evidence, alerts and uncertainty."""
    decision = index.node(decision_id)
    if decision is None:
        return {
            "found": False,
            "decision_id": decision_id,
            "reason": f"Decision {decision_id!r} is not present in the graph.",
            "missing": [decision_id],
        }

    dependencies = decision_dependencies(index, decision_id)

    # Evidence paths run from each supporting fact to the decision, so a reader can
    # see exactly which claim props up which assumption.
    paths: list[dict[str, Any]] = []
    missing: list[str] = []
    for dependency in dependencies:
        if not dependency["facts"]:
            missing.append(f"assumption:{dependency['assumption_id']} (no supporting fact)")
            continue
        for fact in dependency["facts"]:
            chain = [
                Edge(src=dependency["assumption_id"], rel="SUPPORTED_BY", dst=fact["fact_id"]),
                Edge(src=decision_id, rel="ASSUMES", dst=dependency["assumption_id"]),
            ]
            path = index.walk_path(fact["fact_id"], chain)
            if path.steps:
                paths.append(
                    {
                        "from_fact_id": fact["fact_id"],
                        "assumption_id": dependency["assumption_id"],
                        "path": path.as_dict(),
                    }
                )
            if len(paths) >= max_paths:
                break
        if len(paths) >= max_paths:
            break

    confidences = [
        float(fact["confidence"])
        for dependency in dependencies
        for fact in dependency["facts"]
        if fact.get("confidence") is not None
    ]
    confidence = min(confidences) if confidences else None

    alerts: list[dict[str, Any]] = []
    if store is not None:
        for edge in store.get_edges(dst=decision_id, rel="AFFECTS"):
            alert = store.get_node(edge.src)
            if alert is None:
                continue
            alerts.append(
                {
                    "alert_id": alert.id,
                    "status": alert.props.get("status"),
                    "severity": alert.props.get("severity"),
                    "certainty": edge.props.get("certainty") or alert.props.get("certainty"),
                    "confidence": alert.props.get("confidence"),
                    "summary": alert.props.get("summary"),
                    "created_at": alert.props.get("created_at"),
                    "reason": edge.props.get("reason") or alert.props.get("reason"),
                }
            )
        alerts.sort(key=lambda item: item["alert_id"])

    stale_reason = decision.props.get("stale_reason")
    why_flagged = (
        stale_reason
        if stale_reason
        else (
            "Not currently flagged: no contradicting fact has propagated to this decision."
            if not alerts
            else f"Flagged by {len(alerts)} alert(s) for review; not automatically invalidated."
        )
    )

    return {
        "found": True,
        "decision": decision.to_view(),
        "status": decision.props.get("status"),
        "previous_status": decision.props.get("previous_status"),
        "stale_reason": stale_reason,
        "stale_since": decision.props.get("stale_since"),
        "review_status": decision.props.get("review_status"),
        "why_flagged": why_flagged,
        "confidence": confidence,
        "assumption_count": len(dependencies),
        "dependencies": dependencies,
        "evidence_paths": paths,
        "alerts": alerts,
        "alternate_evidence": _alternate_evidence(index, decision_id),
        "people": _contributors(index, decision),
        "missing": missing,
        "generated_at": now_iso(),
    }


def _alternate_evidence(index: GraphIndex, decision_id: str) -> list[dict[str, Any]]:
    """Supporting facts that survive for a decision, with their sources."""
    evidence: list[dict[str, Any]] = []
    for dependency in decision_dependencies(index, decision_id):
        for fact in dependency["facts"]:
            if str(fact.get("status")) == "INVALIDATED":
                continue
            evidence.append(
                {
                    "assumption_id": dependency["assumption_id"],
                    "fact_id": fact["fact_id"],
                    "fact_name": fact["name"],
                    "value": fact.get("value"),
                    "status": fact.get("status"),
                    "source_count": len(fact.get("sources") or []),
                }
            )
    evidence.sort(key=lambda item: (item["assumption_id"], item["fact_id"]))
    return evidence


def explain_fact_change(index: GraphIndex, fact_id: str, *, store: Any = None) -> dict[str, Any]:
    """Explain what a fact contradicts (or is contradicted by) and why it matters."""
    node = index.node(fact_id)
    if node is None:
        return {
            "found": False,
            "fact_id": fact_id,
            "reason": f"Fact {fact_id!r} is not present in the graph.",
            "missing": [fact_id],
        }

    contradictions: list[dict[str, Any]] = []
    for edge in index.incoming(fact_id, ["CONTRADICTS"]):
        contradictions.append(_contradiction_view(index, edge.src, fact_id, edge))
    for edge in index.out(fact_id, ["CONTRADICTS"]):
        contradictions.append(_contradiction_view(index, fact_id, edge.dst, edge))
    contradictions.sort(key=lambda item: item["other_fact_id"])

    affected: list[dict[str, Any]] = []
    if store is not None:
        for edge in store.get_edges(src=fact_id, rel="STALED") + store.get_edges(dst=fact_id, rel="STALED"):
            other = edge.dst if edge.src == fact_id else edge.src
            affected.append(
                {
                    "entity_id": other,
                    "entity_name": index.name(other),
                    "entity_label": index.label(other),
                    "reason": edge.props.get("reason"),
                    "at": edge.props.get("at"),
                    "alert_id": edge.props.get("alert_id"),
                }
            )

    assumptions = [
        {"assumption_id": assumption_id, "name": index.name(assumption_id)}
        for assumption_id in index.sources(fact_id, ["SUPPORTED_BY"])
        if index.label(assumption_id) == "Assumption"
    ]

    return {
        "found": True,
        "fact": node.to_view(),
        "provenance": provenance_chain(index, fact_id),
        "contradictions": contradictions,
        "contradiction_count": len(contradictions),
        "supporting_assumptions": assumptions,
        "affected_entities": affected,
        "missing": [] if contradictions else ["no CONTRADICTS relationship recorded"],
        "generated_at": now_iso(),
    }


def _contradiction_view(
    index: GraphIndex, new_fact_id: str, old_fact_id: str, edge: Edge
) -> dict[str, Any]:
    """Structured view of one CONTRADICTS relationship."""
    other = index.node(new_fact_id)
    return {
        "new_fact_id": new_fact_id,
        "new_fact_name": index.name(new_fact_id),
        "new_value": other.props.get("value") if other else None,
        "other_fact_id": old_fact_id,
        "other_fact_name": index.name(old_fact_id),
        "other_value": index.prop(old_fact_id, "value"),
        "kind": edge.props.get("kind"),
        "status": edge.props.get("status"),
        "confidence": edge.props.get("confidence"),
        "review_status": edge.props.get("review_status"),
        "at": edge.props.get("at"),
        "rule": edge.props.get("rule"),
        "rationale": edge.props.get("rationale"),
    }


def explain_path(
    index: GraphIndex,
    source_id: str,
    target_id: str,
    *,
    rels: Iterable[str] | None = None,
    max_depth: int = 6,
    limit: int = 5,
) -> dict[str, Any]:
    """Find and render the relationship path(s) connecting two entities."""
    if index.node(source_id) is None:
        return {
            "found": False,
            "source": {"id": source_id, "found": False},
            "target": {"id": target_id, "found": index.node(target_id) is not None},
            "paths": [],
            "reason": f"Source {source_id!r} is not present in the graph.",
        }
    if index.node(target_id) is None:
        return {
            "found": False,
            "source": {"id": source_id, "found": True},
            "target": {"id": target_id, "found": False},
            "paths": [],
            "reason": f"Target {target_id!r} is not present in the graph.",
        }

    forward = index.all_paths(
        source_id, target_id, rels=rels, direction=DIRECTION_OUT, max_depth=max_depth, limit=limit
    )
    backward = index.all_paths(
        source_id, target_id, rels=rels, direction=DIRECTION_IN, max_depth=max_depth, limit=limit
    )
    combined: dict[tuple[str, ...], Any] = {}
    for path in forward + backward:
        combined.setdefault(path.key, path)
    paths = sorted(combined.values(), key=lambda p: (len(p.steps), p.key))[:limit]

    return {
        "found": bool(paths),
        "source": index.describe_node(source_id),
        "target": index.describe_node(target_id),
        "path_count": len(paths),
        "paths": [path.as_dict() for path in paths],
        "reason": (
            "No relationship path connects these entities in the stored graph."
            if not paths
            else f"{len(paths)} simple relationship path(s) found."
        ),
        "generated_at": now_iso(),
    }


def explain_alert(index: GraphIndex, alert_id: str, *, store: Any) -> dict[str, Any]:
    """Explain an alert end to end, starting from its own recorded evidence."""
    alert = store.get_node(alert_id) if store is not None else index.node(alert_id)
    if alert is None or alert.label != "Alert":
        return {
            "found": False,
            "alert_id": alert_id,
            "reason": f"Alert {alert_id!r} is not present in the graph.",
            "missing": [alert_id],
        }

    view = alert.to_view()
    old_fact_id = alert.props.get("old_fact_id")
    new_fact_id = alert.props.get("new_fact_id")
    entity_id = alert.props.get("entity_id")

    evidence: dict[str, Any] = {}
    if new_fact_id:
        evidence["new_fact"] = provenance_chain(index, new_fact_id)
    if old_fact_id:
        evidence["old_fact"] = provenance_chain(index, old_fact_id)

    path_nodes = list(alert.props.get("path_nodes") or [])
    path_rels = list(alert.props.get("path_rels") or [])
    reconstructed: list[dict[str, Any]] = []
    if entity_id and new_fact_id:
        # Reconstruct through the graph rather than trusting the cached path, so a
        # stale cache cannot produce an explanation the graph no longer supports.
        explained = explain_path(index, new_fact_id, entity_id, max_depth=6, limit=3)
        reconstructed = explained.get("paths", [])

    impact: dict[str, Any] = {}
    if entity_id:
        impact = explain_decision(index, entity_id, store=store) if index.label(entity_id) == "Decision" else {
            "found": True,
            "entity": index.describe_node(entity_id),
        }

    sources: list[dict[str, Any]] = []
    for fact_key in ("new_fact", "old_fact"):
        fact = evidence.get(fact_key) or {}
        for source in fact.get("sources") or []:
            sources.append({**source, "role": fact_key})
    sources.sort(key=lambda item: (item["timestamp"] or "", item["source_id"]))

    return {
        "found": True,
        "alert": view,
        "status": alert.props.get("status"),
        "severity": alert.props.get("severity"),
        "certainty": alert.props.get("certainty"),
        "confidence": alert.props.get("confidence"),
        "summary": alert.props.get("summary"),
        "why_flagged": alert.props.get("reason"),
        "evidence": evidence,
        "evidence_path": {
            "cached_nodes": path_nodes,
            "cached_rels": path_rels,
            "reconstructed": reconstructed,
            "reconstruction_found": bool(reconstructed),
        },
        "sources": sources,
        "impact": impact,
        "reviewers": list(alert.props.get("reviewers") or []),
        "missing": [
            item
            for item, present in (
                ("new_fact", bool(new_fact_id and index.node(new_fact_id))),
                ("old_fact", bool(old_fact_id and index.node(old_fact_id))),
                ("entity", bool(entity_id and index.node(entity_id))),
            )
            if not present
        ],
        "generated_at": now_iso(),
    }
