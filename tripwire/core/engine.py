"""The graph intelligence engine - the single implementation both surfaces call.

``GraphEngine`` is the only place that orchestrates writes.  The FastAPI routes
(:mod:`tripwire.api`) and the MCP tools (:mod:`tripwire.mcp_server`) are thin
adapters over these methods, which is what keeps the HTTP API and MCP tools
consistent: there is exactly one implementation of every reasoning operation
(spec S12).

The end-to-end flow implemented by :meth:`GraphEngine.trigger_event`:

1. assert the new fact, with its source artifact and author,
2. run :func:`tripwire.core.contradictions.find_contradictions` against the graph,
3. record the ``CONTRADICTS`` relationship and update the bitemporal intervals,
4. run :func:`tripwire.core.staleness.plan_propagation` from the contradicted fact,
5. write ``POTENTIALLY_STALE`` (never ``STALE``), recording why and when,
6. raise de-duplicated alerts with evidence paths and assigned reviewers.

Every step is idempotent, so replaying the same event produces no duplicates and
no status regressions.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional, Sequence

from ..config import Settings, load_settings
from .alerts import (
    AlertDraft,
    assign_reviewers,
    create_alert,
    get_alert,
    list_alerts,
    transition_alert,
)
from .contradictions import ContradictionResult, find_contradictions
from .errors import NotFoundError, TripwireError, ValidationError
from .explain import explain_alert, explain_decision, explain_fact_change, explain_path
from .experts import ExpertReport, find_experts
from .history import (
    belief_at,
    changes_since,
    dependencies_at,
    fact_timeline,
    history_report,
    source_of_change,
    valid_at,
)
from .ids import event_id as make_event_id
from .ids import fact_id as make_fact_id
from .ids import message_id, person_id, short_hash, slug
from .index import GraphIndex
from .models import Edge, EvidencePath, Node, Subgraph
from .schema import ALERT_STATUS_TRANSITIONS, DECISION_STATUSES, NODE_TYPES, REL_TYPES
from .staleness import PropagationPlan, plan_propagation
from .store import GraphStore
from .timeutil import now_iso

logger = logging.getLogger("tripwire.engine")

__all__ = ["GraphEngine", "EngineError", "DATASET_META_EVENT"]

#: Deterministic id of the dataset marker event, used to detect a seeded graph.
DATASET_META_EVENT = make_event_id("SEED", "northwind-labs", "dataset-marker")


class EngineError(TripwireError):
    """Raised for engine-level failures that are not more specific."""

    code = "engine_error"


@dataclass
class AssertionResult:
    """Outcome of asserting one fact into the graph."""

    fact_id: str
    created: bool
    fact: dict[str, Any]
    source_id: Optional[str] = None
    author_id: Optional[str] = None


class GraphEngine:
    """Orchestrates every graph mutation and every reasoning operation."""

    def __init__(
        self,
        store: GraphStore,
        *,
        settings: Optional[Settings] = None,
        llm: Any = None,
    ) -> None:
        self.store = store
        self.settings = settings or Settings()
        self.llm = llm

    # ------------------------------------------------------------------ setup
    @classmethod
    def from_settings(cls, settings: Optional[Settings] = None, *, llm: Any = None) -> "GraphEngine":
        """Build an engine, applying the configured→fallback store policy."""
        resolved = settings or load_settings()
        store = _open_store(resolved)
        engine = cls(store, settings=resolved, llm=llm)
        if resolved.llm_enabled and llm is None:
            from ..ingest.llm_extractor import build_llm_client

            engine.llm = build_llm_client(resolved)
        logger.info(
            "engine ready: backend=%s nodes=%d edges=%d llm=%s",
            store.backend,
            store.node_count(),
            store.edge_count(),
            "enabled" if engine.llm else "disabled (deterministic rules only)",
        )
        return engine

    def index(self) -> GraphIndex:
        """Fresh, immutable snapshot of the graph."""
        if hasattr(self.store, "reload_if_changed"):
            try:
                self.store.reload_if_changed()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001 - never let a reload break a read
                pass
        return GraphIndex.from_store(self.store)

    # ------------------------------------------------- low-level write helpers
    def put_node(self, node: Node) -> Node:
        """Upsert a node through the single write path."""
        return self.store.upsert_node(node)

    def put_edge(self, edge: Edge) -> Edge:
        """Upsert an edge through the single write path."""
        return self.store.upsert_edge(edge)

    def ensure_person(self, name: str, **props: Any) -> Node:
        """Resolve a person by name to a stable node, creating them if new."""
        identifier = person_id(name)
        existing = self.store.get_node(identifier)
        payload = {"display_name": name, **{k: v for k, v in props.items() if v is not None}}
        if existing is None:
            return self.put_node(Node(id=identifier, label="Person", name=name, props=payload))
        return self.put_node(Node(id=identifier, label="Person", name=name, props=payload))

    def ensure_entity(
        self,
        name_or_id: str,
        *,
        label: Optional[str] = None,
        **props: Any,
    ) -> Node:
        """Resolve a free-text entity reference to a node id.

        Resolution order: exact id, then slug match within the inferred label set,
        then an existing node whose slugified name matches.  If nothing matches and
        a label is supplied, a new node is created with a deterministic id - which
        is what makes re-ingesting the same source idempotent.
        """
        if not name_or_id:
            raise ValidationError("entity reference must be a non-empty string")
        direct = self.store.get_node(name_or_id)
        if direct is not None:
            return direct

        wanted = slug(name_or_id)
        pool = self.store.get_nodes(label=label) if label else self.store.all_nodes()
        candidates = list(pool)
        for node in candidates:
            if slug(node.name) == wanted or slug(node.id.split(":", 1)[-1]) == wanted:
                return node

        resolved_label = label or _infer_label(name_or_id)
        if resolved_label not in NODE_TYPES:
            raise ValidationError(f"cannot infer a valid node type for {name_or_id!r}")
        prefix = resolved_label.lower()
        return self.put_node(
            Node(id=f"{prefix}:{wanted}", label=resolved_label, name=name_or_id, props=props)
        )

    def ensure_source(
        self,
        *,
        kind: str,
        external_id: str,
        name: str,
        author: Optional[str] = None,
        timestamp: Optional[str] = None,
        source_ref: Optional[str] = None,
        **props: Any,
    ) -> Node:
        """Resolve or create a ``Message``/``Document`` source artifact."""
        identifier = (
            message_id(kind, external_id) if kind == "slack" else f"document:{slug(kind)}:{slug(external_id)}"
        )
        author_id = None
        if author:
            author = self.ensure_person(author)
            author_id = author.id
        node = self.put_node(
            Node(
                id=identifier,
                label="Message" if kind == "slack" else "Document",
                name=name,
                props={
                    "source_system": kind,
                    "external_id": external_id,
                    "doc_type": props.pop("doc_type", None) or ("ticket" if kind == "ticket" else kind),
                    "author_id": author_id,
                    "timestamp": timestamp,
                    "source_ref": source_ref,
                    **{k: v for k, v in props.items() if v is not None},
                },
            )
        )
        if author_id:
            self.put_edge(Edge(src=author_id, rel="AUTHORED", dst=node.id, props={"at": timestamp}))
        return node

    # ------------------------------------------------------------- assertions
    def assert_fact(
        self,
        *,
        subject: str,
        attribute: str,
        value: Any,
        statement: str = "",
        subject_label: Optional[str] = None,
        source: Optional[Mapping[str, Any]] = None,
        valid_from: Optional[str] = None,
        valid_to: Optional[str] = None,
        recorded_at: Optional[str] = None,
        confidence: float = 0.9,
        verified: bool = True,
        status: str = "ACTIVE",
        extra: Optional[Mapping[str, Any]] = None,
    ) -> AssertionResult:
        """Assert a fact, attaching its source, and return the stable fact id.

        ``recorded_at`` defaults to the source timestamp (falling back to now) and
        is **immutable once set**, so re-ingesting an old source does not pretend
        Tripwire learned it today.
        """
        subject_node = self.ensure_entity(subject, label=subject_label)
        source_node = None
        author_id = None
        source_timestamp = None
        if source:
            kind = str(source.get("kind") or "doc").lower()
            external_id = str(source.get("external_id") or short_hash(subject, attribute, value))
            source_timestamp = source.get("timestamp")
            source_node = self.ensure_source(
                kind=kind,
                external_id=external_id,
                name=str(source.get("name") or f"{kind} {external_id}"),
                author=source.get("author"),
                timestamp=source_timestamp,
                source_ref=source.get("source_ref"),
                doc_type=source.get("doc_type"),
                text=source.get("text"),
                url=source.get("url"),
                channel=source.get("channel"),
                confidence=source.get("confidence"),
            )
            author_id = source_node.props.get("author_id")

        moment_recorded = recorded_at or source_timestamp or now_iso()
        moment_valid = valid_from or source_timestamp or moment_recorded
        identifier = make_fact_id(subject_node.id, attribute, value, moment_valid)
        existing = self.store.get_node(identifier)

        node = self.put_node(
            Node(
                id=identifier,
                label="Fact",
                name=statement or f"{subject_node.name}: {attribute} = {value}",
                props={
                    "subject_id": subject_node.id,
                    "subject_name": subject_node.name,
                    "attribute": attribute,
                    "value": value,
                    "statement": statement or f"{subject_node.name}: {attribute} = {value}",
                    "valid_from": moment_valid,
                    "valid_to": valid_to,
                    "recorded_at": moment_recorded,
                    "status": status,
                    "confidence": confidence,
                    "verified": verified,
                    "review_status": "AUTO_ACCEPTED" if verified else "NEEDS_REVIEW",
                    "source_id": source_node.id if source_node else None,
                    "source_ref": (source.get("source_ref") if source else None),
                    **(dict(extra) if extra else {}),
                },
            )
        )
        if source_node is not None:
            self.put_edge(
                Edge(
                    src=source_node.id,
                    rel="STATES",
                    dst=node.id,
                    props={"at": source_timestamp, "recorded_at": moment_recorded},
                )
            )
        self._event(
            kind="FACT_ASSERTED" if existing is None else "FACT_RESTATED",
            subject_id=node.id,
            summary=(
                f"Fact asserted: {node.name}"
                + (f" (source {source_node.props.get('source_ref')})" if source_node else "")
            ),
            moment=moment_recorded,
            actor_id=author_id,
            extra={
                "fact_id": node.id,
                "attribute": attribute,
                "value": value,
                "subject_id": subject_node.id,
                "source_id": source_node.id if source_node else None,
                "duplicate": existing is not None,
            },
        )
        return AssertionResult(
            fact_id=node.id,
            created=existing is None,
            fact=node.to_view(),
            source_id=source_node.id if source_node else None,
            author_id=author_id,
        )

    # ------------------------------------------------------- contradiction flow
    def find_contradictions(
        self,
        *,
        fact_id: Optional[str] = None,
        candidate: Optional[Mapping[str, Any]] = None,
        use_llm: bool = True,
    ) -> dict[str, Any]:
        """``find_contradictions`` - compare a fact (existing or hypothetical) with knowledge."""
        index = self.index()
        if fact_id:
            node = index.node(fact_id)
            if node is None:
                raise NotFoundError(f"fact {fact_id!r} is not present in the graph")
            target: Node | str = node
        elif candidate:
            target = _ephemeral_fact(candidate, index)
        else:
            raise ValidationError("either fact_id or candidate must be supplied")

        llm = self.llm if (use_llm and self.llm is not None) else None
        result = find_contradictions(
            target,
            index,
            llm=llm,
            verified_confidence_floor=self.settings.verified_confidence_floor,
        )
        return {
            **result.as_dict(),
            "paths": [
                _contradiction_path(index, c.existing_fact_id, result.new_fact_id).as_dict()
                for c in result.candidates
                if c.contradicts and c.existing_fact_id
            ],
        }

    def record_contradiction(
        self,
        result: ContradictionResult,
        *,
        index: GraphIndex,
        actor_id: Optional[str] = None,
        now: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Persist ``CONTRADICTS`` edges and apply bitemporal updates.

        Bitemporal policy (spec S8)
        ---------------------------
        * The original fact is **always preserved**.
        * A **verified** contradiction closes the original's real-world interval at
          the new fact's ``valid_from`` (when the evidence supports that instant)
          and closes its transaction interval, because Tripwire now believes the
          newer correction.
        * An **unverified** contradiction only sets the original's status to
          ``CONTESTED`` and leaves both intervals open: Tripwire still provisionally
          believes it, so its history must not be rewritten.
        """
        moment = now or now_iso()
        applied: list[dict[str, Any]] = []
        for candidate in result.contradictions:
            if candidate.already_recorded:
                # Replay: the edge, its bitemporal updates and its event already
                # exist.  Skipping keeps the recorded `at`/history intact instead of
                # rewriting it with today's clock.
                continue
            old_id, new_id = candidate.existing_fact_id, candidate.new_fact_id
            if not old_id or index.node(old_id) is None or index.node(new_id) is None:
                continue
            new_fact = index.node(new_id)
            old_fact = index.node(old_id)
            verified = bool(new_fact.props.get("verified", True)) and candidate.kind == "contradiction"
            edge_props = {
                "at": moment,
                "kind": candidate.kind,
                "status": "VERIFIED" if verified else "UNVERIFIED",
                "confidence": round(candidate.confidence, 3),
                "rule": candidate.explicit_rule,
                "rationale": candidate.rationale,
                "review_status": candidate.review_status,
                "detected_by": "rules" + ("+llm" if candidate.llm_assisted else ""),
                "verified": verified,
            }
            self.put_edge(Edge(src=new_id, rel="CONTRADICTS", dst=old_id, props=edge_props))

            updates: dict[str, Any] = {}
            if verified:
                effective_to = new_fact.props.get("valid_from") or moment
                updates = {
                    "status": "INVALIDATED",
                    "valid_to": effective_to,
                    "recorded_to": moment,
                    "invalidated_by": new_id,
                    "review_status": "AUTO_ACCEPTED",
                }
            else:
                updates = {
                    "status": "CONTESTED",
                    "contested_by": new_id,
                    "review_status": "NEEDS_REVIEW",
                    "contested_at": moment,
                }
            self.put_node(
                Node(
                    id=old_id,
                    label="Fact",
                    name=old_fact.name,
                    props=updates,
                )
            )
            if not verified:
                self.put_node(
                    Node(
                        id=new_id,
                        label="Fact",
                        name=new_fact.name,
                        props={"status": "UNCERTAIN", "review_status": "NEEDS_REVIEW"},
                    )
                )
            self._event(
                kind="FACT_CHANGE",
                subject_id=old_id,
                summary=(
                    f"Fact '{old_fact.name}' {'invalidated' if verified else 'contested'} by "
                    f"'{new_fact.name}' ({candidate.kind}, confidence {candidate.confidence:.2f})"
                ),
                moment=moment,
                actor_id=actor_id,
                extra={
                    "fact_id": old_id,
                    "old_fact_id": old_id,
                    "new_fact_id": new_id,
                    "kind": candidate.kind,
                    "verified": verified,
                    "attribute": candidate.attribute,
                    "confidence": round(candidate.confidence, 3),
                    "explicit_rule": candidate.explicit_rule,
                },
            )
            applied.append(
                {
                    "old_fact_id": old_id,
                    "new_fact_id": new_id,
                    "kind": candidate.kind,
                    "verified": verified,
                    "confidence": round(candidate.confidence, 3),
                    "old_fact_status_after": updates["status"],
                    "valid_to": updates.get("valid_to"),
                    "recorded_to": updates.get("recorded_to"),
                    "rule": candidate.explicit_rule,
                }
            )
        return applied

    # ---------------------------------------------------------- propagation
    def plan_staleness(
        self,
        fact_id: str,
        *,
        max_depth: Optional[int] = None,
        changed_fact_ids: Optional[Iterable[str]] = None,
        reference_time: Optional[str] = None,
        index: Optional[GraphIndex] = None,
    ) -> PropagationPlan:
        """Plan staleness propagation without writing anything."""
        snapshot = index or self.index()
        return plan_propagation(
            snapshot,
            fact_id,
            max_depth=max_depth if max_depth is not None else self.settings.max_propagation_depth,
            reference_time=reference_time,
            changed_fact_ids=changed_fact_ids,
        )

    def apply_staleness(
        self,
        plan: PropagationPlan,
        *,
        index: Optional[GraphIndex] = None,
        actor_id: Optional[str] = None,
        now: Optional[str] = None,
        create_alerts: bool = True,
    ) -> dict[str, Any]:
        """Write a propagation plan: flag entities, record why/when, raise alerts.

        Only ``POTENTIALLY_STALE`` is ever written here.  Promotion to ``STALE``
        requires an explicit review through
        :func:`tripwire.core.alerts.promote_decision` (spec S7).

        Status writes are monotonic: an entity already ``STALE``, ``SUPERSEDED`` or
        ``ARCHIVED`` is left alone, so replaying an event cannot regress a reviewed
        outcome.
        """
        moment = now or now_iso()
        snapshot = index or self.index()
        impacts: list[dict[str, Any]] = []

        for affected in plan.affected:
            entity = self.store.get_node(affected.entity_id)
            if entity is None:
                continue
            status_before = entity.props.get("status")
            flagged = False
            updates: dict[str, Any] = {}

            if entity.label == "Decision":
                if status_before in ("POTENTIALLY_STALE", "STALE", "SUPERSEDED", "ARCHIVED"):
                    # Already flagged by this or a reviewed change.  Re-evaluation
                    # refreshes the reason and certainty but must not append another
                    # status-change event or STALED edge, so replaying an event is a
                    # true no-op on history (spec S7).
                    updates = {
                        "stale_reason": entity.props.get("stale_reason") or affected.reason,
                        "stale_cause_fact_id": entity.props.get("stale_cause_fact_id")
                        or plan.source_fact_id,
                        "stale_certainty": affected.certainty,
                        "last_evaluated_at": moment,
                    }
                    self.put_node(
                        Node(id=entity.id, label=entity.label, name=entity.name, props=updates)
                    )
                    re_view, re_reviewers = (
                        self._raise_alert(plan, affected, entity, moment, actor_id, snapshot)
                        if create_alerts
                        else (None, [])
                    )
                    impacts.append(
                        self._impact_view(
                            entity,
                            status_before,
                            updates.get("status") or updates.get("staleness_flag"),
                            False,
                            affected,
                            reviewer_override=re_reviewers,
                            alert_override=re_view,
                        )
                    )
                    continue
                updates = {
                    "status": "POTENTIALLY_STALE",
                    "previous_status": status_before,
                    "stale_reason": affected.reason,
                    "stale_since": entity.props.get("stale_since") or moment,
                    "stale_cause_fact_id": plan.source_fact_id,
                    "stale_certainty": affected.certainty,
                    "review_status": "NEEDS_REVIEW",
                    "last_evaluated_at": moment,
                }
                flagged = True
            else:
                # Projects carry a review flag rather than being forced into the
                # decision status vocabulary - their plan status is separate.
                updates = {
                    "staleness_flag": "POTENTIALLY_STALE",
                    "review_reason": affected.reason,
                    "review_since": entity.props.get("review_since") or moment,
                    "stale_cause_fact_id": plan.source_fact_id,
                    "stale_certainty": affected.certainty,
                    "last_evaluated_at": moment,
                }
                if entity.props.get("staleness_flag") != "POTENTIALLY_STALE":
                    flagged = True

            self.put_node(
                Node(id=entity.id, label=entity.label, name=entity.name, props=updates)
            )

            if flagged and self.store.get_node(plan.source_fact_id) is not None:
                self.put_edge(
                    Edge(
                        src=plan.source_fact_id,
                        rel="STALED",
                        dst=entity.id,
                        props={
                            "at": moment,
                            "reason": affected.reason,
                            "certainty": affected.certainty,
                            "depth": affected.depth,
                        },
                    )
                )
                self._event(
                    kind="STATUS_CHANGE",
                    subject_id=entity.id,
                    summary=(
                        f"'{entity.name}' flagged "
                        f"{updates.get('status') or updates.get('staleness_flag')} because of fact "
                        f"'{plan.source_fact_name}'"
                    ),
                    moment=moment,
                    actor_id=actor_id,
                    extra={
                        "entity_id": entity.id,
                        "from_status": status_before,
                        "to_status": updates.get("status") or updates.get("staleness_flag"),
                        "cause_fact_id": plan.source_fact_id,
                        "certainty": affected.certainty,
                    },
                )

            alert_view, reviewers = (
                self._raise_alert(plan, affected, entity, moment, actor_id, snapshot)
                if create_alerts
                else (None, [])
            )
            impacts.append(
                self._impact_view(
                    entity, status_before, updates.get("status") or updates.get("staleness_flag"),
                    flagged, affected, reviewer_override=reviewers, alert_override=alert_view,
                )
            )

        return {
            "source_fact_id": plan.source_fact_id,
            "applied_at": moment,
            "impact_count": len(impacts),
            "decision_count": len([i for i in impacts if i["entity_label"] == "Decision"]),
            "project_count": len([i for i in impacts if i["entity_label"] == "Project"]),
            "impacts": impacts,
            "notes": list(plan.notes),
        }

    def _raise_alert(
        self,
        plan: PropagationPlan,
        affected: Any,
        entity: Node,
        moment: str,
        actor_id: Optional[str],
        snapshot: Optional[GraphIndex] = None,
    ) -> tuple[Optional[dict[str, Any]], list[dict[str, Any]]]:
        """Create (or re-find) the deduplicated alert for one affected entity.

        Safe to call repeatedly: the alert id derives from the contradiction, so a
        replay resolves to the existing alert and no second alert is created.
        """
        index = snapshot or self.index()
        primary_path = affected.paths[0].as_dict() if affected.paths else {"nodes": [], "rels": []}
        draft = AlertDraft(
            old_fact_id=plan.source_fact_id,
            new_fact_id=self._contradicting_fact_for(plan, index),
            entity_id=entity.id,
            entity_label=entity.label,
            entity_name=entity.name,
            attribute=self._attribute_of(plan.source_fact_id, index),
            severity="high" if affected.certainty == "confirmed" else "medium",
            certainty=affected.certainty,
            confidence=self._confidence_for(plan, affected),
            title=(
                f"{entity.name}: {affected.certainty} impact from a change to "
                f"'{plan.source_fact_name}'"
            ),
            summary=(
                f"'{plan.source_fact_name}' changed. '{entity.name}' "
                f"{'depends directly on' if affected.depth == 0 else 'depends on'} "
                f"{', '.join(affected.contributing_assumptions) or 'the affected assumption'}. "
                + (
                    "Independent supporting evidence exists, so this is flagged for review "
                    "rather than declared stale."
                    if affected.has_alternate_evidence
                    else "No surviving independent support was found."
                )
            ),
            reason=affected.reason,
            trigger_assumption_id=(
                affected.contributing_assumptions[0] if affected.contributing_assumptions else None
            ),
            path_nodes=list(primary_path.get("nodes") or []),
            path_rels=list(primary_path.get("rels") or []),
            source_refs=self._source_refs(index, affected.contributing_facts),
            evidence_fact_ids=list(affected.contributing_facts),
            certainty_sources=[e.fact_id for e in affected.alternate_evidence],
            actor_id=actor_id,
            extra={"certainty_status": affected.certainty},
        )
        alert, created = create_alert(self.store, draft, now=moment)
        reviewers = self._reviewers_for(index, entity.id)
        if reviewers:
            alert = assign_reviewers(self.store, alert.id, reviewers)
        if created and plan.source_fact_verified and reviewers:
            try:
                alert = transition_alert(
                    self.store,
                    alert.id,
                    "NEEDS_REVIEW",
                    note="Routed to reviewers after a verified contradiction.",
                    now=moment,
                )
            except TripwireError as exc:  # pragma: no cover - defensive
                logger.warning("alert routing failed for %s: %s", alert.id, exc)
        self._remember_alert(entity.id, alert.id, moment)
        return (
            {
                "alert_id": alert.id,
                "status": alert.props.get("status"),
                "created": created,
                "certainty": alert.props.get("certainty"),
                "severity": alert.props.get("severity"),
                "confidence": alert.props.get("confidence"),
                "title": alert.name,
                "summary": alert.props.get("summary"),
                "reviewers": [r["person_id"] for r in reviewers],
            },
            reviewers,
        )

    @staticmethod
    def _impact_view(
        entity: Node,
        status_before: Any,
        status_after: Any,
        flagged: bool,
        affected: Any,
        *,
        reviewer_override: Optional[list[dict[str, Any]]] = None,
        alert_override: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Uniform impact record for both first-time and re-evaluated entities."""
        return {
            "entity_id": entity.id,
            "entity_label": entity.label,
            "entity_name": entity.name,
            "status_before": status_before,
            "status_after": status_after,
            "flagged": flagged,
            "certainty": affected.certainty,
            "depth": affected.depth,
            "reason": affected.reason,
            "has_alternate_evidence": affected.has_alternate_evidence,
            "alternate_evidence": [e.as_dict() for e in affected.alternate_evidence],
            "paths": [p.as_dict() for p in affected.paths],
            "alert": alert_override,
            "reviewers": reviewer_override or [],
        }

    def _remember_alert(self, entity_id: str, alert_id: str, moment: str) -> None:
        """Append an alert id to the entity's recorded alert history."""
        entity = self.store.get_node(entity_id)
        if entity is None:
            return
        existing = list(entity.props.get("stale_alert_ids") or [])
        if alert_id in existing:
            return
        existing.append(alert_id)
        self.put_node(
            Node(
                id=entity.id,
                label=entity.label,
                name=entity.name,
                props={"stale_alert_ids": sorted(existing)},
            )
        )

    def _contradicting_fact_for(self, plan: PropagationPlan, index: GraphIndex) -> Optional[str]:
        """The fact that contradicts the propagation source, when known."""
        for edge in index.out(plan.source_fact_id, ["CONTRADICTS"]):
            if edge.props.get("status") in ("VERIFIED", "UNVERIFIED"):
                return edge.dst
        for edge in index.incoming(plan.source_fact_id, ["CONTRADICTS"]):
            return edge.src
        return None

    @staticmethod
    def _attribute_of(fact_id: str, index: GraphIndex) -> Optional[str]:
        """Attribute name of a fact, for alert payloads."""
        return index.prop(fact_id, "attribute")

    @staticmethod
    def _confidence_for(plan: PropagationPlan, affected: Any) -> float:
        """Alert confidence derived from the contradiction and the evidence."""
        base = 0.55 if affected.certainty == "confirmed" else 0.4
        if affected.has_alternate_evidence:
            base -= 0.1
        if not plan.source_fact_verified:
            base -= 0.15
        return round(max(0.05, min(0.95, base + 0.1 * (1 if affected.contributing_assumptions else 0))), 3)

    @staticmethod
    def _source_refs(index: GraphIndex, fact_ids: Iterable[str], limit: int = 8) -> list[str]:
        """Human-readable source references backing a set of facts."""
        refs: list[str] = []
        for fact_id in fact_ids:
            for source_id in index.sources(fact_id, ["STATES"]):
                ref = index.prop(source_id, "source_ref") or source_id
                if ref not in refs:
                    refs.append(str(ref))
                if len(refs) >= limit:
                    return refs
        return refs

    def _reviewers_for(
        self, index: GraphIndex, entity_id: str, limit: int = 3
    ) -> list[dict[str, Any]]:
        """Suggest reviewers from contribution evidence, with a documented fallback.

        The expert finder ranks people by actual contribution.  When it finds
        nothing (for example a project with no recorded artefacts), the fallback is
        the people who *made* the affected decision plus the authors of its
        supporting sources - a weaker but honest signal, marked as such.
        """
        entity = index.node(entity_id)
        if entity is None:
            return []
        target = entity_id
        if entity.label == "Decision":
            projects = [p for p in index.targets(entity_id, ["IMPACTS"])
                        if index.label(p) == "Project"]
            if projects:
                target = projects[0]
        report: Optional[ExpertReport] = None
        if index.label(target) in ("Project", "System", "Team"):
            report = find_experts(index, target, limit=limit)
        if report is not None and report.experts:
            return [
                {
                    "person_id": expert.person_id,
                    "person_name": expert.person_name,
                    "rank": expert.rank,
                    "reason": expert.reason,
                    "normalized_score": expert.normalized_score,
                }
                for expert in report.experts[:limit]
            ]

        fallback: list[dict[str, Any]] = []
        for person_id in index.sources(entity_id, ["MADE"]):
            fallback.append(
                {
                    "person_id": person_id,
                    "person_name": index.name(person_id),
                    "rank": len(fallback) + 1,
                    "reason": "Made the affected decision; the only recorded human link.",
                    "normalized_score": 0.0,
                }
            )
        if not fallback:
            for dependency in index.out(entity_id, ["ASSUMES"]):
                for fact_id in index.targets(dependency.dst, ["SUPPORTED_BY"]):
                    for source_id in index.sources(fact_id, ["STATES"]):
                        author_id = index.prop(source_id, "author_id")
                        if author_id and author_id not in {f["person_id"] for f in fallback}:
                            fallback.append(
                                {
                                    "person_id": author_id,
                                    "person_name": index.name(author_id),
                                    "rank": len(fallback) + 1,
                                    "reason": (
                                        "Authored a source record behind the decision's "
                                        "assumption; no stronger contribution evidence exists."
                                    ),
                                    "normalized_score": 0.0,
                                }
                            )
        return fallback[:limit]

    # ------------------------------------------------------------ demo flows
    def trigger_event(self, payload: Mapping[str, Any], *, apply: bool = True) -> dict[str, Any]:
        """Run the complete contradiction → propagation → alert flow.

        Accepts either ``{"scenario": "<name>"}`` for a deterministic, offline
        demo event or an explicit ``{"new_fact": {...}, "source": {...}}`` payload.
        """
        spec = self._event_spec(payload)
        moment = spec.get("recorded_at") or now_iso()
        assertion = self.assert_fact(**spec["fact"], source=spec.get("source"), recorded_at=moment)

        index = self.index()
        llm = self.llm if spec.get("use_llm", True) else None
        contradiction = find_contradictions(
            index.node(assertion.fact_id),  # type: ignore[arg-type]
            index,
            llm=llm,
            verified_confidence_floor=self.settings.verified_confidence_floor,
        )

        response: dict[str, Any] = {
            "event": {
                "triggered_at": moment,
                "scenario": spec.get("scenario"),
                "actor_id": spec.get("actor_id"),
                "applied": apply,
                "llm_enabled": bool(self.llm) and spec.get("use_llm", True),
            },
            "assertion": {
                "fact_id": assertion.fact_id,
                "created": assertion.created,
                "fact": assertion.fact,
                "source_id": assertion.source_id,
                "author_id": assertion.author_id,
            },
        }

        if not contradiction.found:
            response["contradiction"] = {
                **contradiction.as_dict(),
                "detected": False,
                "reason": (
                    "No existing fact conflicts with this claim; it was recorded as new "
                    "information and no alert was raised."
                ),
            }
            response["applied"] = []
            response["propagation"] = None
            response["impacts"] = []
            response["contradiction_edges"] = []
            response["alert_ids"] = []
            return response

        primary = contradiction.primary
        contradicting_edges = self.record_contradiction(
            contradiction, index=self.index(), now=moment
        ) if apply else []

        fresh_index = self.index()
        old_fact_id = primary.existing_fact_id if primary else None
        plan = self.plan_staleness(
            old_fact_id or assertion.fact_id,
            changed_fact_ids={old_fact_id, assertion.fact_id} - {None},
            index=fresh_index,
            reference_time=moment,
        )
        applied = (
            self.apply_staleness(plan, index=fresh_index, now=moment)
            if apply
            else {
                "source_fact_id": plan.source_fact_id,
                "applied_at": moment,
                "impact_count": len(plan.affected),
                "impacts": [a.as_dict() for a in plan.affected],
                "notes": list(plan.notes),
                "dry_run": True,
            }
        )

        response["contradiction"] = {**contradiction.as_dict(), "detected": True}
        # ``applied`` reports what the contradiction step persisted; ``staleness``
        # carries the full propagation write result.  Both keys are present on every
        # response shape so a client never has to branch on whether a conflict was
        # found.
        response["applied"] = contradicting_edges
        response["contradiction_edges"] = contradicting_edges
        response["staleness"] = applied
        response["propagation"] = plan.as_dict()
        response["impacts"] = applied.get("impacts", [])
        response["alert_ids"] = sorted(
            {
                impact["alert"]["alert_id"]
                for impact in applied.get("impacts", [])
                if impact.get("alert")
            }
        )
        if not plan.affected:
            response["propagation"]["notes"] = list(plan.notes)
        return response

    def _event_spec(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        """Normalise a trigger-event payload into an assertion specification."""
        if not isinstance(payload, Mapping):
            raise ValidationError("trigger-event payload must be a JSON object")
        if payload.get("scenario"):
            from ..dataset.northwind import scenario_event

            try:
                spec = dict(scenario_event(str(payload["scenario"])))
            except KeyError as exc:
                raise ValidationError(str(exc)) from exc
            spec.setdefault("scenario", str(payload["scenario"]))
            if payload.get("recorded_at"):
                spec["recorded_at"] = payload["recorded_at"]
            return spec

        fact_payload = payload.get("new_fact") or payload.get("fact")
        if not isinstance(fact_payload, Mapping):
            raise ValidationError(
                "payload must include either 'scenario' or a 'new_fact' object with "
                "subject, attribute and value"
            )
        missing = [key for key in ("subject", "attribute", "value") if fact_payload.get(key) is None]
        if missing:
            raise ValidationError(f"new_fact is missing required field(s): {', '.join(missing)}")
        return {
            "scenario": None,
            "fact": {
                "subject": fact_payload["subject"],
                "attribute": fact_payload["attribute"],
                "value": fact_payload["value"],
                "statement": fact_payload.get("statement") or "",
                "subject_label": fact_payload.get("subject_label"),
                "valid_from": fact_payload.get("valid_from"),
                "valid_to": fact_payload.get("valid_to"),
                "confidence": float(fact_payload.get("confidence", 0.9)),
                "verified": bool(fact_payload.get("verified", True)),
                "status": fact_payload.get("status", "ACTIVE"),
                "extra": dict(fact_payload.get("extra") or {}),
            },
            "source": payload.get("source"),
            "actor_id": payload.get("actor_id"),
            "recorded_at": payload.get("recorded_at"),
            "use_llm": bool(payload.get("use_llm", True)),
        }

    # ------------------------------------------------------- dataset lifecycle
    def seed_demo(self, *, force: bool = False) -> dict[str, Any]:
        """Seed the deterministic Northwind Labs dataset (idempotent)."""
        from ..dataset.northwind import build_subgraph, dataset_manifest

        before = (self.store.node_count(), self.store.edge_count())
        subgraph = build_subgraph()
        self.store.upsert_subgraph(subgraph)
        after = (self.store.node_count(), self.store.edge_count())
        manifest = dataset_manifest()
        self._event(
            kind="SEED",
            subject_id=None,
            summary=(
                f"Northwind Labs dataset {manifest['version']} seeded: "
                f"{len(subgraph.nodes)} nodes, {len(subgraph.edges)} edges"
            ),
            moment=now_iso(),
            extra={
                "dataset_version": manifest["version"],
                "expected_counts": manifest["expected_counts"],
                "generated_counts": {
                    "nodes": len(subgraph.nodes),
                    "edges": len(subgraph.edges),
                },
            },
        )
        return {
            "seeded": True,
            "forced": bool(force),
            "nodes_before": before[0],
            "edges_before": before[1],
            "nodes_after": after[0],
            "edges_after": after[1],
            "nodes_written": len(subgraph.nodes),
            "edges_written": len(subgraph.edges),
            "manifest": manifest,
            "actual_counts": self.counts(),
            "state": self.demo_state(),
        }

    def reset(self) -> dict[str, Any]:
        """Restore the pristine demonstration state."""
        self.store.clear()
        self._event(
            kind="RESET",
            subject_id=None,
            summary="Graph cleared; demonstration state restoring",
            moment=now_iso(),
        )
        result = self.seed_demo(force=True)
        return {"reset": True, **result}

    def is_seeded(self) -> bool:
        """True when a dataset ``SEED`` event is present in the graph."""
        return bool(self.store.get_nodes(label="Event", where={"event_type": "SEED"}))

    def counts(self) -> dict[str, Any]:
        """Node/edge counts grouped by type."""
        return {
            "nodes": self.store.node_count(),
            "edges": self.store.edge_count(),
            "by_label": self.store.counts_by_label(),
            "by_rel": self.store.counts_by_rel(),
        }

    def demo_state(self) -> dict[str, Any]:
        """Full demo status: store, dataset, alerts, history and key entities."""
        from ..dataset.northwind import KEY_IDS, dataset_manifest

        index = self.index()
        manifest = dataset_manifest()
        alerts = list_alerts(self.store, limit=200)
        expected = manifest["expected_counts"]
        actual = self.store.counts_by_label()
        return {
            "seeded": self.is_seeded(),
            "dataset": {
                "name": manifest["name"],
                "version": manifest["version"],
                "storyline": manifest["storyline"],
                "expected_counts": expected,
                "actual_counts": actual,
                "matches_expected": {
                    label: actual.get(label, 0) == count for label, count in expected.items()
                },
            },
            "store": {
                "configured_backend": self.settings.store_backend,
                "active_backend": self.store.backend,
                "health": self.store.health(),
            },
            "llm": {
                "enabled": self.llm is not None,
                "provider": self.settings.llm_provider,
                "model": self.settings.llm_model,
                "note": (
                    "Deterministic rule engine in use; no external AI credentials required."
                    if self.llm is None
                    else "Live LLM configured for extraction and semantic comparison."
                ),
            },
            "counts": self.counts(),
            "key_entities": KEY_IDS,
            "alerts": {
                "total": alerts["total"],
                "status_counts": alerts["status_counts"],
            },
            "history": history_report(index),
            "config": self.settings.public_summary(),
        }

    # ------------------------------------------------------------- read paths
    def find_experts(self, query: str, *, limit: int = 5) -> dict[str, Any]:
        """``find_experts`` - rank people by demonstrated contribution."""
        report = find_experts(self.index(), query, limit=limit)
        return report.as_dict()

    def explain_path(
        self,
        source_id: str,
        target_id: str,
        *,
        rels: Optional[Sequence[str]] = None,
        max_depth: int = 6,
    ) -> dict[str, Any]:
        """``explain_path`` - relationship paths between two entities."""
        return explain_path(self.index(), source_id, target_id, rels=rels, max_depth=max_depth)

    def explain_decision(self, decision_id: str) -> dict[str, Any]:
        """Structured explanation of a decision and its evidence."""
        return explain_decision(self.index(), decision_id, store=self.store)

    def explain_alert_payload(self, alert_id: str) -> dict[str, Any]:
        """Structured explanation of an alert."""
        return explain_alert(self.index(), alert_id, store=self.store)

    def explain_fact(self, fact_id: str) -> dict[str, Any]:
        """Structured explanation of a fact change."""
        return explain_fact_change(self.index(), fact_id, store=self.store)

    def graph_payload(
        self,
        *,
        labels: Optional[Sequence[str]] = None,
        node_limit: Optional[int] = None,
        edge_limit: Optional[int] = None,
        around: Optional[str] = None,
        depth: int = 1,
        include_alerts: bool = True,
    ) -> dict[str, Any]:
        """Serialisable graph for the frontend, with optional neighbourhood focus."""
        index = self.index()
        nodes = list(index.nodes.values())
        if labels:
            wanted = set(labels)
            unknown = wanted - set(NODE_TYPES)
            if unknown:
                raise ValidationError(f"unknown node types requested: {sorted(unknown)}")
            nodes = [node for node in nodes if node.label in wanted]
        if around:
            focus = index.traverse(
                [around], direction="both", max_depth=max(0, depth)
            )
            keep = set(focus.order)
            if not include_alerts:
                keep = {node_id for node_id in keep if index.label(node_id) != "Alert"}
            nodes = [node for node in nodes if node.id in keep]
        node_ids = {node.id for node in nodes}
        edges = [
            edge for edge in index.edges if edge.src in node_ids and edge.dst in node_ids
        ]
        total_nodes, total_edges = len(nodes), len(edges)
        if node_limit is not None:
            nodes = nodes[:node_limit]
        if edge_limit is not None:
            edges = edges[:edge_limit]
        return {
            "nodes": [node.to_view() for node in nodes],
            "edges": [edge.to_view() for edge in edges],
            "meta": {
                "node_count": len(nodes),
                "edge_count": len(edges),
                "total_nodes": total_nodes,
                "total_edges": total_edges,
                "truncated": (node_limit is not None and total_nodes > node_limit)
                or (edge_limit is not None and total_edges > edge_limit),
                "focus": around,
                "depth": depth if around else None,
            },
        }

    def search(self, query: str, *, limit: int = 25) -> dict[str, Any]:
        """Substring search across node names and statements."""
        text = (query or "").strip().lower()
        if not text:
            raise ValidationError("search query must not be empty")
        results: list[dict[str, Any]] = []
        for node in self.index().nodes.values():
            haystack = " ".join(
                [
                    node.name or "",
                    node.id,
                    str(node.props.get("statement") or ""),
                    str(node.props.get("text") or ""),
                    str(node.props.get("role") or ""),
                ]
            ).lower()
            if text in haystack:
                results.append(node.to_view())
        results.sort(key=lambda item: (item["label"], item["id"]))
        return {"query": query, "total": len(results), "results": results[:limit]}

    def history_belief(self, at: str, *, label: Any = "Fact", limit: int = 200) -> dict[str, Any]:
        """What Tripwire believed at a transaction time."""
        nodes = belief_at(self.index(), at, label=label)
        return {
            "at": at,
            "label": label,
            "total": len(nodes),
            "facts": [node.to_view() for node in nodes[:limit]],
        }

    def history_valid(self, at: str, *, subject_id: Optional[str] = None,
                      attribute: Optional[str] = None) -> dict[str, Any]:
        """Which facts were true in the real world at a given instant."""
        nodes = valid_at(self.index(), at, subject_id=subject_id, attribute=attribute)
        return {
            "at": at,
            "subject_id": subject_id,
            "attribute": attribute,
            "total": len(nodes),
            "facts": [node.to_view() for node in nodes],
        }

    def history_dependencies(self, decision_id: str, at: str) -> dict[str, Any]:
        """What a decision depended on at a transaction time."""
        return dependencies_at(self.index(), decision_id, at)

    def history_changes(self, since: str) -> dict[str, Any]:
        """What the system learned after a point in time."""
        return changes_since(self.index(), since)

    def history_fact(self, fact_id: str) -> dict[str, Any]:
        """Full timeline for a fact."""
        return fact_timeline(self.index(), fact_id)

    def history_source_of_change(self, fact_id: str) -> dict[str, Any]:
        """Which source changed the system's understanding of a fact."""
        return source_of_change(self.index(), fact_id)

    # ----------------------------------------------------------- reviews/alerts
    def alerts(self, **kwargs: Any) -> dict[str, Any]:
        """Paginated alert feed."""
        return list_alerts(self.store, **kwargs)

    def get_alert(self, alert_id: str) -> dict[str, Any]:
        """Fetch a single alert."""
        alert = get_alert(self.store, alert_id)
        if alert is None:
            raise NotFoundError(f"alert {alert_id!r} does not exist")
        view = alert.to_view()
        # Advertise the legal next statuses from the documented model so a client
        # renders exactly what the API accepts, plus the current status (a same-status
        # re-review is how a reviewer attaches a note).  Kept identical to the list
        # endpoint so the two views never disagree.
        current = str(alert.props.get("status") or "NEW")
        view["allowed_transitions"] = [current, *ALERT_STATUS_TRANSITIONS.get(current, ())]
        view["affected"] = [
            {
                "entity_id": edge.dst,
                "certainty": edge.props.get("certainty"),
                "reason": edge.props.get("reason"),
            }
            for edge in self.store.get_edges(src=alert_id, rel="AFFECTS")
        ]
        return view

    def review_alert(
        self,
        alert_id: str,
        status: str,
        *,
        actor_id: Optional[str] = None,
        note: str = "",
    ) -> dict[str, Any]:
        """Transition an alert, enforcing the documented status machine."""
        node = transition_alert(
            self.store, alert_id, status, actor_id=actor_id, note=note
        )
        return {
            "alert_id": node.id,
            "status": node.props.get("status"),
            "previous_status": node.props.get("previous_status"),
            "updated_at": node.props.get("updated_at"),
            "reviewed_by": node.props.get("reviewed_by"),
            "review_note": node.props.get("review_note"),
            "affected": [
                {
                    "entity_id": edge.dst,
                    "entity_status": (
                        self.store.get_node(edge.dst).props.get("status")
                        if self.store.get_node(edge.dst)
                        else None
                    ),
                }
                for edge in self.store.get_edges(src=alert_id, rel="AFFECTS")
            ],
        }

    def set_decision_status(
        self,
        decision_id: str,
        status: str,
        *,
        actor_id: Optional[str] = None,
        note: str = "",
        confirm: bool = False,
    ) -> dict[str, Any]:
        """Change a decision's status through an audited, validated path.

        Marking a decision ``STALE`` requires ``confirm=true``: the specification is
        explicit that a decision must not be invalidated automatically, and an
        unconfirmed request is rejected rather than silently treated as a review.
        """
        target = str(status).upper()
        if target not in DECISION_STATUSES:
            raise ValidationError(
                f"unknown decision status {status!r}; expected one of {DECISION_STATUSES}"
            )
        decision = self.store.get_node(decision_id)
        if decision is None or decision.label != "Decision":
            raise NotFoundError(f"decision {decision_id!r} does not exist")
        if target == "STALE" and not confirm:
            raise ValidationError(
                "marking a decision STALE requires explicit confirmation (confirm=true); "
                "Tripwire never invalidates a decision automatically"
            )
        previous = str(decision.props.get("status") or "ACTIVE")
        moment = now_iso()
        updated = self.put_node(
            Node(
                id=decision.id,
                label="Decision",
                name=decision.name,
                props={
                    "status": target,
                    "previous_status": previous,
                    "review_status": "REVIEWED_ACCEPTED",
                    "reviewed_by": actor_id,
                    "review_note": note,
                    "final_status_at": moment,
                    **({"stale_reason": note or decision.props.get("stale_reason") or "Marked stale by review"}
                       if target == "STALE" else {}),
                    **({"stale_since": moment} if target == "STALE" else {}),
                },
            )
        )
        self._event(
            kind="REVIEW_DECISION",
            subject_id=decision.id,
            summary=f"Decision '{decision.name}' moved from {previous} to {target}"
            + (f": {note}" if note else ""),
            moment=moment,
            actor_id=actor_id,
            extra={
                "entity_id": decision.id,
                "from_status": previous,
                "to_status": target,
                "note": note,
            },
        )
        return {
            "decision_id": updated.id,
            "status": updated.props.get("status"),
            "previous_status": previous,
            "reviewed_by": actor_id,
            "at": moment,
        }

    def alert_history(self, alert_id: str) -> dict[str, Any]:
        """Append-only alert history."""
        from .alerts import alert_history as _history

        return _history(self.store, alert_id)

    # ------------------------------------------------------------- ingestion
    def record_event(
        self,
        *,
        kind: str,
        summary: str,
        moment: Optional[str] = None,
        subject_id: Optional[str] = None,
        actor_id: Optional[str] = None,
        extra: Optional[Mapping[str, Any]] = None,
    ) -> Node:
        """Record an ``Event`` node - the documented way for subsystems to log.

        Exposed so the ingestion pipeline (and any future subsystem) writes audit
        events through the engine rather than reaching into its internals.
        """
        return self._event(
            kind=kind,
            summary=summary,
            moment=moment or now_iso(),
            subject_id=subject_id,
            actor_id=actor_id,
            extra=extra,
        )

    def ingest_source(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        """Ingest one source record (Slack message, ticket, PRD or meeting note).

        Delegates to :class:`tripwire.ingest.pipeline.IngestionPipeline`, which uses
        this engine for every write.  The HTTP API and the MCP tools both call this
        method, so there is one ingestion implementation.
        """
        from ..ingest.pipeline import IngestionPipeline  # local import avoids a cycle

        return IngestionPipeline(self).ingest(payload)

    def ingestion_adapters(self) -> list[dict[str, Any]]:
        """Documented catalogue of ingestion adapters and their input shapes."""
        from ..ingest.base import adapter_catalog

        return adapter_catalog()

    def health(self) -> dict[str, Any]:
        """Composite health: store, seeding and LLM availability."""
        store_health = self.store.health()
        return {
            "status": "ok" if store_health.get("ok") else "degraded",
            "store": store_health,
            "configured_backend": self.settings.store_backend,
            "active_backend": self.store.backend,
            "seeded": self.is_seeded(),
            "llm_enabled": self.llm is not None,
            "checked_at": now_iso(),
        }

    def _event(
        self,
        *,
        kind: str,
        summary: str,
        moment: str,
        subject_id: Optional[str] = None,
        actor_id: Optional[str] = None,
        extra: Optional[Mapping[str, Any]] = None,
    ) -> Node:
        """Record an ``Event`` node, idempotently.

        The id excludes the wall-clock instant so replaying an identical event does
        not append a duplicate history entry.
        """
        identifier = make_event_id(kind, subject_id, short_hash(summary))
        node = self.put_node(
            Node(
                id=identifier,
                label="Event",
                name=summary[:140],
                props={
                    "event_type": kind,
                    "summary": summary,
                    "recorded_at": moment,
                    "at": moment,
                    "actor_id": actor_id,
                    "subject_id": subject_id,
                    **{k: v for k, v in (extra or {}).items() if v is not None},
                },
            )
        )
        if subject_id and self.store.get_node(subject_id) is not None:
            self.put_edge(Edge(src=node.id, rel="ABOUT", dst=subject_id, props={"at": moment}))
        return node


# --------------------------------------------------------------------------- #
# Module-level helpers
# --------------------------------------------------------------------------- #
def _open_store(settings: Settings) -> GraphStore:
    """Open the configured store, falling back to JSON when FalkorDB is absent.

    The fallback is loud and visible: it logs a warning and the active backend is
    reported by every health/state response, so a degraded deployment cannot be
    mistaken for a real FalkorDB one (spec S16).
    """
    from .store import create_store

    backend = settings.store_backend
    if backend in ("falkordb", "falkor"):
        try:
            return create_store("falkordb", falkor=settings.falkor_options())
        except TripwireError as exc:
            if not settings.store_fallback:
                raise
            logger.warning(
                "FalkorDB unavailable (%s). Falling back to the JSON store at %s. "
                "The demo works fully offline; set TRIPWIRE_STORE_FALLBACK=false to fail fast.",
                exc.message if hasattr(exc, "message") else exc,
                settings.state_path,
            )
            return create_store("json", path=settings.state_path)
    return create_store(backend, path=settings.state_path, falkor=settings.falkor_options())


_LABEL_HINTS: tuple[tuple[str, str], ...] = (
    ("team", "Team"),
    ("squad", "Team"),
    ("partner", "System"),
    ("system", "System"),
    ("service", "System"),
    ("platform", "System"),
    ("pipeline", "System"),
    ("project", "Project"),
    ("programme", "Project"),
    ("program", "Project"),
    ("decision", "Decision"),
    ("assumption", "Assumption"),
)


def _infer_label(reference: str) -> str:
    """Guess a node label from a free-text reference (conservative default)."""
    lowered = str(reference).lower()
    for needle, label in _LABEL_HINTS:
        if needle in lowered:
            return label
    return "System"


def _ephemeral_fact(candidate: Mapping[str, Any], index: GraphIndex) -> Node:
    """Build a not-yet-persisted ``Fact`` node for hypothetical comparisons.

    Lets ``find_contradictions`` answer "would this claim conflict?" without
    writing anything, so a caller can dry-run a statement before committing it.
    """
    required = [key for key in ("subject", "attribute", "value") if candidate.get(key) is None]
    if required:
        raise ValidationError(f"candidate fact is missing required field(s): {', '.join(required)}")
    subject = str(candidate["subject"])
    subject_node = index.node(subject) or next(
        (
            node
            for node in index.nodes.values()
            if slug(node.name) == slug(subject) or slug(node.id.split(":", 1)[-1]) == slug(subject)
        ),
        None,
    )
    subject_id = subject_node.id if subject_node else f"system:{slug(subject)}"
    valid_from = candidate.get("valid_from")
    return Node(
        id=make_fact_id(subject_id, candidate["attribute"], candidate["value"], valid_from)
        if subject_node
        else "fact:hypothetical:" + short_hash(subject, candidate["attribute"], candidate["value"]),
        label="Fact",
        name=str(candidate.get("statement") or f"{subject}: {candidate['attribute']} = {candidate['value']}"),
        props={
            "subject_id": subject_id,
            "subject_name": subject_node.name if subject_node else subject,
            "attribute": candidate["attribute"],
            "value": candidate["value"],
            "statement": candidate.get("statement") or "",
            "valid_from": valid_from,
            "valid_to": candidate.get("valid_to"),
            "recorded_at": candidate.get("recorded_at") or now_iso(),
            "confidence": float(candidate.get("confidence", 0.9)),
            "verified": bool(candidate.get("verified", True)),
            "status": "ACTIVE",
            "hypothetical": True,
        },
    )


def _contradiction_path(index: GraphIndex, old_fact_id: Optional[str], new_fact_id: str) -> EvidencePath:
    """Render the ``new -CONTRADICTS-> old`` relationship as an evidence path."""
    if not old_fact_id or index.node(old_fact_id) is None:
        return EvidencePath(steps=[])
    return index.walk_path(
        new_fact_id, [Edge(src=new_fact_id, rel="CONTRADICTS", dst=old_fact_id)]
    )
