"""Deterministic, offline knowledge extraction.

This is the extractor that makes the demo work with **no external AI credentials**
(spec S3): entity linking plus a small, documented set of high-precision claim
patterns.

Honesty about its limits
------------------------
Rule-based extraction is narrow by construction.  Everything it produces is:

* marked ``verified=False`` and ``review_status=NEEDS_REVIEW`` - a candidate, never
  established truth (spec S5/S6);
* tagged with the pattern that produced it and the exact ``source_span`` sentence,
  so a reviewer can see why it was proposed;
* restricted to claims anchored to a **known entity name**, which suppresses the
  garbage that naive keyword matching would otherwise emit.

Structured ``claims`` supplied on a record are handled separately: they are the
source's own explicit assertion, so they keep the confidence and ``verified`` flag
the record declares rather than being blanket-downgraded.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Optional, Sequence

from ..core.schema import NODE_TYPES
from .base import (
    ExtractedClaim,
    ExtractedEntity,
    ExtractionResult,
    KnowledgeExtractor,
    SourceRecord,
    validate_extraction,
)

__all__ = ["DeterministicExtractor", "PATTERNS", "Statements"]

#: Confidence assigned to a pattern-matched claim.  Deliberately below the
#: verified floor (0.6 by default) so such a claim can never be treated as an
#: established fact and can never produce a "verifiable" contradiction on its own.
PATTERN_CONFIDENCE = 0.55

_COMPLIANCE_NOUNS = ("compliance", "certification", "certificate", "licence", "license", "attestation")
_NEGATIVE_STATUS = (
    "revoked", "revoke", "suspended", "suspend", "expired", "expire", "withdrawn",
    "withdraw", "cancelled", "canceled", "lost", "invalid", "lapsed", "terminated",
)
_POSITIVE_STATUS = (
    "valid", "current", "active", "renewed", "in force", "granted", "certified", "compliant",
)
_REGION_TOKEN = re.compile(r"\b([a-z]{2}-[a-z]+-\d|eu-central|us-east|ap-southeast)\b", re.I)
_DATE_TOKEN = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
_DECISION_MARKERS = (
    "decision recorded", "we decided", "decided to", "approved the", "signed off",
    "go/no-go", "we will proceed", "proceed with",
)
_ASSUMPTION_MARKERS = (
    "assuming", "assumes", "as long as", "depends on", "dependent on", "gated on",
    "conditional on", "contingent on", "provided that", "relies on", "rests on",
)

#: Documented pattern names, surfaced on every extracted claim for auditability.
PATTERNS: tuple[str, ...] = (
    "structured_claim",
    "negative_compliance_status",
    "affirmative_compliance_status",
    "region_statement",
    "target_date_statement",
    "explicit_decision_marker",
    "explicit_assumption_marker",
)

_ATTRIBUTE_FOR_NOUN = {
    "compliance": "compliance_status",
    "certification": "certification_status",
    "certificate": "certification_status",
    "licence": "license_status",
    "license": "license_status",
    "attestation": "certification_status",
}


@dataclass
class Statements:
    """Sentence-level view of a source record, kept for span reporting."""

    sentences: list[str]

    @classmethod
    def from_text(cls, text: str, *, limit: int = 400) -> "Statements":
        """Split text into sentence-ish spans (bounded for safety)."""
        parts = [part.strip() for part in _SENTENCE_SPLIT.split(text or "") if part.strip()]
        return cls(sentences=parts[:limit])


class DeterministicExtractor(KnowledgeExtractor):
    """Offline extraction: gazetteer entity linking plus claim patterns."""

    name = "deterministic"

    def __init__(self, gazetteer: Optional[Mapping[str, tuple[str, str]]] = None) -> None:
        """
        Parameters
        ----------
        gazetteer:
            ``{slugified entity name: (canonical name, label)}`` for entities already
            in the graph.  Used to anchor mention linking and claim extraction to
            real nodes instead of guessing.
        """
        self.gazetteer: dict[str, tuple[str, str]] = dict(gazetteer or {})
        self._ordered_names: list[tuple[str, str, str, str]] = sorted(
            (
                (name, label, slug_key, name.lower())
                for slug_key, (name, label) in self.gazetteer.items()
            ),
            key=lambda item: -len(item[0]),
        )

    # ------------------------------------------------------------ entity work
    def _linked_entities(self, text: str) -> list[ExtractedEntity]:
        """Known entities whose name appears in ``text`` (longest match first)."""
        lowered = (text or "").lower()
        found: dict[str, ExtractedEntity] = {}
        for name, label, _key, lower_name in self._ordered_names:
            if lower_name and lower_name in lowered:
                found.setdefault(name, ExtractedEntity(name=name, label=label, confidence=0.85))
        return sorted(found.values(), key=lambda entity: (-entity.confidence, entity.name))

    # -------------------------------------------------------------- extraction
    def extract(self, record: SourceRecord) -> ExtractionResult:
        """Extract candidate entities and claims from ``record``."""
        payload: dict[str, Any] = {
            "entities": [],
            "facts": [],
            "assumptions": [],
            "decisions": [],
            "llm_used": False,
        }

        # 1. declared entities: mentions, participants, resolver and author.
        declared: dict[str, str | None] = {}
        for name in record.mentions:
            declared.setdefault(name, None)
        for name in record.participants:
            declared.setdefault(name, "Person")
        for name in (record.resolved, record.author):
            if name:
                declared.setdefault(name, "Person")

        # 2. entities discovered by gazetteer in the text.
        for entity in self._linked_entities(record.text):
            declared.setdefault(entity.name, entity.label)

        payload["entities"] = [
            {"name": name, "label": label or self._guess_label(name), "confidence": 0.8}
            for name, label in sorted(declared.items())
        ]

        # 3. explicit structured claims: the source's own assertion.
        for claim in record.claims:
            payload["facts"].append(
                {
                    "subject": claim["subject"],
                    "subject_label": claim.get("subject_label"),
                    "attribute": claim["attribute"],
                    "value": claim["value"],
                    "statement": claim.get("statement")
                    or f"{claim['subject']}: {claim['attribute']} = {claim['value']}",
                    "confidence": claim.get("confidence", record.confidence),
                    "verified": bool(claim.get("verified", False)),
                    "valid_from": claim.get("valid_from"),
                    "valid_to": claim.get("valid_to"),
                    "pattern": "structured_claim",
                    "extra": {"declared_on_record": record.external_id},
                }
            )

        # 4. explicit decisions / assumptions declared on the record.
        for claim in self._declared(record, "decisions"):
            payload["decisions"].append(claim)
        for claim in self._declared(record, "assumptions"):
            payload["assumptions"].append(claim)

        # 5. pattern extraction over the text.
        text_facts, text_decisions, text_assumptions = self._patterns(record)
        payload["facts"].extend(text_facts)
        payload["decisions"].extend(text_decisions)
        payload["assumptions"].extend(text_assumptions)

        result = validate_extraction(payload, extractor=self.name)
        result.llm_used = False
        result.warnings.extend(self._warnings(record, result))

        # De-duplicate claims that several patterns may have produced.
        result.facts = _dedupe_claims(result.facts)
        result.decisions = _dedupe_claims(result.decisions)
        result.assumptions = _dedupe_claims(result.assumptions)
        return result

    # ----------------------------------------------------------------- helpers
    def _declared(self, record: SourceRecord, key: str) -> list[dict[str, Any]]:
        """Read an optional ``decisions``/``assumptions`` list off the raw payload."""
        raw = record.raw.get(key)
        if not isinstance(raw, (list, tuple)):
            return []
        out: list[dict[str, Any]] = []
        for index, item in enumerate(raw):
            if isinstance(item, str):
                out.append({"subject": "", "attribute": "unspecified", "value": "", "statement": item,
                            "confidence": record.confidence, "verified": False, "pattern": "structured_claim"})
            elif isinstance(item, Mapping) and item.get("statement"):
                out.append(
                    {
                        "subject": str(item.get("subject") or ""),
                        "attribute": str(item.get("attribute") or "unspecified"),
                        "value": item.get("value") or "",
                        "statement": str(item["statement"]),
                        "confidence": item.get("confidence", record.confidence),
                        "verified": bool(item.get("verified", False)),
                        "pattern": "structured_claim",
                        "extra": {"declared_on_record": record.external_id, "index": index},
                    }
                )
        return out

    def _patterns(
        self, record: SourceRecord
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        """Apply the documented claim patterns to each sentence."""
        facts: list[dict[str, Any]] = []
        decisions: list[dict[str, Any]] = []
        assumptions: list[dict[str, Any]] = []
        statements = Statements.from_text(record.text)
        for sentence in statements.sentences:
            lowered = sentence.lower()
            entities = self._linked_entities(sentence)
            if not entities:
                # Patterns are anchored to known entities by design: an unanchored
                # match has no resolvable subject, so it is skipped rather than
                # guessed.
                continue
            primary = entities[0]

            # non-functional attribute families that conflict with a *different*
            # subject's claim are worthless, hence the single-entity requirement.
            if len(entities) == 1:
                attribute = self._compliance_attribute(lowered)
                if attribute:
                    negative = next((term for term in _NEGATIVE_STATUS if term in lowered), None)
                    positive = next((term for term in _POSITIVE_STATUS if term in lowered), None)
                    if negative:
                        facts.append(
                            _fact(
                                primary,
                                attribute,
                                negative,
                                sentence,
                                "negative_compliance_status",
                                record,
                            )
                        )
                    elif positive:
                        facts.append(
                            _fact(
                                primary,
                                attribute,
                                positive,
                                sentence,
                                "affirmative_compliance_status",
                                record,
                            )
                        )

                region = _REGION_TOKEN.search(sentence)
                if region and ("region" in lowered or "hosted" in lowered or "stored" in lowered):
                    facts.append(
                        _fact(primary, "hosting_region", region.group(1).lower(), sentence,
                              "region_statement", record)
                    )

                date = _DATE_TOKEN.search(sentence)
                if date and ("target date" in lowered or "deadline" in lowered or "go-live" in lowered):
                    facts.append(
                        _fact(primary, "target_date", date.group(1), sentence,
                              "target_date_statement", record)
                    )

            if any(marker in lowered for marker in _DECISION_MARKERS):
                decisions.append(
                    {
                        "subject": primary.name,
                        "attribute": "decision_outcome",
                        "value": "recorded",
                        "statement": sentence,
                        "confidence": PATTERN_CONFIDENCE,
                        "verified": False,
                        "source_span": sentence,
                        "pattern": "explicit_decision_marker",
                    }
                )
            if any(marker in lowered for marker in _ASSUMPTION_MARKERS):
                assumptions.append(
                    {
                        "subject": primary.name,
                        "attribute": "assumption_basis",
                        "value": "declared_dependency",
                        "statement": sentence,
                        "confidence": PATTERN_CONFIDENCE,
                        "verified": False,
                        "source_span": sentence,
                        "pattern": "explicit_assumption_marker",
                    }
                )
        return facts, decisions, assumptions

    @staticmethod
    def _compliance_attribute(lowered: str) -> Optional[str]:
        """Attribute name implied by a compliance noun in the sentence."""
        for noun, attribute in _ATTRIBUTE_FOR_NOUN.items():
            if noun in lowered:
                return attribute
        return None

    def _guess_label(self, name: str) -> Optional[str]:
        """Label for an entity not already in the graph, when inferable.

        Returns ``None`` for anything not already known, which defers label
        inference to the engine's resolution rules rather than guessing here - a
        wrong label would create a duplicate entity instead of linking to the
        existing one.
        """
        key = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
        known = self.gazetteer.get(key)
        return known[1] if known else None

    @staticmethod
    def _warnings(record: SourceRecord, result: ExtractionResult) -> list[str]:
        """Explain what the offline extractor could and could not do."""
        warnings: list[str] = []
        if not result.claim_count and not result.entities:
            warnings.append(
                "The deterministic extractor found no anchored claims or entities in this "
                "record. Nothing was written as truth."
            )
        elif result.claim_count:
            warnings.append(
                f"{result.claim_count} candidate claim(s) were produced offline. All are "
                "unverified and flagged NEEDS_REVIEW until a human or a configured LLM "
                "confirms them."
            )
        if not record.text.strip():
            warnings.append("The source record has no text body to analyse.")
        return warnings


def _fact(
    entity: ExtractedEntity,
    attribute: str,
    value: str,
    sentence: str,
    pattern: str,
    record: SourceRecord,
) -> dict[str, Any]:
    """Build a pattern-matched fact payload."""
    return {
        "subject": entity.name,
        "subject_label": entity.label if entity.label in NODE_TYPES else None,
        "attribute": attribute,
        "value": value,
        "statement": sentence,
        "confidence": PATTERN_CONFIDENCE,
        "verified": False,
        "source_span": sentence,
        "pattern": pattern,
        "extra": {"declared_on_record": record.external_id},
    }


def _dedupe_claims(claims: Sequence[ExtractedClaim]) -> list[ExtractedClaim]:
    """Collapse claims produced by more than one pattern."""
    seen: dict[tuple[str, str, str, str], ExtractedClaim] = {}
    for claim in claims:
        key = (claim.subject.lower(), claim.attribute.lower(), str(claim.value).lower(), claim.statement)
        existing = seen.get(key)
        if existing is None or claim.confidence > existing.confidence:
            seen[key] = claim
    return sorted(seen.values(), key=lambda claim: (claim.subject, claim.attribute, str(claim.value)))
