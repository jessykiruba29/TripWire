"""Staleness propagation (``propagate_staleness``).

Starting from a changed or contradicted fact, walk the graph
``Fact <-SUPPORTED_BY- Assumption <-ASSUMES- Decision`` and then forward through
``Decision <-DEPENDS_ON- Decision`` (plus ``Decision -IMPACTS-> Project``) to find
everything whose rationale rested on that fact.

On the proposed Cypher
----------------------
The original proposal's query is reproduced in
:data:`tripwire.core.falkor_store.PROPOSED_PROPAGATION_CYPHER`.  It was validated
against the real schema and found to need five corrections, each of which is
implemented and tested here:

1. ``SET d2.status = 'STALE'`` is **removed**.  A single changed fact must not
   invalidate a decision; propagation only ever proposes ``POTENTIALLY_STALE``
   (spec S7/S8).  Promotion to ``STALE`` is a reviewed, explicit act.
2. ``DEPENDS_ON*0..3`` was applied to a pattern that also matched multiple
   assumptions, producing a cartesian product of paths.  Expansion is now done
   per seed decision.
3. The dependent hop was required rather than optional, so a decision whose
   assumption was hit but which nothing depends on vanished from the result.  The
   seed decision is now always included.
4. Variable-length patterns return **one row per path**, so the same decision
   appeared many times.  Results are de-duplicated by node with a shortest-path
   tree.
5. ``<-[:DEPENDS_ON*0..3]-`` traverses dependents correctly, but ignores
   ``IMPACTS`` and ``Project`` entities; both are now included.

Restraint
---------
For every affected entity the engine looks for *surviving independent support*:
other facts still supporting the same assumption.  Where such evidence exists it
is returned explicitly, certainty stays ``potential``, and the decision is never
marked stale.  Only when an assumption has no surviving support at all - and no
intermediate decision on the path is independently supported - does the result
report ``confirmed``.

The module is **pure**: it plans a propagation and returns it.  Writing status
changes, events and alerts is :mod:`tripwire.core.engine`'s job, which keeps this
logic testable without a database.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Optional, Sequence

from .index import DIRECTION_BOTH, DIRECTION_IN, GraphIndex
from .models import Edge, EvidencePath
from .timeutil import parse_iso, now_iso

__all__ = [
    "AlternateEvidence",
    "AffectedEntity",
    "PropagationPlan",
    "plan_propagation",
    "DEPENDENCY_RELATIONSHIPS",
    "entity_certainty",
]

#: Relationships walked when expanding from a seed decision to what depends on it.
DEPENDENCY_RELATIONSHIPS: tuple[str, ...] = ("DEPENDS_ON", "IMPACTS")

#: Labels considered "affected entities".  Decisions are the primary unit of
#: review; Projects are included because the spec asks which projects a decision
#: affects.
AFFECTED_LABELS: tuple[str, ...] = ("Decision", "Project")

#: Fact statuses that no longer support anything.
_DEAD_FACT_STATUSES = frozenset({"INVALIDATED"})


@dataclass
class AlternateEvidence:
    """Independent support that keeps an assumption (and its decision) alive."""

    assumption_id: str
    assumption_name: str
    fact_id: str
    fact_value: Any = None
    fact_status: str = "ACTIVE"
    fact_confidence: float = 0.0
    source_id: Optional[str] = None
    why_survives: str = ""

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form."""
        return {
            "assumption_id": self.assumption_id,
            "assumption_name": self.assumption_name,
            "fact_id": self.fact_id,
            "fact_value": self.fact_value,
            "fact_status": self.fact_status,
            "fact_confidence": self.fact_confidence,
            "source_id": self.source_id,
            "why_survives": self.why_survives,
        }


