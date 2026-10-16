"""The ingestion pipeline: one path from a raw source record to graph knowledge.

For every source record the pipeline performs the ten steps the specification
requires (spec S5):

1. validate the input (adapter),
2. store the original source or a faithful source record (raw payload retained),
3. preserve source id, timestamp, author and metadata,
4. extract candidate facts / assumptions / decisions / entities,
5. link extracted items to their source,
6. resolve entities against existing graph records,
7. detect possible duplicates,
8. store confidence and review status for uncertain extractions,
9. record ingestion events and errors,
10. make the result searchable and traceable (provenance edges + report).

What the pipeline deliberately does **not** do
---------------------------------------------
It does not invent relationships.  An extracted decision or assumption becomes a
node marked ``NEEDS_REVIEW`` with a ``MENTIONS`` edge from its source; the pipeline
does not fabricate ``ASSUMES``/``SUPPORTED_BY``/``IMPACTS`` links between them,
because a guessed dependency would corrupt the very reasoning Tripwire exists to
perform.  Dependency edges come from curated data or from an explicit structured
claim that states them.

Everything the deterministic path writes is unverified and flagged for review;
nothing arrives in the graph as established truth.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

from ..core.errors import IngestionError, LLMResponseError, TripwireError
from ..core.ids import decision_id as make_decision_id
from ..core.ids import short_hash, slug
from ..core.ids import assumption_id as make_assumption_id
from ..core.models import Edge, Node
from ..core.schema import NODE_TYPES
from .base import (
    ExtractionResult,
    KnowledgeExtractor,
    SourceRecord,
    adapter_names,
    detect_adapter,
    get_adapter,
)
from .deterministic import DeterministicExtractor

logger = logging.getLogger("tripwire.ingest")

__all__ = ["IngestionPipeline", "normalise_payload"]

#: Entity labels that are safe to create from an extraction.  Event/Alert/Fact/
#: Message/Document are never created as "entities" from text.
_CREATABLE_ENTITY_LABELS = ("Person", "Team", "System", "Project", "Decision", "Assumption")


def normalise_payload(payload: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """Split an ingest request into ``(adapter_name, record_payload)``.

    Accepts the API's canonical ``{"source": "slack", "record": {...}}`` shape and
    also a flat record that names its own source, so a webhook body can be posted
    unchanged.
    """
    if not isinstance(payload, Mapping):
        raise IngestionError("ingest payload must be a JSON object")

    record = payload.get("record")
    if isinstance(record, Mapping):
        nested_source = payload.get("source") or payload.get("adapter") or payload.get("kind")
        merged = dict(record)
        if nested_source and not any(
            merged.get(key) for key in ("source", "adapter", "source_system", "kind")
        ):
            merged["source"] = nested_source
        name = str(nested_source).strip() if nested_source else None
    else:
        merged = {k: v for k, v in payload.items() if k not in ("source", "adapter", "record")}
        name = payload.get("source") or payload.get("adapter") or payload.get("source_system")
        if payload.get("kind") and not merged.get("kind"):
            merged["kind"] = payload.get("kind")

    resolved = str(name).strip() if name else detect_adapter(merged)
    if not resolved:
        raise IngestionError(
            "cannot determine the source adapter: provide 'source' (or a 'channel'/"
            "'participants'/'resolution' field so it can be inferred)",
            details={"adapters": adapter_names()},
        )
    return resolved, merged


@dataclass
class _Counters:
    """Mutable counters collected while ingesting one record."""

    entities_resolved: int = 0
    entities_created: int = 0
    mentions_linked: int = 0
    facts_created: int = 0
    facts_duplicate: int = 0
    assumptions_created: int = 0
    decisions_created: int = 0
    claims_rejected: int = 0

    def as_dict(self) -> dict[str, int]:
        """Serialisable counters."""
        return {
            "entities_resolved": self.entities_resolved,
            "entities_created": self.entities_created,
            "mentions_linked": self.mentions_linked,
            "facts_created": self.facts_created,
            "facts_duplicate": self.facts_duplicate,
            "assumptions_created": self.assumptions_created,
            "decisions_created": self.decisions_created,
            "claims_rejected": self.claims_rejected,
        }


class IngestionPipeline:
    """Ingests source records into the graph through the shared engine."""

    def __init__(self, engine: Any) -> None:
        """
        Parameters
        ----------
        engine:
            A :class:`tripwire.core.engine.GraphEngine`.  The pipeline never touches
            the store directly; every write goes through the engine so there is one
            write path with one set of de-duplication rules.
        """
        self.engine = engine

    # ------------------------------------------------------------------ public
    def ingest(self, payload: Mapping[str, Any], *, extractor: Optional[KnowledgeExtractor] = None) -> dict[str, Any]:
        """Validate, extract, resolve and store one source record.

        Returns a report describing exactly what was created, what was recognised
        as a duplicate, which extractor ran and what needs review.
        """
        adapter_name, record_payload = normalise_payload(payload)

        try:
            adapter = get_adapter(adapter_name)
            record = adapter.to_record(record_payload)
        except IngestionError as exc:
            self._record_error(exc, adapter_name=adapter_name, payload=payload)
            raise

        report = self._ingest_record(record, adapter_name, adapter_label=adapter.label)
        return report

    # ------------------------------------------------------------------ internals
    def _ingest_record(
        self, record: SourceRecord, adapter_name: str, *, adapter_label: Optional[str] = None
    ) -> dict[str, Any]:
        """Perform the ingestion steps for a validated record."""
        counters = _Counters()
        warnings: list[str] = []

        # Step 2/3/7: store a faithful source record; detect a re-ingest.
        existing_source = self.engine.store.get_node(self._source_node_id(record, adapter_name))
        source = self.engine.ensure_source(
            kind=record.source_system if adapter_name == "slack" else adapter_name,
            external_id=record.external_id,
            name=record.summary(),
            author=record.author,
            timestamp=record.timestamp,
            source_ref=record.source_ref,
            doc_type=record.doc_type,
            text=record.text,
            url=record.url,
            channel=record.channel,
            status=record.status,
            confidence=record.confidence,
            raw_payload=record.raw,
            adapter=adapter_name,
            adapter_integration_type="file_or_webhook_record",
        )
        duplicate_source = existing_source is not None

        # Step 4: extraction (LLM when configured, deterministic otherwise).
        index = self.engine.index()
        result, used_fallback = self._extract(record, index)

        # Step 6: resolve declared/resolved people first so edges can be attached.
        if record.resolved:
            resolver = self.engine.ensure_entity(record.resolved, label="Person")
            self.engine.put_edge(
                Edge(
                    src=resolver.id,
                    rel="RESOLVED",
                    dst=source.id,
                    props={"at": record.timestamp, "status": record.status, "adapter": adapter_name},
                )
            )
            self.engine.put_edge(
                Edge(src=resolver.id, rel="MENTIONS", dst=source.id, props={"at": record.timestamp, "role": "resolver"})
            )
            counters.mentions_linked += 2

        for participant in record.participants:
            person = self.engine.ensure_entity(participant, label="Person")
            self.engine.put_edge(
                Edge(src=person.id, rel="MENTIONS", dst=source.id, props={"at": record.timestamp, "role": "participant"})
            )
            counters.mentions_linked += 1

        # Steps 5/6/7: entity resolution plus MENTIONS provenance.
        for entity in result.entities:
            if entity.label and entity.label not in _CREATABLE_ENTITY_LABELS:
                continue
            node, created = self._resolve_entity(entity.name, entity.label, index)
            counters.entities_created += int(created)
            counters.entities_resolved += int(not created)
            self.engine.put_edge(
                Edge(
                    src=source.id,
                    rel="MENTIONS",
                    dst=node.id,
                    props={
                        "at": record.timestamp,
                        "adapter": adapter_name,
                        "extractor": result.extractor,
                        "confidence": entity.confidence,
                    },
                )
            )
            counters.mentions_linked += 1

        # Step 8: facts (candidate truth) with confidence and review status.
        fact_views: list[dict[str, Any]] = []
        for claim in result.facts:
            try:
                assertion = self.engine.assert_fact(
                    subject=claim.subject,
                    subject_label=claim.subject_label,
                    attribute=claim.attribute,
                    value=claim.value,
                    statement=claim.statement,
                    source={
                        "kind": record.source_system if adapter_name == "slack" else adapter_name,
                        "external_id": record.external_id,
                        "name": record.summary(),
                        "author": record.author,
                        "timestamp": record.timestamp,
                        "source_ref": record.source_ref,
                        "doc_type": record.doc_type,
                        "text": record.text,
                        "url": record.url,
                        "channel": record.channel,
                        "confidence": record.confidence,
                    },
                    valid_from=claim.valid_from,
                    valid_to=claim.valid_to,
                    recorded_at=claim.valid_from or record.timestamp,
                    confidence=claim.confidence,
                    verified=claim.verified,
                    status="ACTIVE",
                    extra={
                        "extraction": result.extractor,
                        "extraction_pattern": claim.pattern,
                        "source_span": claim.source_span,
                        "adapter": adapter_name,
                    },
                )
            except TripwireError as exc:
                counters.claims_rejected += 1
                warnings.append(
                    f"Claim '{claim.subject}: {claim.attribute}' was rejected during ingestion: {exc.message}"
                )
                continue
            counters.facts_created += int(assertion.created)
            counters.facts_duplicate += int(not assertion.created)
            fact_views.append(
                {
                    "fact_id": assertion.fact_id,
                    "created": assertion.created,
                    "attribute": claim.attribute,
                    "value": claim.value,
                    "verified": claim.verified,
                    "confidence": claim.confidence,
                    "review_status": claim.review_status,
                    "pattern": claim.pattern,
                }
            )

        # Step 3/8: assumptions and decisions are recorded as reviewable candidates.
        assumption_views = self._record_claims(result, source, record, "assumption", counters)
        decision_views = self._record_claims(result, source, record, "decision", counters)

        # Step 9: the ingestion event (searchable audit trail).
        event = self.engine.record_event(
            kind="INGESTION",
            summary=(
                f"Ingested {adapter_name} record {record.external_id} via the "
                f"{result.extractor} extractor: {counters.facts_created} new fact(s), "
                f"{counters.facts_duplicate} duplicate(s)"
                + (f", {len(warnings)} rejected" if warnings else "")
            ),
            moment=record.timestamp,
            subject_id=source.id,
            actor_id=source.props.get("author_id"),
            extra={
                "adapter": adapter_name,
                "extractor": result.extractor,
                "llm_used": result.llm_used,
                "llm_failed": result.llm_failed,
                "duplicate_source": duplicate_source,
                "counts": counters.as_dict(),
                "warnings": warnings,
            },
        )

        return {
            "source": {
                "id": source.id,
                "label": source.label,
                "doc_type": source.props.get("doc_type"),
                "external_id": record.external_id,
                "source_ref": record.source_ref,
                "adapter": adapter_name,
                "adapter_integration_type": "file_or_webhook_record",
                "timestamp": record.timestamp,
                "author_id": source.props.get("author_id"),
                "title": source.name,
                "duplicate_source": duplicate_source,
            },
            "extractor": {
                "name": result.extractor,
                "llm_used": result.llm_used,
                "llm_failed": result.llm_failed,
                "deterministic_fallback": used_fallback,
                "warnings": [*result.warnings, *warnings],
            },
            "counts": {
                **counters.as_dict(),
                "needs_review": result.needs_review_count,
                "claims_extracted": result.claim_count,
            },
            "facts": fact_views,
            "assumptions": assumption_views,
            "decisions": decision_views,
            "entities": [entity.as_dict() for entity in result.entities],
            "events": {"ingestion_event_id": event.id, "error_event_id": None},
            "traceability": {
                "provenance_edges": ["AUTHORED", "MENTIONS", "STATES", "RESOLVED"],
                "graph_queries": [
                    f"GET /api/sources/{source.id}",
                    f"GET /api/graph?around={source.id}&depth=1",
                ],
            },
        }

    # ----------------------------------------------------------------- helpers
    def _extract(self, record: SourceRecord, index: Any) -> tuple[ExtractionResult, bool]:
        """Run the configured extractor, falling back deterministically.

        The LLM is optional by design: any failure degrades to the offline
        extractor and is reported, so ingestion never fails because an external
        service is unavailable (spec S16).
        """
        gazetteer = self._gazetteer(index)
        deterministic = DeterministicExtractor(gazetteer)
        llm = getattr(self.engine, "llm", None)
        if llm is None:
            return deterministic.extract(record), False

        from .llm_extractor import LLMExtractor

        try:
            extractor = LLMExtractor(llm, known_entities=sorted(gazetteer))
            return extractor.extract(record), False
        except (LLMResponseError, TripwireError) as exc:
            logger.warning(
                "LLM extraction failed for %s (%s); falling back to the deterministic extractor",
                record.external_id,
                exc,
            )
            fallback = deterministic.extract(record)
            fallback.llm_failed = True
            fallback.warnings.insert(
                0,
                f"LLM extraction failed ({type(exc).__name__}); the deterministic offline "
                "extractor was used instead. No unvalidated LLM output was written.",
            )
            return fallback, True

    @staticmethod
    def _gazetteer(index: Any) -> dict[str, tuple[str, str]]:
        """``{slug(name): (name, label)}`` for graph entities usable as anchors."""
        gazetteer: dict[str, tuple[str, str]] = {}
        for node in index.nodes.values():
            if node.label not in _CREATABLE_ENTITY_LABELS:
                continue
            gazetteer[slug(node.name)] = (node.name, node.label)
        return gazetteer

    def _resolve_entity(
        self, name: str, label: Optional[str], index: Any
    ) -> tuple[Node, bool]:
        """Resolve ``name`` to an existing node, or create one deterministically.

        Returns ``(node, created)``.  De-duplication is delegated to the engine's
        resolution rules (exact id, then slug match) so re-ingesting the same text
        links to the existing entity instead of creating a near-duplicate.
        """
        wanted = slug(name)
        for node in index.nodes.values():
            if node.label == (label or node.label) and (
                slug(node.name) == wanted or slug(node.id.split(":", 1)[-1]) == wanted
            ):
                return node, False
        created = self.engine.ensure_entity(name, label=label)
        return created, True

    def _record_claims(
        self,
        result: ExtractionResult,
        source: Node,
        record: SourceRecord,
        kind: str,
        counters: _Counters,
    ) -> list[dict[str, Any]]:
        """Record extracted assumptions/decisions as reviewable, unlinked candidates."""
        claims = result.assumptions if kind == "assumption" else result.decisions
        views: list[dict[str, Any]] = []
        for claim in claims:
            identifier = (
                make_assumption_id(f"ingested-{short_hash(claim.statement)}")
                if kind == "assumption"
                else make_decision_id(f"ingested-{short_hash(claim.statement)}")
            )
            existing = self.engine.store.get_node(identifier)
            node = self.engine.put_node(
                Node(
                    id=identifier,
                    label="Assumption" if kind == "assumption" else "Decision",
                    name=claim.statement[:160] or f"Ingested {kind}",
                    props={
                        "statement": claim.statement,
                        "status": "ACTIVE",
                        "review_status": "NEEDS_REVIEW",
                        "confidence": claim.confidence,
                        "verified": False,
                        "extraction": result.extractor,
                        "extraction_pattern": claim.pattern,
                        "source_span": claim.source_span,
                        "source_id": source.id,
                        "source_ref": record.source_ref,
                        "recorded_at": claim.valid_from or record.timestamp,
                        "created_at": record.timestamp,
                        "ingested": True,
                        "adapter": source.props.get("adapter"),
                    },
                )
            )
            self.engine.put_edge(
                Edge(
                    src=source.id,
                    rel="MENTIONS",
                    dst=node.id,
                    props={"at": record.timestamp, "extractor": result.extractor},
                )
            )
            if existing is None:
                if kind == "assumption":
                    counters.assumptions_created += 1
                else:
                    counters.decisions_created += 1
            views.append(
                {
                    "id": node.id,
                    "kind": kind,
                    "created": existing is None,
                    "statement": claim.statement,
                    "confidence": claim.confidence,
                    "review_status": "NEEDS_REVIEW",
                    "pattern": claim.pattern,
                    "note": (
                        "Recorded as a reviewable candidate. It is deliberately NOT wired "
                        "into the dependency graph: assuming a dependency from prose would "
                        "fabricate the reasoning Tripwire is meant to verify."
                    ),
                }
            )
        return views

    @staticmethod
    def _source_node_id(record: SourceRecord, adapter_name: str) -> str:
        """Deterministic id of the source node this record maps to."""
        from ..core.ids import document_id, message_id

        if adapter_name == "slack":
            return message_id("slack", record.external_id)
        return document_id(adapter_name, record.external_id)

    def _record_error(
        self, exc: TripwireError, *, adapter_name: Optional[str], payload: Mapping[str, Any]
    ) -> None:
        """Record a failed ingestion as an ``ERROR`` event (best effort)."""
        try:
            self.engine.record_event(
                kind="ERROR",
                summary=f"Ingestion rejected for {adapter_name or 'unknown source'}: {exc.message}",
                extra={
                    "adapter": adapter_name,
                    "error_code": getattr(exc, "code", "ingestion_error"),
                    "details": dict(getattr(exc, "details", {}) or {}),
                    "payload_keys": sorted(payload.keys()),
                },
            )
        except Exception:  # noqa: BLE001 - never mask the original validation error
            logger.debug("could not record ingestion error event", exc_info=True)
