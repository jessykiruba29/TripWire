"""Common ingestion interface: adapters, source records and extraction contracts.

Requirement (spec S5): *"Provide a common ingestion interface so future source
integrations can be added cleanly."*  An adapter therefore only has to answer two
questions - "what does my input look like?" and "how do I turn it into a
:class:`SourceRecord`?" - while validation, provenance, entity resolution,
de-duplication, confidence handling and event recording are pipeline concerns
shared by every source.

Honesty note
------------
No direct Slack / Jira / Confluence provider integration exists in this
environment, so these adapters parse **documented JSON input shapes** and say so.
They are not pretending to be live provider connectors: :meth:`SourceAdapter.describe`
reports ``integration_type: "file_or_webhook_record"`` for every adapter, and the
pipeline records the adapter actually used on each ingested artifact.

Extraction is deliberately split from storage: an extractor produces *candidate*
claims, never established truth.  Deterministic candidates are marked unverified
and ``NEEDS_REVIEW``; LLM candidates are validated before they are written and are
never promoted to verified by the extractor itself.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional, Sequence

from ..core.errors import IngestionError, ValidationError
from ..core.schema import DOC_TYPES, NODE_TYPES
from ..core.timeutil import iso_or_none

__all__ = [
    "SourceRecord",
    "SourceAdapter",
    "ExtractedClaim",
    "ExtractedEntity",
    "ExtractionResult",
    "KnowledgeExtractor",
    "get_adapter",
    "adapter_catalog",
    "adapter_names",
    "ADAPTER_CATALOG",
    "CLAIM_TYPES",
    "validate_extraction",
]

CLAIM_TYPES = ("fact", "assumption", "decision")


# --------------------------------------------------------------------------- #
# Source records
# --------------------------------------------------------------------------- #
@dataclass
class SourceRecord:
    """A validated, normalised source artifact ready for ingestion."""

    source_system: str
    external_id: str
    label: str
    doc_type: Optional[str]
    text: str
    title: str = ""
    author: Optional[str] = None
    timestamp: Optional[str] = None
    url: Optional[str] = None
    channel: Optional[str] = None
    status: Optional[str] = None
    resolved: Optional[str] = None
    mentions: list[str] = field(default_factory=list)
    participants: list[str] = field(default_factory=list)
    claims: list[dict[str, Any]] = field(default_factory=list)
    confidence: float = 0.8
    metadata: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def source_ref(self) -> str:
        """Human-readable locator recorded on the artifact."""
        if self.source_system == "slack" and self.channel:
            day = (self.timestamp or "")[:10]
            return f"slack:{self.channel}/{day}" if day else f"slack:{self.channel}"
        return f"{self.doc_type or self.source_system}:{self.external_id}"

    def summary(self) -> str:
        """Short description used for the artifact's display name."""
        return (self.title or self.text or self.external_id).strip()[:160]

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form (used in ingestion reports and tests)."""
        return {
            "source_system": self.source_system,
            "external_id": self.external_id,
            "label": self.label,
            "doc_type": self.doc_type,
            "title": self.title,
            "author": self.author,
            "timestamp": self.timestamp,
            "url": self.url,
            "channel": self.channel,
            "status": self.status,
            "resolved": self.resolved,
            "mentions": list(self.mentions),
            "participants": list(self.participants),
            "claims": list(self.claims),
            "confidence": self.confidence,
            "source_ref": self.source_ref,
            "text_length": len(self.text),
        }


class SourceAdapter(ABC):
    """Base class for a source integration."""

    #: Registry key, also accepted as the ``source`` field of a payload.
    name: str = ""
    #: ``source_system`` recorded on the artifact (``slack``, ``jira``, ...).
    source_system: str = ""
    #: Node label produced: ``Message`` for chat, ``Document`` for written records.
    label: str = "Document"
    #: Default ``doc_type`` when the payload does not supply one.
    default_doc_type: Optional[str] = None
    #: One-line description shown by the adapter catalogue.
    description: str = ""
    #: How this adapter actually receives data.  Never claims a live provider link.
    integration_type: str = "file_or_webhook_record"
    #: Documented input shape: field name -> description.
    input_shape: dict[str, str] = {}

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def require(payload: Mapping[str, Any], key: str, *, kind: str = "string") -> Any:
        """Return a required field or raise :class:`IngestionError`."""
        value = payload.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            raise IngestionError(
                f"{key!r} is required", details={"missing_field": key, "adapter": kind}
            )
        return value

    @staticmethod
    def first_text(payload: Mapping[str, Any], *keys: str) -> str:
        """First non-empty text value among ``keys``."""
        for key in keys:
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""

    @staticmethod
    def normalise_timestamp(value: Any) -> Optional[str]:
        """Best-effort ISO-8601 UTC normalisation of a source timestamp."""
        return iso_or_none(value)

    @staticmethod
    def name_list(value: Any) -> list[str]:
        """Coerce a mention/participant field into a clean list of names."""
        if value is None:
            return []
        if isinstance(value, str):
            items = [part.strip() for part in value.replace(";", ",").split(",")]
        elif isinstance(value, (list, tuple, set)):
            items = [str(item).strip() for item in value]
        else:
            return []
        return [item for item in items if item]

    @staticmethod
    def claim_list(value: Any) -> list[dict[str, Any]]:
        """Validate an optional structured ``claims`` list on a record."""
        if value is None:
            return []
        if not isinstance(value, (list, tuple)):
            raise IngestionError("'claims' must be a list of claim objects")
        claims: list[dict[str, Any]] = []
        for index, item in enumerate(value):
            if not isinstance(item, Mapping):
                raise IngestionError(f"claims[{index}] must be an object")
            missing = [k for k in ("subject", "attribute", "value") if item.get(k) is None]
            if missing:
                raise IngestionError(
                    f"claims[{index}] is missing required field(s): {', '.join(missing)}"
                )
            claims.append(dict(item))
        return claims

    # -------------------------------------------------------------------- API
    @abstractmethod
    def to_record(self, payload: Mapping[str, Any]) -> SourceRecord:
        """Validate ``payload`` and normalise it into a :class:`SourceRecord`."""

    def describe(self) -> dict[str, Any]:
        """Catalogue entry describing this adapter and its accepted input."""
        return {
            "name": self.name,
            "source_system": self.source_system,
            "produces_label": self.label,
            "default_doc_type": self.default_doc_type,
            "description": self.description,
            "integration_type": self.integration_type,
            "integration_note": (
                "Accepts a documented JSON record (file upload, webhook payload or API call). "
                "No live provider credential or connector is configured in this build."
            ),
            "input_shape": dict(self.input_shape),
        }


# --------------------------------------------------------------------------- #
# Extraction contracts
# --------------------------------------------------------------------------- #
@dataclass
class ExtractedClaim:
    """A candidate fact, assumption or decision extracted from a source record."""

    claim_type: str
    subject: str
    attribute: str
    value: Any
    statement: str
    subject_label: Optional[str] = None
    confidence: float = 0.6
    verified: bool = False
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    source_span: Optional[str] = None
    pattern: Optional[str] = None
    review_status: str = "NEEDS_REVIEW"
    extra: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form."""
        return {
            "claim_type": self.claim_type,
            "subject": self.subject,
            "subject_label": self.subject_label,
            "attribute": self.attribute,
            "value": self.value,
            "statement": self.statement,
            "confidence": self.confidence,
            "verified": self.verified,
            "valid_from": self.valid_from,
            "valid_to": self.valid_to,
            "source_span": self.source_span,
            "pattern": self.pattern,
            "review_status": self.review_status,
            "extra": dict(self.extra),
        }


