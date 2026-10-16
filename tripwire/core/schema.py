"""Tripwire graph schema: node types, relationship types, property conventions.

This module is the **single source of truth** for the graph vocabulary.  The
store layer, ingestion pipeline, reasoning engine, HTTP API and MCP tools all
import their vocabulary from here so the schema cannot drift between layers.

Node types (spec S4)
--------------------
``Person, Team, System, Project, Decision, Assumption, Fact, Message, Document,
Event`` plus one documented addition:

``Alert``
    Alerts are first-class, persistent, reviewable records with their own status
    transitions and history (spec S11 requires deduplicated alerts, a review
    status, preserved alert history and API availability).  Modelling them as
    ``Event`` nodes would have conflated "something happened" with "someone must
    review this", so ``Alert`` is a distinct type linked back to its trigger.

Source artifacts
----------------
Tickets, PRDs and meeting notes are all ``Document`` nodes discriminated by
``doc_type`` (``ticket`` / ``prd`` / ``meeting_note``).  This keeps one ingestion
and provenance path for every document-shaped source while still letting the
frontend and API filter by source kind (spec S5).

Relationship types (spec S4)
----------------------------
``ON_TEAM, MADE, ASSUMES, SUPPORTED_BY, DEPENDS_ON, IMPACTS, USES, STATES,
CONTRADICTS, AUTHORED, ABOUT, TRIGGERED_BY, STALED`` plus documented additions
for provenance, review status and expertise - see :data:`ADDED_RELATIONSHIPS`.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Mapping

__all__ = [
    "NODE_TYPES",
    "REL_TYPES",
    "ADDED_RELATIONSHIPS",
    "ALERT_STATUSES",
    "ALERT_STATUS_TRANSITIONS",
    "FACT_STATUSES",
    "DECISION_STATUSES",
    "REVIEW_STATUSES",
    "DOC_TYPES",
    "EVENT_TYPES",
    "PROVENANCE_REL_TYPES",
    "SchemaError",
    "sanitize_props",
    "validate_node_payload",
    "validate_edge_payload",
]


# --------------------------------------------------------------------------- #
# Node types
# --------------------------------------------------------------------------- #
NODE_TYPES: tuple[str, ...] = (
    "Person",
    "Team",
    "System",
    "Project",
    "Decision",
    "Assumption",
    "Fact",
    "Message",
    "Document",
    "Event",
    "Alert",
)

DOC_TYPES: tuple[str, ...] = ("ticket", "prd", "meeting_note", "design_doc")
"""``Document.doc_type`` values.  Direct-provider integrations are absent, so
these are the documented adapter input shapes (spec S5)."""

EVENT_TYPES: tuple[str, ...] = (
    "SEED",
    "RESET",
    "INGESTION",
    "FACT_ASSERTED",
    "FACT_RESTATED",
    "FACT_CHANGE",
    "CONTRADICTION_DETECTED",
    "STALENESS_PROPAGATED",
    "STATUS_CHANGE",
    "ALERT_STATUS_CHANGE",
    "REVIEW_DECISION",
    "ERROR",
)


# --------------------------------------------------------------------------- #
# Relationship types
# --------------------------------------------------------------------------- #
_SPEC_REL_TYPES: tuple[str, ...] = (
    "ON_TEAM",
    "MADE",
    "ASSUMES",
    "SUPPORTED_BY",
    "DEPENDS_ON",
    "IMPACTS",
    "USES",
    "STATES",
    "CONTRADICTS",
    "AUTHORED",
    "ABOUT",
    "TRIGGERED_BY",
    "STALED",
)

ADDED_RELATIONSHIPS: Mapping[str, str] = {
    "MENTIONS": (
        "Message|Document -> any entity.  Provenance/first-class evidence that a "
        "source artifact discusses a person, system, project or decision. "
        "AUTHORED only records who wrote the artifact; MENTIONS records what it "
        "is evidence about, which the contribution-based expert finder needs."
    ),
    "RESOLVED": (
        "Person -> Document(ticket).  Records who actually fixed a ticket. "
        "Distinguishes hands-on troubleshooting from merely being copied in."
    ),
    "OWNS": (
        "Person -> System|Project.  The *official* ownership claim from the org "
        "records.  Kept deliberately separate from contribution evidence so the "
        "shadow organisational chart can show where official ownership and "
        "actual contribution diverge (spec S10)."
    ),
    "REVIEWS": (
        "Person -> Alert.  Assigned reviewer, with a reason and a rank so the "
        "API can present the review queue and its history."
    ),
    "AFFECTS": (
        "Alert -> Decision|Project.  Potentially affected entity.  Carries "
        "``certainty`` (``potential``/``confirmed``) so an alert never silently "
        "upgrades a suspicion into a verdict (spec S7/S11)."
    ),
    "EVIDENCE_FOR": (
        "Alert -> Fact.  The contradicting (new) fact and the contradicted (old) "
        "fact that justify the alert, so explanations are traceable to records."
    ),
}

REL_TYPES: tuple[str, ...] = _SPEC_REL_TYPES + tuple(ADDED_RELATIONSHIPS)

PROVENANCE_REL_TYPES: frozenset[str] = frozenset(
    {"STATES", "AUTHORED", "MENTIONS", "ABOUT", "RESOLVED", "TRIGGERED_BY", "EVIDENCE_FOR"}
)
"""Relationships that point at source records or the cause of an assertion."""


# --------------------------------------------------------------------------- #
# Controlled vocabularies
# --------------------------------------------------------------------------- #
FACT_STATUSES: tuple[str, ...] = ("ACTIVE", "CONTESTED", "INVALIDATED", "UNCERTAIN")

DECISION_STATUSES: tuple[str, ...] = (
    "ACTIVE",
    "POTENTIALLY_STALE",
    "STALE",
    "SUPERSEDED",
    "ARCHIVED",
)
"""``POTENTIALLY_STALE`` vs ``STALE`` is the core restraint mechanism (spec S7):
propagation marks a decision *potentially* affected, and only an explicit review
decision (or absence of independent supporting evidence) promotes it to
``STALE``.  A single changed fact never auto-invalidates a decision."""

REVIEW_STATUSES: tuple[str, ...] = (
    "UNREVIEWED",
    "NEEDS_REVIEW",
    "REVIEWED_ACCEPTED",
    "REVIEWED_REJECTED",
    "AUTO_ACCEPTED",
)

ALERT_STATUSES: tuple[str, ...] = (
    "NEW",
    "NEEDS_REVIEW",
    "CONFIRMED_STALE",
    "DISMISSED",
    "RESOLVED",
)

ALERT_STATUS_TRANSITIONS: Mapping[str, tuple[str, ...]] = {
    # Documented, enforced transitions (spec S11).  A same-status update is
    # always accepted as an idempotent no-op.
    "NEW": ("NEEDS_REVIEW", "CONFIRMED_STALE", "DISMISSED", "RESOLVED"),
    "NEEDS_REVIEW": ("CONFIRMED_STALE", "DISMISSED", "RESOLVED"),
    "CONFIRMED_STALE": ("RESOLVED", "DISMISSED", "NEEDS_REVIEW"),
    "DISMISSED": ("NEEDS_REVIEW", "RESOLVED"),
    "RESOLVED": ("NEEDS_REVIEW",),
}


class SchemaError(ValueError):
    """Raised when a node or edge violates the documented schema."""


# --------------------------------------------------------------------------- #
# Property sanitation / FalkorDB compatibility
# --------------------------------------------------------------------------- #
def _sanitize_value(value: Any) -> Any:
    """Coerce a value into something both JSON and FalkorDB can store."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple, set)):
        return [_sanitize_value(item) for item in value]
    if isinstance(value, Mapping):
        # Nested maps are stored as compact JSON text: FalkorDB properties are
        # scalars or flat arrays, and keeping the text preserves round-tripping.
        return json.dumps(value, sort_keys=True, default=str)
    return str(value)


