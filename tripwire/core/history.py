"""Bi-temporal history: reconstructing what Tripwire believed, and when.

Two independent clocks are tracked on every ``Fact`` (spec S8):

=============  ================================  ==============================
field          meaning                           answers
=============  ================================  ==============================
``valid_from`` / ``valid_to``   real-world validity of the claim  "was this true in March?"
``recorded_at`` / ``recorded_to``  transaction time: when Tripwire **believed** it  "what did we know on the 4th?"
=============  ================================  ==============================

Conflating the two is the classic bitemporal bug: a claim can become true long
before Tripwire hears about it (late-arriving information), and Tripwire can
learn a *backdated* correction that changes the real-world interval without
changing when the knowledge arrived.

Belief is modelled as a half-open interval ``[recorded_at, recorded_to)``.
``recorded_to`` is only closed when the system genuinely stops treating a record
as current - i.e. when a correction is itself verified.  An *unverified*
contradiction leaves ``recorded_to`` open and only sets ``status = CONTESTED``,
because Tripwire still provisionally believes the original claim.

Everything here is read-only and pure over a :class:`GraphIndex`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Optional, Sequence

from .index import GraphIndex
from .models import Node
from .timeutil import parse_iso

__all__ = [
    "belief_at",
    "valid_at",
    "fact_timeline",
    "dependencies_at",
    "changes_since",
    "source_of_change",
    "history_report",
    "TimelineEntry",
]


def _recorded(node: Node) -> tuple[Optional[str], Optional[str]]:
    """``(recorded_at, recorded_to)`` for a node."""
    return node.props.get("recorded_at"), node.props.get("recorded_to")


def _believed_at(node: Node, instant: str) -> bool:
    """True when the node's transaction interval contains ``instant``."""
    start, end = _recorded(node)
    moment = parse_iso(instant)
    if moment is None:
        return False
    begin = parse_iso(start)
    if begin is not None and begin > moment:
        return False
    finish = parse_iso(end)
    if finish is not None and finish <= moment:
        return False
    return True


def _valid_at(node: Node, instant: str) -> bool:
    """True when the node's real-world interval contains ``instant``."""
    moment = parse_iso(instant)
    if moment is None:
        return False
    begin = parse_iso(node.props.get("valid_from"))
    if begin is not None and begin > moment:
        return False
    end = parse_iso(node.props.get("valid_to"))
    if end is not None and end <= moment:
        return False
    return True


def belief_at(
    index: GraphIndex,
    recorded_at: str,
    *,
    label: str | Sequence[str] = "Fact",
    where: dict[str, Any] | None = None,
    include_invalidated: bool = True,
) -> list[Node]:
    """What Tripwire believed at a given *transaction* time.

    ``GET /api/history/belief?at=...`` answers "what did we know on that date?"
    without being confused by facts whose real-world validity started earlier.
    """
    labels = {label} if isinstance(label, str) else set(label)
    result: list[Node] = []
    for node in index.nodes.values():
        if node.label not in labels:
            continue
        if not _believed_at(node, recorded_at):
            continue
        if not include_invalidated and str(node.props.get("status")) in ("INVALIDATED",):
            continue
        if where and any(node.props.get(key) != value for key, value in where.items()):
            continue
        result.append(node)
    result.sort(key=lambda node: (node.label, node.id))
    return result


def valid_at(
    index: GraphIndex,
    real_time: str,
    *,
    subject_id: Optional[str] = None,
    attribute: Optional[str] = None,
    label: str = "Fact",
) -> list[Node]:
    """Which facts were true in the real world at ``real_time``.

    Independent of when Tripwire learned them, so a late-arriving or backdated
    record is evaluated on its own merits.
    """
    result: list[Node] = []
    for node in index.of_label(label):
        if subject_id and node.props.get("subject_id") != subject_id:
            continue
        if attribute and str(node.props.get("attribute")) != attribute:
            continue
        if _valid_at(node, real_time):
            result.append(node)
    result.sort(key=lambda node: (node.props.get("subject_id") or "", node.id))
    return result