@dataclass
class AffectedEntity:
    """A decision or project that may need review because of the changed fact."""

    entity_id: str
    entity_name: str
    entity_label: str
    seed_decision_id: Optional[str] = None
    depth: int = 0
    certainty: str = "potential"
    status_before: Optional[str] = None
    contributing_assumptions: list[str] = field(default_factory=list)
    contributing_facts: list[str] = field(default_factory=list)
    alternate_evidence: list[AlternateEvidence] = field(default_factory=list)
    paths: list[EvidencePath] = field(default_factory=list)
    reason: str = ""
    hops: int = 0

    @property
    def status_after(self) -> str:
        """Status the engine will write if the entity is still ``ACTIVE``."""
        return "POTENTIALLY_STALE"

    @property
    def has_alternate_evidence(self) -> bool:
        """True when independent support survives for this entity."""
        return bool(self.alternate_evidence)

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form, including rendered evidence paths."""
        return {
            "entity_id": self.entity_id,
            "entity_name": self.entity_name,
            "entity_label": self.entity_label,
            "seed_decision_id": self.seed_decision_id,
            "depth": self.depth,
            "certainty": self.certainty,
            "status_before": self.status_before,
            "status_after": self.status_after,
            "contributing_assumptions": list(self.contributing_assumptions),
            "contributing_facts": list(self.contributing_facts),
            "alternate_evidence": [e.as_dict() for e in self.alternate_evidence],
            "has_alternate_evidence": self.has_alternate_evidence,
            "reason": self.reason,
            "hops": self.hops,
            "paths": [p.as_dict() for p in self.paths],
        }


@dataclass
class PropagationPlan:
    """The complete, unwritten outcome of a propagation run."""

    source_fact_id: str
    source_fact_name: str = ""
    source_fact_status: str = ""
    source_fact_verified: bool = True
    assumptions: list[str] = field(default_factory=list)
    seed_decisions: list[str] = field(default_factory=list)
    affected: list[AffectedEntity] = field(default_factory=list)
    max_depth: int = 3
    notes: list[str] = field(default_factory=list)
    evaluated_at: str = ""

    @property
    def affected_decisions(self) -> list[AffectedEntity]:
        """Affected entities that are Decisions."""
        return [a for a in self.affected if a.entity_label == "Decision"]

    @property
    def affected_projects(self) -> list[AffectedEntity]:
        """Affected entities that are Projects."""
        return [a for a in self.affected if a.entity_label == "Project"]

    @property
    def confirmed(self) -> list[AffectedEntity]:
        """Entities with no surviving independent support."""
        return [a for a in self.affected if a.certainty == "confirmed"]

    @property
    def potential(self) -> list[AffectedEntity]:
        """Entities that still have independent support and must not be auto-staled."""
        return [a for a in self.affected if a.certainty == "potential"]

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form with a plain-language summary."""
        return {
            "source_fact_id": self.source_fact_id,
            "source_fact_name": self.source_fact_name,
            "source_fact_status": self.source_fact_status,
            "source_fact_verified": self.source_fact_verified,
            "evaluated_at": self.evaluated_at,
            "max_depth": self.max_depth,
            "assumptions": list(self.assumptions),
            "seed_decisions": list(self.seed_decisions),
            "counts": {
                "assumptions": len(self.assumptions),
                "seed_decisions": len(self.seed_decisions),
                "affected_total": len(self.affected),
                "affected_decisions": len(self.affected_decisions),
                "affected_projects": len(self.affected_projects),
                "confirmed": len(self.confirmed),
                "potential": len(self.potential),
            },
            "affected": [a.as_dict() for a in self.affected],
            "notes": list(self.notes),
        }


# --------------------------------------------------------------------------- #
# Support analysis
# --------------------------------------------------------------------------- #
def _surviving_facts(
    index: GraphIndex,
    assumption_id: str,
    *,
    exclude_fact_ids: Iterable[str] = (),
    reference_time: Optional[str] = None,
) -> list[str]:
    """Facts that still support ``assumption_id``.

    A fact survives when it is not the changed/contradicted fact, its status is
    not ``INVALIDATED``, it is still inside its real-world validity at
    ``reference_time``, and it was verified when extracted.
    """
    excluded = set(exclude_fact_ids)
    survivors: list[str] = []
    for fact_id in index.targets(assumption_id, ["SUPPORTED_BY"]):
        node = index.node(fact_id)
        if node is None or fact_id in excluded:
            continue
        if str(node.props.get("status") or "ACTIVE") in _DEAD_FACT_STATUSES:
            continue
        if not bool(node.props.get("verified", True)):
            continue
        if reference_time:
            end = parse_iso(node.props.get("valid_to"))
            if end is not None and end <= parse_iso(reference_time):
                continue
        survivors.append(fact_id)
    return sorted(survivors)