@dataclass
class ExtractedEntity:
    """An entity referenced by a record."""

    name: str
    label: Optional[str] = None
    confidence: float = 0.6
    role: Optional[str] = None
    created: bool = False

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form."""
        return {
            "name": self.name,
            "label": self.label,
            "confidence": self.confidence,
            "role": self.role,
            "created": self.created,
        }


@dataclass
class ExtractionResult:
    """Everything an extractor produced for one source record."""

    extractor: str
    llm_used: bool = False
    llm_failed: bool = False
    entities: list[ExtractedEntity] = field(default_factory=list)
    facts: list[ExtractedClaim] = field(default_factory=list)
    assumptions: list[ExtractedClaim] = field(default_factory=list)
    decisions: list[ExtractedClaim] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def claim_count(self) -> int:
        """Total candidate claims of every type."""
        return len(self.facts) + len(self.assumptions) + len(self.decisions)

    @property
    def needs_review_count(self) -> int:
        """Claims flagged for human review."""
        return len(
            [
                claim
                for claim in (*self.facts, *self.assumptions, *self.decisions)
                if claim.review_status == "NEEDS_REVIEW"
            ]
        )

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form."""
        return {
            "extractor": self.extractor,
            "llm_used": self.llm_used,
            "llm_failed": self.llm_failed,
            "warnings": list(self.warnings),
            "counts": {
                "entities": len(self.entities),
                "facts": len(self.facts),
                "assumptions": len(self.assumptions),
                "decisions": len(self.decisions),
                "needs_review": self.needs_review_count,
            },
            "entities": [entity.as_dict() for entity in self.entities],
            "facts": [claim.as_dict() for claim in self.facts],
            "assumptions": [claim.as_dict() for claim in self.assumptions],
            "decisions": [claim.as_dict() for claim in self.decisions],
        }