@dataclass
class TimelineEntry:
    """One entry in a fact's history."""

    at: Optional[str]
    kind: str
    description: str
    fact_id: Optional[str] = None
    event_id: Optional[str] = None
    actor_id: Optional[str] = None
    source_id: Optional[str] = None

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form."""
        return {
            "at": self.at,
            "kind": self.kind,
            "description": self.description,
            "fact_id": self.fact_id,
            "event_id": self.event_id,
            "actor_id": self.actor_id,
            "source_id": self.source_id,
        }


def fact_timeline(index: GraphIndex, fact_id: str) -> dict[str, Any]:
    """Full history of a claim: intervals, contradictions, sources and events."""
    node = index.node(fact_id)
    if node is None:
        return {"fact_id": fact_id, "found": False, "entries": []}

    entries: list[TimelineEntry] = [
        TimelineEntry(
            at=node.props.get("recorded_at"),
            kind="RECORDED",
            description=(
                f"Tripwire first recorded '{node.name}' from source "
                f"{node.props.get('source_ref') or node.props.get('source_id') or 'unknown'}."
            ),
            fact_id=fact_id,
            source_id=node.props.get("source_id"),
        )
    ]
    if node.props.get("valid_from"):
        entries.append(
            TimelineEntry(
                at=node.props.get("valid_from"),
                kind="VALID_FROM",
                description="Claim became true in the real world.",
                fact_id=fact_id,
            )
        )

    for edge in index.incoming(fact_id, ["CONTRADICTS"]) + index.out(fact_id, ["CONTRADICTS"]):
        other = edge.dst if edge.src == fact_id else edge.src
        entries.append(
            TimelineEntry(
                at=edge.props.get("at") or index.prop(other, "recorded_at"),
                kind="CONTRADICTS",
                description=(
                    f"{'Outgoing' if edge.src == fact_id else 'Incoming'} CONTRADICTS edge with "
                    f"'{index.name(other)}' (status {edge.props.get('status', 'n/a')})."
                ),
                fact_id=other,
            )
        )

    for event in index.nodes.values():
        if event.label != "Event":
            continue
        props = event.props
        related = {
            props.get("fact_id"),
            props.get("old_fact_id"),
            props.get("new_fact_id"),
            props.get("subject_id"),
        }
        if fact_id in related or index.targets(event.id, ["ABOUT"]) and fact_id in index.targets(
            event.id, ["ABOUT"]
        ):
            entries.append(
                TimelineEntry(
                    at=props.get("recorded_at") or props.get("at"),
                    kind=str(props.get("event_type") or "EVENT"),
                    description=str(props.get("summary") or event.name),
                    event_id=event.id,
                    actor_id=props.get("actor_id"),
                    source_id=props.get("source_id"),
                )
            )

    def sort_key(entry: TimelineEntry) -> tuple[str, str]:
        return (entry.at or "", entry.kind)

    entries.sort(key=sort_key)
    return {
        "fact_id": fact_id,
        "found": True,
        "name": node.name,
        "statement": node.props.get("statement"),
        "status": node.props.get("status"),
        "valid_from": node.props.get("valid_from"),
        "valid_to": node.props.get("valid_to"),
        "recorded_at": node.props.get("recorded_at"),
        "recorded_to": node.props.get("recorded_to"),
        "still_believed": node.props.get("recorded_to") is None,
        "entries": [entry.as_dict() for entry in entries],
    }


def dependencies_at(index: GraphIndex, decision_id: str, recorded_at: str) -> dict[str, Any]:
    """What a decision depended on *at a given transaction time*.

    Answers "what did this decision rest on when it was made / at that point?".
    Dependency edges carry their own ``recorded_at``, so a link added later does
    not retroactively appear in an earlier snapshot.
    """
    decision = index.node(decision_id)
    if decision is None:
        return {"decision_id": decision_id, "found": False, "assumptions": []}

    assumptions: list[dict[str, Any]] = []
    for edge in index.out(decision_id, ["ASSUMES"]):
        edge_recorded = edge.props.get("recorded_at")
        if edge_recorded and parse_iso(edge_recorded) and parse_iso(edge_recorded) > parse_iso(recorded_at):
            continue
        assumption = index.node(edge.dst)
        if assumption is None:
            continue
        facts = []
        for support in index.out(assumption.id, ["SUPPORTED_BY"]):
            support_recorded = support.props.get("recorded_at")
            if (
                support_recorded
                and parse_iso(support_recorded)
                and parse_iso(support_recorded) > parse_iso(recorded_at)
            ):
                continue
            fact = index.node(support.dst)
            if fact is None:
                continue
            if not _believed_at(fact, recorded_at):
                continue
            facts.append(
                {
                    "fact_id": fact.id,
                    "name": fact.name,
                    "value": fact.props.get("value"),
                    "status": fact.props.get("status"),
                    "recorded_at": fact.props.get("recorded_at"),
                    "valid_from": fact.props.get("valid_from"),
                    "valid_to": fact.props.get("valid_to"),
                }
            )
        assumptions.append(
            {
                "assumption_id": assumption.id,
                "name": assumption.name,
                "recorded_at": edge_recorded,
                "statement": assumption.props.get("statement"),
                "supporting_facts": facts,
            }
        )

    return {
        "decision_id": decision_id,
        "found": True,
        "name": decision.name,
        "status_at_query": _status_at(index, decision, recorded_at),
        "recorded_at_query": recorded_at,
        "assumptions": assumptions,
        "assumption_count": len(assumptions),
        "fact_count": sum(len(a["supporting_facts"]) for a in assumptions),
    }


def _status_at(index: GraphIndex, node: Node, recorded_at: str) -> Optional[str]:
    """Best-effort status of a node at a transaction instant.

    Reads the append-only ``STATUS_CHANGE`` events attached to the node; if the
    node was never believed at that instant the status is ``None``.
    """
    if not _believed_at(node, recorded_at):
        return None
    history = [
        event
        for event in index.nodes.values()
        if event.label == "Event"
        and event.props.get("event_type") == "STATUS_CHANGE"
        and event.props.get("entity_id") == node.id
    ]
    applicable = [
        event
        for event in history
        if event.props.get("recorded_at")
        and parse_iso(event.props["recorded_at"]) <= parse_iso(recorded_at)
    ]
    if not applicable:
        return str(node.props.get("status") or "ACTIVE")
    latest = max(applicable, key=lambda e: e.props.get("recorded_at") or "")
    return str(latest.props.get("to_status") or node.props.get("status") or "ACTIVE")


def changes_since(
    index: GraphIndex,
    recorded_since: str,
    *,
    events_only: bool = False,
) -> dict[str, Any]:
    """Everything Tripwire learned after a point in time.

    ``GET /api/history/changes?since=...`` powers "what changed since Tuesday?".
    """
    facts = [
        node
        for node in index.of_label("Fact")
        if node.props.get("recorded_at")
        and parse_iso(node.props["recorded_at"]) > parse_iso(recorded_since)
        and str(node.props.get("status")) != "INVALIDATED"
    ]
    events = [
        node
        for node in index.of_label("Event")
        if node.props.get("recorded_at")
        and parse_iso(node.props["recorded_at"]) > parse_iso(recorded_since)
    ]
    facts.sort(key=lambda n: n.props.get("recorded_at") or "")
    events.sort(key=lambda n: n.props.get("recorded_at") or "")
    payload: dict[str, Any] = {
        "since": recorded_since,
        "facts": [
            {
                "fact_id": node.id,
                "name": node.name,
                "recorded_at": node.props.get("recorded_at"),
                "statement": node.props.get("statement"),
                "status": node.props.get("status"),
                "source_id": node.props.get("source_id"),
            }
            for node in facts
        ],
        "fact_count": len(facts),
    }
    if not events_only:
        payload["events"] = [
            {
                "event_id": node.id,
                "event_type": node.props.get("event_type"),
                "recorded_at": node.props.get("recorded_at"),
                "summary": node.props.get("summary"),
                "actor_id": node.props.get("actor_id"),
            }
            for node in events
        ]
        payload["event_count"] = len(events)
    return payload


def source_of_change(index: GraphIndex, fact_id: str) -> dict[str, Any]:
    """Which source caused Tripwire to change its understanding of a fact.

    Walks ``Message|Document -STATES-> Fact`` for the fact itself and for any
    fact it contradicts, then overlays the recording events, so an explanation can
    always name a real artifact rather than asserting that one exists.
    """
    node = index.node(fact_id)
    if node is None:
        return {"fact_id": fact_id, "found": False, "sources": []}

    related = {fact_id}
    for edge in index.incoming(fact_id, ["CONTRADICTS"]) + index.out(fact_id, ["CONTRADICTS"]):
        related.add(edge.dst if edge.src == fact_id else edge.src)

    sources: list[dict[str, Any]] = []
    for candidate in sorted(related):
        for source_id in index.sources(candidate, ["STATES"]):
            source = index.node(source_id)
            if source is None:
                continue
            sources.append(
                {
                    "source_id": source_id,
                    "label": source.label,
                    "name": source.name,
                    "doc_type": source.props.get("doc_type"),
                    "author_id": source.props.get("author_id"),
                    "timestamp": source.props.get("timestamp"),
                    "source_ref": source.props.get("source_ref"),
                    "states_fact_id": candidate,
                    "url": source.props.get("url"),
                }
            )
    sources.sort(key=lambda item: (item["timestamp"] or "", item["source_id"]))

    events = []
    for event in index.of_label("Event"):
        props = event.props
        if fact_id in {props.get("fact_id"), props.get("old_fact_id"), props.get("new_fact_id")}:
            events.append(
                {
                    "event_id": event.id,
                    "event_type": props.get("event_type"),
                    "recorded_at": props.get("recorded_at"),
                    "summary": props.get("summary"),
                    "actor_id": props.get("actor_id"),
                }
            )
    events.sort(key=lambda item: item["recorded_at"] or "")

    return {
        "fact_id": fact_id,
        "found": True,
        "name": node.name,
        "recorded_at": node.props.get("recorded_at"),
        "related_fact_ids": sorted(related),
        "sources": sources,
        "events": events,
    }


def history_report(index: GraphIndex) -> dict[str, Any]:
    """Summary of the bitemporal state, used by ``/api/demo/state``."""
    facts = index.of_label("Fact")
    open_ended = [f for f in facts if f.props.get("recorded_to") is None]
    closed = [f for f in facts if f.props.get("recorded_to") is not None]
    return {
        "facts_total": len(facts),
        "facts_open_belief": len(open_ended),
        "facts_closed_belief": len(closed),
        "facts_invalidated": len([f for f in facts if f.props.get("status") == "INVALIDATED"]),
        "facts_contested": len([f for f in facts if f.props.get("status") == "CONTESTED"]),
        "status_change_events": len(
            [
                e
                for e in index.of_label("Event")
                if e.props.get("event_type") == "STATUS_CHANGE"
            ]
        ),
    }