def _assumptions_of(index: GraphIndex, decision_id: str) -> list[str]:
    """Assumptions a decision rests on (``Decision -ASSUMES-> Assumption``)."""
    return [
        target
        for target in index.targets(decision_id, ["ASSUMES"])
        if index.label(target) == "Assumption"
    ]


def _independent_support(
    index: GraphIndex,
    decision_id: str,
    *,
    changed_fact_ids: Iterable[str],
    reference_time: Optional[str],
    limit: int = 10,
) -> list[AlternateEvidence]:
    """Independent support that keeps ``decision_id`` from being auto-staled."""
    evidence: list[AlternateEvidence] = []
    for assumption_id in _assumptions_of(index, decision_id):
        for fact_id in _surviving_facts(
            index,
            assumption_id,
            exclude_fact_ids=changed_fact_ids,
            reference_time=reference_time,
        ):
            node = index.node(fact_id)
            if node is None:
                continue
            evidence.append(
                AlternateEvidence(
                    assumption_id=assumption_id,
                    assumption_name=index.name(assumption_id),
                    fact_id=fact_id,
                    fact_value=node.props.get("value"),
                    fact_status=str(node.props.get("status") or "ACTIVE"),
                    fact_confidence=float(node.props.get("confidence") or 0.0),
                    source_id=node.props.get("source_id"),
                    why_survives=(
                        f"'{index.name(assumption_id)}' is still supported by "
                        f"'{node.name}' (status {node.props.get('status') or 'ACTIVE'}), "
                        "so the decision does not rest on the changed fact alone."
                    ),
                )
            )
            if len(evidence) >= limit:
                return evidence
    return evidence


def entity_certainty(
    index: GraphIndex,
    *,
    seed_decision_id: str,
    changed_fact_ids: Iterable[str],
    reference_time: Optional[str],
    affected_assumptions: Sequence[str] = (),
    path_node_ids: Sequence[str] = (),
) -> tuple[str, list[AlternateEvidence]]:
    """Decide between ``confirmed`` and ``potential`` for an affected entity.

    The verdict is driven by the assumptions that actually connect the entity to
    the changed fact (``affected_assumptions``).  If **any** of those assumptions
    still has surviving independent support, the entity is only ``potential`` - the
    conservative direction, because declaring a decision stale while contrary
    evidence exists is the failure mode that destroys trust in the alert
    (spec S7/S11).

    ``confirmed`` is not a verdict of invalidity: it means "the recorded rationale
    for this entity is no longer supported anywhere, so a human should look".  The
    entity is still never auto-invalidated; only an explicit review writes
    ``STALE``.

    ``path_node_ids`` is accepted so callers can pass the evidence path for
    traceability; it does not widen the verdict.
    """
    assumptions = list(affected_assumptions) or _assumptions_of(index, seed_decision_id)
    evidence: list[AlternateEvidence] = []
    for assumption_id in assumptions:
        for fact_id in _surviving_facts(
            index,
            assumption_id,
            exclude_fact_ids=changed_fact_ids,
            reference_time=reference_time,
        ):
            node = index.node(fact_id)
            if node is None:
                continue
            evidence.append(
                AlternateEvidence(
                    assumption_id=assumption_id,
                    assumption_name=index.name(assumption_id),
                    fact_id=fact_id,
                    fact_value=node.props.get("value"),
                    fact_status=str(node.props.get("status") or "ACTIVE"),
                    fact_confidence=float(node.props.get("confidence") or 0.0),
                    source_id=node.props.get("source_id"),
                    why_survives=(
                        f"'{index.name(assumption_id)}' is still supported by "
                        f"'{node.name}' (status {node.props.get('status') or 'ACTIVE'}), "
                        "so the decision does not rest on the changed fact alone."
                    ),
                )
            )
    return ("potential" if evidence else "confirmed"), evidence


