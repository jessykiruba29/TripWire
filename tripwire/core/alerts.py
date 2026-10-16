"""Proactive alert engine: creation, de-duplication, review and history.

Alerts are first-class, persistent records (the documented ``Alert`` node type
addition) so that a warning is reviewable, auditable and revisitable rather than a
transient API response.

De-duplication
--------------
An alert's identity is derived from the *contradiction*, not from the request that
triggered it::

    dedupe_key = old_fact_id | new_fact_id | entity_id
    alert_id   = alert:<sha1(dedupe_key)[:12]>

Replaying the same event therefore resolves to the same alert id, so processing an
event twice cannot create a duplicate alert or a duplicate notification (spec S7).

Status model
------------
``NEW -> NEEDS_REVIEW -> CONFIRMED_STALE | DISMISSED -> RESOLVED`` with the exact
allowed transitions held in
:data:`tripwire.core.schema.ALERT_STATUS_TRANSITIONS`.  A same-status update is an
idempotent no-op, and an invalid transition raises
:class:`tripwire.core.errors.TransitionError` instead of silently corrupting state.

Only an *explicit* review produces ``CONFIRMED_STALE``; propagation never does.
Promotion also writes the ``Fact -STALED-> Decision`` edge and records a
``STATUS_CHANGE`` event, preserving both the prior status and the history.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Optional, Sequence

from .errors import NotFoundError, TransitionError, ValidationError
from .ids import alert_id as make_alert_id
from .ids import event_id as make_event_id
from .ids import short_hash
from .index import GraphIndex
from .models import Edge, Node
from .schema import ALERT_STATUS_TRANSITIONS, ALERT_STATUSES
from .store import GraphStore
from .timeutil import now_iso

__all__ = [
    "AlertDraft",
    "dedupe_key",
    "create_alert",
    "transition_alert",
    "assign_reviewers",
    "list_alerts",
    "alert_history",
    "get_alert",
    "affected_entities",
    "can_transition",
    "promote_decision",
]


def dedupe_key(old_fact_id: Optional[str], new_fact_id: Optional[str], entity_id: Optional[str]) -> str:
    """Stable identity for an alert so replays cannot duplicate it."""
    return "|".join(str(part or "-") for part in (old_fact_id, new_fact_id, entity_id))


def can_transition(current: str, target: str) -> bool:
    """True when ``current -> target`` is a documented, allowed transition."""
    if current not in ALERT_STATUSES or target not in ALERT_STATUSES:
        return False
    if current == target:
        return True  # idempotent no-op
    return target in ALERT_STATUS_TRANSITIONS.get(current, ())


@dataclass
class AlertDraft:
    """Everything needed to create an alert."""

    old_fact_id: Optional[str]
    new_fact_id: Optional[str]
    entity_id: Optional[str]
    entity_label: Optional[str] = None
    entity_name: Optional[str] = None
    attribute: Optional[str] = None
    severity: str = "medium"
    certainty: str = "potential"
    confidence: float = 0.0
    title: str = ""
    summary: str = ""
    reason: str = ""
    trigger_assumption_id: Optional[str] = None
    path_nodes: list[str] = field(default_factory=list)
    path_rels: list[str] = field(default_factory=list)
    source_refs: list[str] = field(default_factory=list)
    evidence_fact_ids: list[str] = field(default_factory=list)
    certainty_sources: list[str] = field(default_factory=list)
    actor_id: Optional[str] = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> str:
        """De-duplication key for this alert."""
        return dedupe_key(self.old_fact_id, self.new_fact_id, self.entity_id)

    @property
    def id(self) -> str:
        """Deterministic alert id."""
        return make_alert_id(self.key)


def get_alert(store: GraphStore, alert_id: str) -> Optional[Node]:
    """Fetch an alert node, or ``None``."""
    node = store.get_node(alert_id)
    return node if node is not None and node.label == "Alert" else None


def _find_existing(store: GraphStore, key: str) -> Optional[Node]:
    """Locate an existing alert by de-duplication key."""
    matches = store.get_nodes(label="Alert", where={"dedupe_key": key})
    return matches[0] if matches else None


def create_alert(store: GraphStore, draft: AlertDraft, *, now: Optional[str] = None) -> tuple[Node, bool]:
    """Create an alert, or return the existing one for the same contradiction.

    Returns
    -------
    tuple[Node, bool]
        The alert node and whether it was newly created.
    """
    moment = now or now_iso()
    key = draft.key
    existing = _find_existing(store, key)
    if existing is not None:
        # Replay of the same event: no duplicate alert, no duplicate notification.
        merged = store.upsert_node(
            Node(
                id=existing.id,
                label="Alert",
                name=existing.name,
                props={"last_seen_at": moment, "occurrences": int(existing.props.get("occurrences") or 1) + 1},
            )
        )
        return merged, False

    alert = Node(
        id=draft.id,
        label="Alert",
        name=draft.title or f"Contradiction affecting {draft.entity_name or draft.entity_id}",
        props={
            "status": "NEW",
            "severity": draft.severity,
            "certainty": draft.certainty,
            "confidence": round(float(draft.confidence), 3),
            "title": draft.title,
            "summary": draft.summary,
            "reason": draft.reason,
            "dedupe_key": key,
            "old_fact_id": draft.old_fact_id,
            "new_fact_id": draft.new_fact_id,
            "entity_id": draft.entity_id,
            "entity_label": draft.entity_label,
            "entity_name": draft.entity_name,
            "attribute": draft.attribute,
            "trigger_assumption_id": draft.trigger_assumption_id,
            "path_nodes": list(draft.path_nodes),
            "path_rels": list(draft.path_rels),
            "source_refs": list(draft.source_refs),
            "evidence_fact_ids": list(draft.evidence_fact_ids),
            "certainty_sources": list(draft.certainty_sources),
            "created_at": moment,
            "recorded_at": moment,
            "updated_at": moment,
            "occurrences": 1,
            "review_status": "NEEDS_REVIEW",
            "notified_externally": False,
            **draft.extra,
        },
    )
    stored = store.upsert_node(alert)

    for fact_id in {draft.new_fact_id, draft.old_fact_id}:
        if fact_id and store.get_node(fact_id) is not None:
            store.upsert_edge(Edge(src=stored.id, rel="EVIDENCE_FOR", dst=fact_id, props={"at": moment}))
    if draft.new_fact_id and store.get_node(draft.new_fact_id) is not None:
        store.upsert_edge(
            Edge(src=stored.id, rel="TRIGGERED_BY", dst=draft.new_fact_id, props={"at": moment})
        )
    if draft.entity_id and store.get_node(draft.entity_id) is not None:
        store.upsert_edge(
            Edge(
                src=stored.id,
                rel="AFFECTS",
                dst=draft.entity_id,
                props={
                    "at": moment,
                    "certainty": draft.certainty,
                    "confidence": round(float(draft.confidence), 3),
                    "reason": draft.reason,
                },
            )
        )

    _record_event(
        store,
        kind="CONTRADICTION_DETECTED",
        summary=draft.summary or alert.name,
        moment=moment,
        actor_id=draft.actor_id,
        subject_id=stored.id,
        extra={
            "alert_id": stored.id,
            "old_fact_id": draft.old_fact_id,
            "new_fact_id": draft.new_fact_id,
            "entity_id": draft.entity_id,
            "certainty": draft.certainty,
            "severity": draft.severity,
        },
    )
    return stored, True


def transition_alert(
    store: GraphStore,
    alert_id: str,
    status: str,
    *,
    actor_id: Optional[str] = None,
    note: str = "",
    now: Optional[str] = None,
) -> Node:
    """Move an alert to ``status``, recording history and cascading to decisions."""
    moment = now or now_iso()
    alert = get_alert(store, alert_id)
    if alert is None:
        raise NotFoundError(f"alert {alert_id!r} does not exist")
    current = str(alert.props.get("status") or "NEW")
    target = str(status).upper()
    if target not in ALERT_STATUSES:
        raise ValidationError(f"unknown alert status {status!r}; expected one of {ALERT_STATUSES}")
    if not can_transition(current, target):
        raise TransitionError(
            f"cannot move alert {alert_id} from {current} to {target}",
            details={"from": current, "to": target,
                     "allowed": list(ALERT_STATUS_TRANSITIONS.get(current, ()))},
        )
    if current == target:
        # Idempotent no-op: never append a duplicate status-change entry.  But a
        # reviewer who typed a note must not have it silently discarded, so the note
        # is recorded on the alert and in history while the status stays put.
        if not note:
            return alert
        updated = store.upsert_node(
            Node(
                id=alert.id,
                label="Alert",
                name=alert.name,
                props={
                    "updated_at": moment,
                    "review_note": note,
                    "last_review_note": note,
                    "last_reviewed_by": actor_id,
                },
            )
        )
        _record_event(
            store,
            kind="ALERT_REVIEW_NOTE",
            summary=f"Note recorded on alert {alert.id} while it remained {current}: {note}",
            moment=moment,
            actor_id=actor_id,
            subject_id=updated.id,
            extra={
                "entity_id": updated.id,
                "from_status": current,
                "to_status": target,
                "alert_id": updated.id,
                "note": note,
                "status_unchanged": True,
            },
        )
        return updated

    updated = store.upsert_node(
        Node(
            id=alert.id,
            label="Alert",
            name=alert.name,
            props={
                "status": target,
                "previous_status": current,
                "updated_at": moment,
                "review_status": "REVIEWED_ACCEPTED" if target in ("CONFIRMED_STALE", "RESOLVED")
                else "REVIEWED_REJECTED" if target == "DISMISSED"
                else "NEEDS_REVIEW",
                "reviewed_by": actor_id,
                "review_note": note,
            },
        )
    )

    if target == "CONFIRMED_STALE" and alert.props.get("entity_id"):
        promote_decision(
            store, str(alert.props["entity_id"]), alert_id=alert.id, at=moment, actor_id=actor_id
        )
    elif target == "DISMISSED" and alert.props.get("entity_id"):
        _revert_decision(store, str(alert.props["entity_id"]), alert_id=alert.id, at=moment,
                         actor_id=actor_id, note=note)

    _record_event(
        store,
        kind="ALERT_STATUS_CHANGE",
        summary=f"Alert {alert.id} moved from {current} to {target}"
        + (f": {note}" if note else ""),
        moment=moment,
        actor_id=actor_id,
        subject_id=updated.id,
        extra={
            "entity_id": updated.id,
            "from_status": current,
            "to_status": target,
            "alert_id": updated.id,
            "note": note,
        },
    )
    return updated


def promote_decision(
    store: GraphStore,
    decision_id: str,
    *,
    alert_id: Optional[str] = None,
    at: Optional[str] = None,
    actor_id: Optional[str] = None,
    reason: Optional[str] = None,
) -> Optional[Node]:
    """Mark a decision ``STALE`` after an explicit, human-issued confirmation.

    This is the *only* code path that writes ``STALE``.  It also writes the
    ``STALED`` edge the specification calls for, so the reason and instant are
    recoverable from the graph rather than living only in an API response.
    """
    moment = at or now_iso()
    decision = store.get_node(decision_id)
    if decision is None or decision.label != "Decision":
        return None
    previous = str(decision.props.get("status") or "ACTIVE")
    stale_reason = reason or f"Confirmed stale by review of alert {alert_id or 'unknown'}"
    updated = store.upsert_node(
        Node(
            id=decision.id,
            label="Decision",
            name=decision.name,
            props={
                "status": "STALE",
                "previous_status": previous,
                "stale_reason": stale_reason,
                "stale_since": moment,
                "review_status": "REVIEWED_ACCEPTED",
                "reviewed_by": actor_id,
                "final_status_at": moment,
            },
        )
    )
    cause_ids = [i for i in (alert_id, decision.props.get("stale_cause_fact_id")) if i]
    for cause_id in cause_ids:
        if store.get_node(cause_id) is not None:
            store.upsert_edge(
                Edge(
                    src=cause_id,
                    rel="STALED",
                    dst=decision.id,
                    props={"at": moment, "reason": stale_reason, "alert_id": alert_id},
                )
            )
    _record_event(
        store,
        kind="STATUS_CHANGE",
        summary=f"Decision '{decision.name}' marked STALE (was {previous}). {stale_reason}",
        moment=moment,
        actor_id=actor_id,
        subject_id=decision.id,
        extra={
            "entity_id": decision.id,
            "from_status": previous,
            "to_status": "STALE",
            "alert_id": alert_id,
            "reason": stale_reason,
        },
    )
    return updated


def _revert_decision(
    store: GraphStore,
    decision_id: str,
    *,
    alert_id: Optional[str],
    at: str,
    actor_id: Optional[str],
    note: str,
) -> Optional[Node]:
    """Return a flagged decision to ``ACTIVE`` when an alert is dismissed."""
    decision = store.get_node(decision_id)
    if decision is None or decision.label != "Decision":
        return None
    previous = str(decision.props.get("status") or "ACTIVE")
    if previous not in ("POTENTIALLY_STALE", "STALE"):
        return decision
    updated = store.upsert_node(
        Node(
            id=decision.id,
            label="Decision",
            name=decision.name,
            props={
                "status": "ACTIVE",
                "previous_status": previous,
                "review_status": "REVIEWED_REJECTED",
                "reviewed_by": actor_id,
                "review_note": note or f"Dismissed alert {alert_id}",
                "reviewed_at": at,
            },
        )
    )
    _record_event(
        store,
        kind="STATUS_CHANGE",
        summary=f"Decision '{decision.name}' returned to ACTIVE (was {previous}); alert dismissed.",
        moment=at,
        actor_id=actor_id,
        subject_id=decision.id,
        extra={
            "entity_id": decision.id,
            "from_status": previous,
            "to_status": "ACTIVE",
            "alert_id": alert_id,
        },
    )
    return updated


def assign_reviewers(store: GraphStore, alert_id: str, reviewers: Sequence[dict[str, Any]]) -> Node:
    """Attach ranked reviewers (usually from :mod:`tripwire.core.experts`)."""
    alert = get_alert(store, alert_id)
    if alert is None:
        raise NotFoundError(f"alert {alert_id!r} does not exist")
    moment = now_iso()
    assigned: list[str] = []
    for reviewer in reviewers:
        person_id = reviewer.get("person_id")
        if not person_id or store.get_node(person_id) is None:
            continue
        store.upsert_edge(
            Edge(
                src=str(person_id),
                rel="REVIEWS",
                dst=alert.id,
                props={
                    "at": moment,
                    "rank": int(reviewer.get("rank") or 0),
                    "reason": str(reviewer.get("reason") or "")[:500],
                    "score": float(reviewer.get("normalized_score") or 0.0),
                },
            )
        )
        assigned.append(str(person_id))
    if assigned:
        alert = store.upsert_node(
            Node(
                id=alert.id,
                label="Alert",
                name=alert.name,
                props={"reviewers": sorted(assigned), "reviewers_assigned_at": moment},
            )
        )
    return alert


def affected_entities(store: GraphStore, alert_id: str) -> list[dict[str, Any]]:
    """Entities an alert may affect, with the edge's certainty annotation."""
    out = []
    for edge in store.get_edges(src=alert_id, rel="AFFECTS"):
        node = store.get_node(edge.dst)
        out.append(
            {
                "entity_id": edge.dst,
                "entity_label": node.label if node else None,
                "entity_name": node.name if node else edge.dst,
                "certainty": edge.props.get("certainty"),
                "confidence": edge.props.get("confidence"),
                "reason": edge.props.get("reason"),
                "status": node.props.get("status") if node else None,
            }
        )
    out.sort(key=lambda item: item["entity_id"])
    return out