def sanitize_props(
    props: Mapping[str, Any] | None, *, drop_none: bool = False
) -> dict[str, Any]:
    """Return a JSON/FalkorDB-safe copy of ``props``.

    ``drop_none=True`` omits ``None`` values entirely, which is what the FalkorDB
    adapter needs (a property set to ``None`` would erase an existing value).
    """
    out: dict[str, Any] = {}
    for key, value in (props or {}).items():
        if value is None and drop_none:
            continue
        if not isinstance(key, str) or not key:
            raise SchemaError(f"property keys must be non-empty strings, got {key!r}")
        out[key] = _sanitize_value(value)
    return out


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def validate_node_payload(label: str, node_id: str, name: str, props: Mapping[str, Any]) -> None:
    """Validate the parts of a node that the schema can check structurally."""
    if label not in NODE_TYPES:
        raise SchemaError(f"unknown node type {label!r}; expected one of {NODE_TYPES}")
    if not isinstance(node_id, str) or not node_id.strip():
        raise SchemaError("node id must be a non-empty string")
    if not isinstance(name, str) or not name.strip():
        raise SchemaError(f"node {node_id!r} requires a non-empty name")
    if label == "Document" and props.get("doc_type") not in (None, *DOC_TYPES):
        raise SchemaError(
            f"document {node_id!r} has invalid doc_type {props.get('doc_type')!r}; "
            f"expected one of {DOC_TYPES}"
        )
    if label == "Event" and props.get("event_type") not in (None, *EVENT_TYPES):
        raise SchemaError(
            f"event {node_id!r} has invalid event_type {props.get('event_type')!r}; "
            f"expected one of {EVENT_TYPES}"
        )
    status_vocabulary = _status_vocabulary(label)
    for key, allowed in (("status", status_vocabulary), ("review_status", REVIEW_STATUSES)):
        if allowed is None:
            # This node type has no controlled status vocabulary: source artifacts
            # carry provider statuses (``done``, ``in_progress``), stored verbatim.
            continue
        value = props.get(key)
        if value is not None and value not in allowed:
            raise SchemaError(
                f"{label} {node_id!r} has invalid {key} {value!r}; expected one of {allowed}"
            )
    confidence = props.get("confidence")
    if confidence is not None and not (0.0 <= float(confidence) <= 1.0):
        raise SchemaError(
            f"{label} {node_id!r} confidence must be within [0, 1], got {confidence!r}"
        )