# --------------------------------------------------------------------------- #
# Propagation
# --------------------------------------------------------------------------- #
def plan_propagation(
    index: GraphIndex,
    fact_id: str,
    *,
    max_depth: int = 3,
    reference_time: Optional[str] = None,
    changed_fact_ids: Optional[Iterable[str]] = None,
    max_paths_per_entity: int = 3,
) -> PropagationPlan:
    """Plan the propagation of a changed fact through the graph.

    Parameters
    ----------
    index:
        Graph snapshot.
    fact_id:
        The changed/contradicted fact (usually the *old* fact that no longer
        holds).  Propagation starts here, per spec S7.
    max_depth:
        Hop budget for the dependent-decision walk.  Bounded by design so cycles
        terminate.
    reference_time:
        Real-world instant used when judging whether alternate evidence still
        applies.  Defaults to now.
    changed_fact_ids:
        Every fact being replaced/contradicted.  These are excluded when looking
        for surviving support, so a run driven by a pair of facts does not count
        the pair as its own evidence.

    Returns
    -------
    PropagationPlan
        Affected decisions and projects with certainty, evidence paths, alternate
        evidence and human-readable reasons.  Nothing is written.
    """
    now = reference_time or _now_iso()
    plan = PropagationPlan(
        source_fact_id=fact_id,
        max_depth=max_depth,
        evaluated_at=now,
    )
    fact_node = index.node(fact_id)
    if fact_node is None:
        plan.notes.append(
            f"Fact {fact_id!r} is not present in the graph; nothing to propagate. "
            "Propagation never invents a dependency chain."
        )
        return plan
    plan.source_fact_name = fact_node.name
    plan.source_fact_status = str(fact_node.props.get("status") or "ACTIVE")
    plan.source_fact_verified = bool(fact_node.props.get("verified", True))

    excluded = set(changed_fact_ids or ()) | {fact_id}

    # ---- hop 1: assumptions that rest on the changed fact -------------------
    assumptions = [
        assumption_id
        for assumption_id in index.sources(fact_id, ["SUPPORTED_BY"])
        if index.label(assumption_id) == "Assumption"
    ]
    plan.assumptions = assumptions
    if not assumptions:
        plan.notes.append(
            "No assumption is supported by this fact, so no decision depends on it. "
            "The engine reports no affected entities rather than forcing a chain."
        )
        return plan

    # ---- hops 2 and 3: decisions that assume them, then their dependents ----
    # Expansion is done per (assumption, seed decision) pair so that each affected
    # entity carries one complete, explainable chain back to the changed fact -
    # the multi-assumption cartesian product the original Cypher produced.
    affected: dict[str, AffectedEntity] = {}
    seed_decisions: list[str] = []
    for assumption_id in assumptions:
        for seed in index.sources(assumption_id, ["ASSUMES"]):
            if index.label(seed) != "Decision":
                continue
            if seed not in seed_decisions:
                seed_decisions.append(seed)
            head = [
                Edge(src=assumption_id, rel="SUPPORTED_BY", dst=fact_id),
                Edge(src=seed, rel="ASSUMES", dst=assumption_id),
            ]
            # Direction is BOTH because the two dependency relationships run in
            # opposite directions: a dependent decision points *at* the decision it
            # depends on (``dependent -DEPENDS_ON-> seed``, so walked inward), while
            # a decision points *at* the project it affects
            # (``seed -IMPACTS-> project``, so walked outward).  A one-directional
            # walk silently drops either the dependent decisions or the projects.
            reach = index.traverse(
                [seed],
                rels=DEPENDENCY_RELATIONSHIPS,
                direction=DIRECTION_BOTH,
                max_depth=max_depth,
                allow_labels=AFFECTED_LABELS,
            )
            for entity_id in reach.order:
                entity = index.node(entity_id)
                if entity is None:
                    continue
                dependent_chain = _chain_for(index, reach, entity_id)
                full_path = index.walk_path(fact_id, head + dependent_chain)
                if not full_path.steps:
                    continue
                record = affected.get(entity_id)
                if record is None:
                    record = AffectedEntity(
                        entity_id=entity_id,
                        entity_name=entity.name,
                        entity_label=entity.label,
                        seed_decision_id=seed,
                        depth=reach.depth.get(entity_id, 0),
                        status_before=entity.props.get("status"),
                        hops=reach.depth.get(entity_id, 0),
                    )
                    affected[entity_id] = record
                elif reach.depth.get(entity_id, 0) < record.depth:
                    record.depth = reach.depth.get(entity_id, 0)
                    record.seed_decision_id = seed
                    record.hops = record.depth
                if assumption_id not in record.contributing_assumptions:
                    record.contributing_assumptions.append(assumption_id)
                if seed not in record.contributing_facts:
                    record.contributing_facts.append(seed)
                if len(record.paths) < max_paths_per_entity:
                    if full_path.key not in {p.key for p in record.paths}:
                        record.paths.append(full_path)

    plan.seed_decisions = seed_decisions
    if not seed_decisions:
        plan.notes.append(
            "Assumptions depend on the changed fact, but no decision assumes them, so "
            "nothing downstream is affected."
        )
        return plan

    # ---- certainty, alternate evidence and reasons -------------------------
    for record in affected.values():
        record.contributing_assumptions.sort()
        record.contributing_facts = sorted(
            {
                fact_id,
                *(
                    supporting
                    for assumption_id in record.contributing_assumptions
                    for supporting in index.targets(assumption_id, ["SUPPORTED_BY"])
                ),
            }
        )
        certainty, evidence = entity_certainty(
            index,
            seed_decision_id=record.seed_decision_id or "",
            changed_fact_ids=excluded,
            reference_time=reference_time,
            affected_assumptions=record.contributing_assumptions,
            path_node_ids=[
                node_id
                for path in record.paths
                for node_id in path.node_ids
            ],
        )
        record.alternate_evidence = evidence
        # An unverified or merely contested source can never yield a confirmed
        # verdict on its own: restraint applies regardless of graph shape.
        if not plan.source_fact_verified or plan.source_fact_status == "CONTESTED":
            certainty = "potential"
            if not any("unverified" in note for note in plan.notes):
                plan.notes.append(
                    "The changed fact is unverified or merely contested, so all impacts "
                    "are reported as potential rather than confirmed."
                )
        record.certainty = certainty
        record.reason = _reason(index, record, plan)

    plan.affected = sorted(
        affected.values(),
        key=lambda a: (a.entity_label, a.depth, a.entity_id),
    )

    if any(a.has_alternate_evidence for a in plan.affected):
        plan.notes.append(
            "At least one affected decision retains independent supporting evidence; "
            "it is reported as potentially affected and is not marked stale."
        )
    if len(plan.affected) != len(affected):
        plan.notes.append("Duplicate dependency paths were collapsed to one entry per entity.")
    return plan