class KnowledgeExtractor(ABC):
    """Turns a :class:`SourceRecord` into candidate knowledge."""

    name: str = "extractor"

    @abstractmethod
    def extract(self, record: SourceRecord) -> ExtractionResult:
        """Extract candidate claims and entities from ``record``."""


# --------------------------------------------------------------------------- #
# Extraction validation (shared by the deterministic and LLM paths)
# --------------------------------------------------------------------------- #
def validate_extraction(payload: Mapping[str, Any], *, extractor: str) -> ExtractionResult:
    """Validate a raw extraction payload into an :class:`ExtractionResult`.

    Used for LLM output before anything is written to the graph (spec S5: *"Validate
    its output before writing it to the graph"*) and for the deterministic
    structured-claims path, so both obey identical rules.

    Raises
    ------
    IngestionError
        When the payload is structurally invalid.  The LLM path converts this into
        a structured extraction failure rather than writing partial truth.
    """
    if not isinstance(payload, Mapping):
        raise IngestionError("extraction payload must be an object")

    result = ExtractionResult(extractor=extractor)
    result.llm_used = bool(payload.get("llm_used", False))

    for index, raw_entity in enumerate(payload.get("entities") or []):
        if not isinstance(raw_entity, Mapping) or not str(raw_entity.get("name") or "").strip():
            raise IngestionError(f"entities[{index}] requires a non-empty 'name'")
        label = raw_entity.get("label")
        if label is not None and label not in NODE_TYPES:
            raise IngestionError(
                f"entities[{index}] has unknown label {label!r}; expected one of {NODE_TYPES}"
            )
        result.entities.append(
            ExtractedEntity(
                name=str(raw_entity["name"]).strip(),
                label=label,
                confidence=_bounded(raw_entity.get("confidence"), default=0.6),
                role=raw_entity.get("role"),
            )
        )

    for group, claim_type in (
        ("facts", "fact"),
        ("assumptions", "assumption"),
        ("decisions", "decision"),
    ):
        bucket: list[ExtractedClaim] = getattr(result, group)
        for index, raw_claim in enumerate(payload.get(group) or []):
            if not isinstance(raw_claim, Mapping):
                raise IngestionError(f"{group}[{index}] must be an object")
            statement = str(raw_claim.get("statement") or "").strip()
            subject = str(raw_claim.get("subject") or "").strip()
            attribute = str(raw_claim.get("attribute") or "").strip()
            value = raw_claim.get("value")
            if claim_type == "fact":
                missing = [
                    name
                    for name, present in (
                        ("subject", subject),
                        ("attribute", attribute),
                        ("value", value is not None and str(value) != ""),
                    )
                    if not present
                ]
                if missing:
                    raise IngestionError(
                        f"{group}[{index}] is missing required field(s): {', '.join(missing)}"
                    )
            elif not statement:
                raise IngestionError(f"{group}[{index}] requires a non-empty 'statement'")

            label = raw_claim.get("subject_label")
            if label is not None and label not in NODE_TYPES:
                raise IngestionError(f"{group}[{index}] has unknown subject_label {label!r}")
            confidence = _bounded(raw_claim.get("confidence"), default=0.6)
            verified = bool(raw_claim.get("verified", False))
            bucket.append(
                ExtractedClaim(
                    claim_type=claim_type,
                    subject=subject,
                    subject_label=label,
                    attribute=attribute,
                    value=value,
                    statement=statement,
                    confidence=confidence,
                    verified=verified,
                    valid_from=iso_or_none(raw_claim.get("valid_from")),
                    valid_to=iso_or_none(raw_claim.get("valid_to")),
                    source_span=raw_claim.get("source_span"),
                    pattern=raw_claim.get("pattern"),
                    review_status=(
                        "AUTO_ACCEPTED" if verified else "NEEDS_REVIEW"
                    ),
                    extra=dict(raw_claim.get("extra") or {}),
                )
            )
    return result