def list_alerts(
    store: GraphStore,
    *,
    status: Optional[str | Sequence[str]] = None,
    entity_id: Optional[str] = None,
    severity: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """Paginated alert feed with a status histogram."""
    where: dict[str, Any] = {}
    if status:
        where["status"] = status
    if severity:
        where["severity"] = severity
    if entity_id:
        where["entity_id"] = entity_id
    matches = store.get_nodes(label="Alert", where=where or None)
    histogram: dict[str, int] = {}
    for alert in matches:
        key = str(alert.props.get("status") or "NEW")
        histogram[key] = histogram.get(key, 0) + 1
    window = matches[offset : offset + limit]
    return {
        "total": len(matches),
        "count": len(window),
        "limit": limit,
        "offset": offset,
        "status_counts": dict(sorted(histogram.items())),
        "alerts": [_alert_view(store, alert) for alert in window],
    }


def _alert_view(store: GraphStore, alert: Node) -> dict[str, Any]:
    """Alert payload enriched with its affected entities and legal next statuses.

    ``allowed_transitions`` comes straight from the documented status model in
    :mod:`tripwire.core.schema`, so a client can render exactly the status changes
    the engine will accept instead of re-deriving the model (and drifting from it).
    A same-status re-review is included, because that is how a reviewer adds a note.
    """
    view = alert.to_view()
    current = str(alert.props.get("status") or "NEW")
    view["allowed_transitions"] = [current, *ALERT_STATUS_TRANSITIONS.get(current, ())]
    view["affected"] = affected_entities(store, alert.id)
    view["reviewers"] = list(alert.props.get("reviewers") or [])
    return view


def alert_history(store: GraphStore, alert_id: str) -> dict[str, Any]:
    """Append-only history of an alert.

    Includes status changes, the contradiction that raised the alert, and
    ``ALERT_REVIEW_NOTE`` entries.  A note recorded during a same-status re-review is
    part of the alert's audit trail, so hiding it here would lose the reviewer's
    reasoning even though the alert kept it.  Each entry carries ``event_type`` so a
    client can still filter to status changes only.
    """
    alert = get_alert(store, alert_id)
    if alert is None:
        raise NotFoundError(f"alert {alert_id!r} does not exist")
    history_event_types = (
        "ALERT_STATUS_CHANGE",
        "ALERT_REVIEW_NOTE",
        "CONTRADICTION_DETECTED",
    )
    events = [
        event
        for event in store.get_nodes(label="Event", where={"entity_id": alert_id})
        if str(event.props.get("event_type")) in history_event_types
    ]
    if alert.props.get("alert_id"):
        events.extend(
            event
            for event in store.get_nodes(label="Event", where={"alert_id": alert_id})
            if event not in events
        )
    events.sort(key=lambda event: (str(event.props.get("recorded_at") or ""), event.id))
    return {
        "alert_id": alert_id,
        "status": alert.props.get("status"),
        "previous_status": alert.props.get("previous_status"),
        "created_at": alert.props.get("created_at"),
        "updated_at": alert.props.get("updated_at"),
        "occurrences": alert.props.get("occurrences"),
        "history": [
            {
                "event_id": event.id,
                "event_type": event.props.get("event_type"),
                "at": event.props.get("recorded_at"),
                "from_status": event.props.get("from_status"),
                "to_status": event.props.get("to_status"),
                "actor_id": event.props.get("actor_id"),
                "summary": event.props.get("summary"),
                "note": event.props.get("note"),
            }
            for event in events
        ],
    }


def _record_event(
    store: GraphStore,
    *,
    kind: str,
    summary: str,
    moment: str,
    subject_id: Optional[str] = None,
    actor_id: Optional[str] = None,
    extra: Optional[dict[str, Any]] = None,
) -> Node:
    """Persist an ``Event`` node and link it to its subject.

    The identifier deliberately excludes the wall-clock ``moment``: replaying the
    same logical event (the same status change, the same contradiction) must
    resolve to the same ``Event`` node instead of appending a duplicate history
    entry.  Distinct events differ in ``summary``/``subject_id``, so they still get
    distinct ids.
    """
    identifier = make_event_id(kind, subject_id, short_hash(summary))
    event = store.upsert_node(
        Node(
            id=identifier,
            label="Event",
            name=summary[:120],
            props={
                "event_type": kind,
                "summary": summary,
                "recorded_at": moment,
                "at": moment,
                "actor_id": actor_id,
                "subject_id": subject_id,
                **(extra or {}),
            },
        )
    )
    for target in (subject_id,):
        if target and store.get_node(target) is not None:
            store.upsert_edge(Edge(src=event.id, rel="ABOUT", dst=target, props={"at": moment}))
    return event