def _chain_for(index: GraphIndex, reach: Any, entity_id: str) -> list[Edge]:
    """Shortest-path edge chain from the traversal roots to ``entity_id``."""
    if entity_id in reach.roots:
        return []
    chain: list[Edge] = []
    cursor = entity_id
    while cursor in reach.parent:
        previous, edge = reach.parent[cursor]
        chain.append(edge)
        cursor = previous
    chain.reverse()
    return chain


def _reason(index: GraphIndex, record: AffectedEntity, plan: PropagationPlan) -> str:
    """Human-readable explanation of *why* an entity was flagged."""
    assumption_text = ", ".join(
        f"'{index.name(a)}'" for a in record.contributing_assumptions
    ) or f"the assumption chain from '{plan.source_fact_name}'"
    if record.entity_id == record.seed_decision_id:
        base = (
            f"'{record.entity_name}' assumes {assumption_text}, which is supported by "
            f"'{plan.source_fact_name}' (changed). Review the decision's continued validity."
        )
    else:
        base = (
            f"'{record.entity_name}' depends on '{index.name(record.seed_decision_id)}', "
            f"which assumes {assumption_text} supported by '{plan.source_fact_name}' "
            f"({record.hops} hop(s) away)."
        )
    if record.has_alternate_evidence:
        names = ", ".join(f"'{e.fact_id}'" for e in record.alternate_evidence[:3])
        return (
            f"{base} Independent evidence still supports the assumption ({names}), so "
            "this is flagged as potentially affected and requires human review before "
            "any status change."
        )
    if record.certainty == "confirmed":
        return (
            f"{base} No surviving independent support was found for the assumption, so "
            "the impact is reported as confirmed *for review* - the decision is not "
            "automatically invalidated."
        )
    return base


def _now_iso() -> str:
    """Current UTC timestamp in canonical Tripwire form."""
    return now_iso()