def _status_vocabulary(label: str) -> tuple[str, ...] | None:
    """Controlled status vocabulary for a node type, or ``None`` when free text.

    Only ``Fact``, ``Decision`` and ``Alert`` have engine-enforced statuses.  Other
    types carry provider- or domain-specific values (a ticket's ``done``, a
    project's plan state), which are preserved verbatim rather than flattened into
    an alert vocabulary.
    """
    if label == "Fact":
        return FACT_STATUSES
    if label == "Decision":
        return DECISION_STATUSES
    if label == "Alert":
        return ALERT_STATUSES
    return None


def validate_edge_payload(rel: str, src: str, dst: str) -> None:
    """Validate relationship type and endpoints."""
    if rel not in REL_TYPES:
        raise SchemaError(f"unknown relationship type {rel!r}; expected one of {REL_TYPES}")
    if not isinstance(src, str) or not src.strip():
        raise SchemaError(f"relationship {rel} has an empty source id")
    if not isinstance(dst, str) or not dst.strip():
        raise SchemaError(f"relationship {rel} has an empty target id")
    if src == dst:
        raise SchemaError(f"relationship {rel} cannot be a self-loop on {src!r}")


def reason_for_addition(rel: str) -> str:
    """Human-readable justification for an added relationship type."""
    return ADDED_RELATIONSHIPS.get(rel, "")


def is_spec_relationship(rel: str) -> bool:
    """True when ``rel`` belongs to the original specification's list."""
    return rel in _SPEC_REL_TYPES


def all_rel_types() -> Iterable[str]:
    """Iterate every accepted relationship type."""
    return iter(REL_TYPES)