def _bounded(value: Any, *, default: float) -> float:
    """Clamp a confidence value into ``[0, 1]``."""
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #
def _build_registry() -> dict[str, SourceAdapter]:
    """Instantiate every bundled adapter (imported lazily to avoid cycles)."""
    from .adapters.meeting_notes import MeetingNotesAdapter
    from .adapters.prd import PrdAdapter
    from .adapters.slack import SlackAdapter
    from .adapters.tickets import TicketAdapter

    adapters: Iterable[SourceAdapter] = (
        SlackAdapter(),
        TicketAdapter(),
        PrdAdapter(),
        MeetingNotesAdapter(),
    )
    return {adapter.name: adapter for adapter in adapters}


_REGISTRY: Optional[dict[str, SourceAdapter]] = None


def registry() -> dict[str, SourceAdapter]:
    """All registered adapters keyed by name (built once, lazily)."""
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = _build_registry()
    return _REGISTRY


def adapter_names() -> list[str]:
    """Registered adapter names, sorted."""
    return sorted(registry())


def get_adapter(name: str) -> SourceAdapter:
    """Fetch an adapter by name, with aliases for common spellings."""
    key = str(name or "").strip().lower()
    aliases = {
        "message": "slack",
        "chat": "slack",
        "jira": "ticket",
        "tickets": "ticket",
        "issue": "ticket",
        "requirements": "prd",
        "meeting": "meeting_note",
        "meeting_notes": "meeting_note",
        "notes": "meeting_note",
    }
    resolved = aliases.get(key, key)
    registry_map = registry()
    if resolved not in registry_map:
        raise ValidationError(
            f"unknown ingestion source {name!r}; available adapters: {', '.join(adapter_names())}",
            details={"available": adapter_names()},
        )
    return registry_map[resolved]


def adapter_catalog() -> list[dict[str, Any]]:
    """Documented catalogue of every adapter and the input shape it accepts.

    This is the function the HTTP layer reads to build ``GET /api/ingest/adapters``.
    """
    return [registry()[name].describe() for name in adapter_names()]


def __getattr__(name: str) -> Any:
    """Lazily expose ``ADAPTER_CATALOG`` as a module attribute (PEP 562).

    Built on first access rather than at import time: the adapters import this
    module, so eagerly constructing the catalog here would create an import cycle.
    """
    if name in ("ADAPTER_CATALOG", "ADAPTERS", "ADAPTER_SPECS"):
        return adapter_catalog()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def detect_adapter(payload: Mapping[str, Any]) -> Optional[str]:
    """Infer the adapter name from a payload's own fields.

    Checks explicit ``source``/``kind``/``source_system``/``doc_type`` markers, then
    falls back to structural hints (a ``channel`` means chat, a ``status`` with a
    ticket key means a ticket, and so on).
    """
    for key in ("source", "adapter", "source_system", "source_kind", "kind", "doc_type"):
        value = payload.get(key)
        if isinstance(value, str):
            candidate = value.strip().lower()
            if candidate in registry() or candidate in {
                "message", "chat", "jira", "tickets", "issue", "requirements",
                "meeting", "meeting_notes", "notes",
            }:
                return candidate
    if isinstance(payload.get("channel"), str):
        return "slack"
    if isinstance(payload.get("participants"), (list, tuple)):
        return "meeting_note"
    if payload.get("sections") or payload.get("requirements"):
        return "prd"
    if payload.get("resolution") or payload.get("assignee"):
        return "ticket"
    return None


def raw_json(payload: Mapping[str, Any]) -> str:
    """Stable JSON rendering used when storing the original source record."""
    return json.dumps(payload, sort_keys=True, default=str)


def claim_type_order() -> Sequence[str]:
    """Documented claim types in processing order."""
    return CLAIM_TYPES
