"""Contradiction detection (``find_contradictions``).

The engine has to distinguish six situations that a naive "text differs"
comparison would collapse into one (spec S6):

======================  ==========================================================
kind                    meaning
======================  ==========================================================
``contradiction``       genuinely conflicting claim about the same subject and
                        attribute, over overlapping real-world validity
``unverified``          it conflicts, but the new source is not trustworthy enough
                        to treat as established - recorded, never auto-accepted
``ambiguous``           existing knowledge was *already* internally inconsistent
``temporal``            a statement about a different period: succession, not conflict
``additive``            new information about the subject that does not conflict
``unrelated``           no existing fact shares the subject/attribute at all
======================  ==========================================================

Design
------
* **Pure and read-only.**  This module never writes.  It returns classified
  candidates; :mod:`tripwire.core.engine` persists the verdicts.  That makes the
  hardest logic in the system unit-testable without a database.
* **Rules first, LLM second.**  A deterministic attribute/polarity rule engine
  decides the classification.  An optional LLM comparison can raise confidence
  or surface nuance, but its output is recorded as ``llm_assisted`` and is never
  promoted to verified truth (spec S5/S6).
* **Explicit demonstration rules** live in :data:`EXPLICIT_RULES` so the demo's
  behaviour is inspectable and reviewable rather than hidden in a threshold.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional, Sequence

from .index import GraphIndex
from .models import Node
from .timeutil import parse_iso

__all__ = [
    "FactClaim",
    "ContradictionCandidate",
    "ContradictionResult",
    "claim_from_node",
    "find_contradictions",
    "ATTRIBUTE_RULES",
    "EXPLICIT_RULES",
    "polarity",
]

# --------------------------------------------------------------------------- #
# Attribute knowledge
# --------------------------------------------------------------------------- #
#: Attributes that are single-valued per subject per point in time.  Two
#: different values therefore conflict.  Unknown attributes default to
#: functional, which is the conservative choice: it produces a candidate for
#: review rather than silently missing a real conflict.
MULTI_VALUED_ATTRIBUTES: frozenset[str] = frozenset(
    {"integrations", "features", "capabilities", "markets", "languages", "open_items"}
)

#: High-consequence attribute families.  A conflict here is worth a human's time
#: even at moderate confidence, because compliance and contractual facts tend to
#: gate launches.
HIGH_SEVERITY_ATTRIBUTES: frozenset[str] = frozenset(
    {
        "compliance_status",
        "certification_status",
        "certification",
        "data_residency",
        "hosting_region",
        "contract_status",
        "sla_terms",
        "security_clearance",
        "license_status",
    }
)

#: Spellings that mean the same attribute, so ingestion of slightly different
#: vocabulary does not silently lose candidate matches.
ATTRIBUTE_ALIASES: Mapping[str, str] = {
    "eu_compliance": "compliance_status",
    "eu_compliance_certification": "certification_status",
    "compliance": "compliance_status",
    "certified": "certification_status",
    "certificate": "certification_status",
    "region": "hosting_region",
    "residency": "data_residency",
    "data_residency_region": "data_residency",
    "hosting_region_location": "hosting_region",
    "contract": "contract_status",
    "licence_status": "license_status",
}

#: Lexicon mapping value text to a polarity.  ``-1`` negates, ``+1`` affirms.
_NEGATIVE_TERMS = (
    "revoke", "revoked", "revocation", "withdraw", "withdrawn", "suspend", "suspended",
    "lost", "lose", "terminated", "terminate", "expired", "expire", "invalid",
    "invalidated", "failed", "fail", "denied", "cancelled", "canceled", "no longer",
    "delisted", "breach", "breached", "non-compliant", "noncompliant", "unverified",
    "false", "no", "not ", "unavailable", "offline", "degraded", "blocked",
)
_POSITIVE_TERMS = (
    "valid", "active", "granted", "grant", "certified", "certification valid",
    "compliant", "compliant_with", "approved", "approve", "renewed", "renew",
    "confirmed", "true", "yes", "signed", "in force", "operational", "online",
    "healthy", "available",
)


def polarity(value: Any) -> int:
    """Classify a claim value as affirming (``+1``), negating (``-1``) or neutral.

    Checks negations first so that a phrase carrying both polarities, such as
    ``"certification revoked, previously valid"``, is treated as negating.
    """
    if value is None:
        return 0
    if isinstance(value, bool):
        return 1 if value else -1
    text = str(value).strip().lower()
    if not text:
        return 0
    if any(term in text for term in _NEGATIVE_TERMS):
        return -1
    if any(term in text for term in _POSITIVE_TERMS):
        return 1
    return 0


def normalise_attribute(attribute: Any) -> str:
    """Canonical attribute key (alias resolution + trimming)."""
    if attribute is None:
        return ""
    key = str(attribute).strip().lower().replace(" ", "_").replace("-", "_")
    return ATTRIBUTE_ALIASES.get(key, key)


def is_functional(attribute: str) -> bool:
    """True when the attribute admits exactly one value per subject/time."""
    return normalise_attribute(attribute) not in MULTI_VALUED_ATTRIBUTES


# --------------------------------------------------------------------------- #
# Explicit demonstration rules
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ExplicitRule:
    """A human-readable rule that can escalate a conflict.

    Rules are declarative so a reviewer can read, test and extend demo behaviour
    instead of reverse-engineering thresholds.
    """

    name: str
    attributes: frozenset[str]
    requires_polarity_opposition: bool
    severity: str
    explanation: str

    def matches(self, new: "FactClaim", old: "FactClaim") -> bool:
        """True when this rule applies to the candidate pair."""
        if new.attribute not in self.attributes:
            return False
        if self.requires_polarity_opposition:
            return new.polarity != 0 and old.polarity != 0 and new.polarity != old.polarity
        return True


EXPLICIT_RULES: tuple[ExplicitRule, ...] = (
    ExplicitRule(
        name="compliance_revocation",
        attributes=frozenset({"compliance_status", "certification_status", "license_status"}),
        requires_polarity_opposition=True,
        severity="high",
        explanation=(
            "A compliance or certification status asserted as revoked contradicts an "
            "earlier affirmation for the same subject: downstream commitments that "
            "depend on it may no longer be lawful or deliverable."
        ),
    ),
    ExplicitRule(
        name="residency_relocation",
        attributes=frozenset({"data_residency", "hosting_region"}),
        requires_polarity_opposition=False,
        severity="high",
        explanation=(
            "Data-residency attributes are functionally single-valued: two different "
            "regions for the same subject cannot both hold at once, and residency "
            "guarantees are contractual commitments."
        ),
    ),
    ExplicitRule(
        name="contract_termination",
        attributes=frozenset({"contract_status", "sla_terms"}),
        requires_polarity_opposition=True,
        severity="high",
        explanation="A terminated or breached contract invalidates delivery assumptions.",
    ),
    ExplicitRule(
        name="non_compliance_value",
        attributes=frozenset({"compliance_status"}),
        requires_polarity_opposition=False,
        severity="medium",
        explanation=(
            "Any restatement of a compliance attribute is worth comparing with prior "
            "knowledge, because the attribute gates regulated commitments."
        ),
    ),
)

DEFAULT_SEVERITY = "medium"
VERIFIED_CONFIDENCE_FLOOR = 0.6
"""A new claim below this confidence (or explicitly marked unverified) is treated
as an unverified source, never as established truth."""


# --------------------------------------------------------------------------- #
# Claim model
# --------------------------------------------------------------------------- #
@dataclass
class FactClaim:
    """Normalised view of a ``Fact`` node for comparison purposes."""

    fact_id: str
    subject_id: Optional[str]
    subject_name: str
    attribute: str
    value: Any
    polarity: int
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    recorded_at: Optional[str] = None
    recorded_to: Optional[str] = None
    confidence: float = 0.5
    verified: bool = True
    status: str = "ACTIVE"
    source_id: Optional[str] = None
    statement: str = ""

    @property
    def is_open_ended(self) -> bool:
        """True when the real-world interval has no known end."""
        return self.valid_to is None

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form for API and MCP payloads."""
        return {
            "fact_id": self.fact_id,
            "subject_id": self.subject_id,
            "subject_name": self.subject_name,
            "attribute": self.attribute,
            "value": self.value,
            "polarity": self.polarity,
            "valid_from": self.valid_from,
            "valid_to": self.valid_to,
            "recorded_at": self.recorded_at,
            "recorded_to": self.recorded_to,
            "confidence": self.confidence,
            "verified": self.verified,
            "status": self.status,
            "source_id": self.source_id,
            "statement": self.statement,
        }


def claim_from_node(node: Node, index: Optional[GraphIndex] = None) -> FactClaim:
    """Project a ``Fact`` node into a :class:`FactClaim`.

    Falls back to parsing the human-readable ``statement`` when structured
    ``subject``/``attribute`` properties are absent, so loosely-extracted facts
    still participate in comparison rather than being ignored.
    """
    props = node.props
    value = props.get("value")
    if value is None:
        value = props.get("value_text")
    attribute = normalise_attribute(props.get("attribute") or props.get("predicate"))
    if not attribute:
        attribute = _infer_attribute(props.get("statement") or node.name)
    subject_id = props.get("subject_id") or props.get("subject")
    subject_name = props.get("subject_name") or ""
    if index is not None and subject_id:
        subject_name = subject_name or index.name(subject_id)
    return FactClaim(
        fact_id=node.id,
        subject_id=subject_id,
        subject_name=subject_name or str(subject_id or "unknown"),
        attribute=attribute,
        value=value,
        polarity=polarity(value),
        valid_from=props.get("valid_from"),
        valid_to=props.get("valid_to"),
        recorded_at=props.get("recorded_at"),
        recorded_to=props.get("recorded_to"),
        confidence=float(props.get("confidence") or 0.5),
        verified=bool(props.get("verified", True)),
        status=str(props.get("status") or "ACTIVE"),
        source_id=props.get("source_id"),
        statement=str(props.get("statement") or node.name),
    )


_ATTRIBUTE_HINTS: tuple[tuple[str, str], ...] = (
    ("certification", "certification_status"),
    ("certified", "certification_status"),
    ("compliance", "compliance_status"),
    ("residency", "data_residency"),
    ("region", "hosting_region"),
    ("contract", "contract_status"),
    ("sla", "sla_terms"),
    ("headcount", "headcount"),
    ("price", "pricing"),
    ("budget", "budget"),
    ("latency", "latency_slo"),
    ("deadline", "target_date"),
)


def _infer_attribute(statement: str) -> str:
    """Best-effort attribute inference from a natural-language statement."""
    text = str(statement).lower()
    for needle, attribute in _ATTRIBUTE_HINTS:
        if needle in text:
            return attribute
    return "unspecified"


# --------------------------------------------------------------------------- #
# Result model
# --------------------------------------------------------------------------- #
@dataclass
class ContradictionCandidate:
    """One classified comparison between the new fact and an existing fact."""

    kind: str
    existing_fact_id: Optional[str]
    new_fact_id: str
    attribute: str
    existing_value: Any = None
    new_value: Any = None
    severity: str = DEFAULT_SEVERITY
    confidence: float = 0.0
    rationale: str = ""
    review_status: str = "NEEDS_REVIEW"
    explicit_rule: Optional[str] = None
    llm_assisted: bool = False
    temporal_overlap: bool = True
    contradicts: bool = False
    already_recorded: bool = False
    """True when a ``CONTRADICTS`` edge for this pair already exists.

    Re-detection must not be silently dropped: replaying an event has to report
    that the conflict is known while creating no duplicate edge, alert or status
    change (spec S7)."""

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form for API and MCP payloads."""
        return {
            "kind": self.kind,
            "existing_fact_id": self.existing_fact_id,
            "new_fact_id": self.new_fact_id,
            "attribute": self.attribute,
            "existing_value": self.existing_value,
            "new_value": self.new_value,
            "severity": self.severity,
            "confidence": round(self.confidence, 3),
            "rationale": self.rationale,
            "review_status": self.review_status,
            "explicit_rule": self.explicit_rule,
            "llm_assisted": self.llm_assisted,
            "temporal_overlap": self.temporal_overlap,
            "contradicts": self.contradicts,
            "already_recorded": self.already_recorded,
        }


@dataclass
class ContradictionResult:
    """Outcome of comparing one new fact against existing knowledge."""

    new_fact_id: str
    new_claim: FactClaim
    candidates: list[ContradictionCandidate] = field(default_factory=list)
    considered: int = 0
    summary: dict[str, int] = field(default_factory=dict)
    llm_used: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def contradictions(self) -> list[ContradictionCandidate]:
        """Candidates that are genuine conflicts or unverified conflicts."""
        return [c for c in self.candidates if c.contradicts]

    @property
    def primary(self) -> Optional[ContradictionCandidate]:
        """Highest-confidence conflicting candidate, if any."""
        conflicts = self.contradictions
        if not conflicts:
            return None
        return sorted(conflicts, key=lambda c: (-c.confidence, c.existing_fact_id or ""))[0]

    @property
    def found(self) -> bool:
        """True when at least one conflicting candidate was identified."""
        return bool(self.contradictions)

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form including a plain-language summary."""
        return {
            "new_fact_id": self.new_fact_id,
            "new_claim": self.new_claim.as_dict(),
            "contradiction_found": self.found,
            "considered": self.considered,
            "llm_used": self.llm_used,
            "summary": dict(self.summary),
            "notes": list(self.notes),
            "candidates": [c.as_dict() for c in self.candidates],
            "primary": self.primary.as_dict() if self.primary else None,
        }


# --------------------------------------------------------------------------- #
# Comparison
# --------------------------------------------------------------------------- #
def _intervals_overlap(new: FactClaim, old: FactClaim) -> bool:
    """True when the two real-world validity intervals can overlap.

    Open-ended bounds are treated as extending indefinitely, so only an explicit
    non-overlap (old closed before new began) yields ``temporal``.
    """
    old_end = parse_iso(old.valid_to)
    new_start = parse_iso(new.valid_from)
    new_end = parse_iso(new.valid_to)
    old_start = parse_iso(old.valid_from)
    if old_end is not None and new_start is not None and old_end <= new_start:
        return False
    if new_end is not None and old_start is not None and new_end <= old_start:
        return False
    return True


def _source_reliability(claim: FactClaim) -> float:
    """Blend extraction confidence with the verified flag."""
    base = max(0.0, min(1.0, claim.confidence))
    return base if claim.verified else base * 0.6


def _score_candidate(
    new: FactClaim,
    old: FactClaim,
    *,
    rule: Optional[ExplicitRule],
    overlapping: bool,
    prior_ambiguity: bool,
) -> float:
    """Confidence that this pair is a real conflict worth a human's review."""
    score = 0.35
    if normalise_attribute(new.attribute) == normalise_attribute(old.attribute):
        score += 0.15
    if new.polarity and old.polarity and new.polarity != old.polarity:
        score += 0.15
    score += 0.20 * _source_reliability(new)
    if rule is not None:
        score += 0.10
    if not overlapping:
        score -= 0.25
    if prior_ambiguity:
        score -= 0.10
    if old.status in ("INVALIDATED",):
        score -= 0.05
    if not new.verified:
        score -= 0.15
    return max(0.0, min(1.0, score))


def _classify(
    new: FactClaim,
    old: FactClaim,
    *,
    overlapping: bool,
    prior_ambiguity: bool,
    source_is_unverified: bool,
    same_subject: bool,
) -> tuple[str, Optional[ExplicitRule]]:
    """Deterministic classification of a single candidate pair."""
    rule = next((r for r in EXPLICIT_RULES if r.matches(new, old)), None)
    same_attribute = normalise_attribute(new.attribute) == normalise_attribute(old.attribute)

    if not same_attribute:
        # Same subject but a different attribute is new information about that
        # subject, not a conflict.  A shared attribute for a *different* subject is
        # genuinely unrelated.
        return ("additive" if same_subject else "unrelated"), rule
    if not same_subject:
        # Same attribute, different subject: no conflict is possible between them.
        # Without this guard an opposing value on a different subject (for example a
        # second service whose licence was revoked) would be reported as a
        # contradiction of the first service's record - a false positive.
        return "unrelated", rule
    if not overlapping:
        return "temporal", rule
    if prior_ambiguity:
        return "ambiguous", rule

    values_differ = _normalise_value(new.value) != _normalise_value(old.value)
    if not values_differ:
        return "additive", rule

    polarity_opposed = (
        new.polarity != 0 and old.polarity != 0 and new.polarity != old.polarity
    )
    functional = is_functional(new.attribute)

    if source_is_unverified:
        return "unverified", rule
    if polarity_opposed or functional:
        return "contradiction", rule
    return "additive", rule


def _normalise_value(value: Any) -> str:
    """Comparison key for values (case/space-insensitive)."""
    return " ".join(str(value or "").strip().lower().split())


def _existing_contradiction(
    index: GraphIndex, new_fact_id: str, old_fact_id: str
) -> Optional[dict[str, Any]]:
    """Return the properties of a recorded ``CONTRADICTS`` edge between two facts.

    Checks both directions because the engine always writes ``new -> old`` while an
    externally authored graph may legitimately record the reverse.
    """
    for edge in index.out(new_fact_id, ["CONTRADICTS"]):
        if edge.dst == old_fact_id:
            return dict(edge.props)
    for edge in index.out(old_fact_id, ["CONTRADICTS"]):
        if edge.dst == new_fact_id:
            return dict(edge.props)
    return None


def find_contradictions(
    new_fact: Node | str,
    index: GraphIndex,
    *,
    llm: Any = None,
    max_candidates: int = 12,
    verified_confidence_floor: float = VERIFIED_CONFIDENCE_FLOOR,
) -> ContradictionResult:
    """Identify existing facts that may conflict with ``new_fact``.

    Parameters
    ----------
    new_fact:
        The newly asserted ``Fact`` node, or its id (already present in ``index``).
    index:
        Snapshot of the graph.
    llm:
        Optional object exposing ``compare_facts(old_claim, new_claim) -> dict``.
        Its verdict can only *demote* an unverified conflict or annotate the
        rationale; it can never mark a claim verified (spec S6).
    max_candidates:
        Cap on how many existing facts are compared, keeping the tool responsive.

    Returns
    -------
    ContradictionResult
        Every classified candidate plus counts, so a frontend can show both the
        conflict and the reasoning that rejected the alternatives.
    """
    claim_new = (
        claim_from_node(new_fact, index)
        if isinstance(new_fact, Node)
        else claim_from_node(index.node(new_fact), index)  # type: ignore[arg-type]
        if index.node(new_fact) is not None
        else None
    )
    if claim_new is None:
        raise KeyError(f"fact {new_fact!r} is not present in the graph snapshot")

    source_is_unverified = (not claim_new.verified) or (
        claim_new.confidence < verified_confidence_floor
    )

    # -- candidate retrieval: same subject, same attribute family --------------
    considered: list[tuple[FactClaim, bool]] = []
    for node in index.of_label("Fact"):
        if node.id == claim_new.fact_id:
            continue
        other = claim_from_node(node, index)
        same_subject = (
            other.subject_id and claim_new.subject_id and other.subject_id == claim_new.subject_id
        )
        same_attribute = normalise_attribute(other.attribute) == normalise_attribute(
            claim_new.attribute
        )
        if not (same_subject or same_attribute):
            continue
        considered.append((other, bool(same_subject and same_attribute)))

    candidates: list[ContradictionCandidate] = []
    counts: dict[str, int] = {
        "contradiction": 0,
        "unverified": 0,
        "ambiguous": 0,
        "temporal": 0,
        "additive": 0,
        "unrelated": 0,
    }

    # Detect pre-existing internal inconsistency for the subject+attribute:
    # if prior knowledge already disagrees with itself, the new claim lands in an
    # ambiguous context and must not be auto-promoted.
    existing_values = {
        _normalise_value(other.value)
        for other, both in considered
        if both and other.status not in ("INVALIDATED",)
    }
    prior_ambiguity = len(existing_values) > 1

    for other, both in considered[:max_candidates]:
        # An already-recorded conflict short-circuits classification: replaying the
        # same event must report the known contradiction without creating a second
        # edge, alert or status change.
        recorded = _existing_contradiction(index, claim_new.fact_id, other.fact_id)
        if recorded is not None:
            counts["contradiction" if recorded.get("status") == "VERIFIED" else "unverified"] = (
                counts.get(
                    "contradiction" if recorded.get("status") == "VERIFIED" else "unverified", 0
                )
                + 1
            )
            candidates.append(
                ContradictionCandidate(
                    kind=str(recorded.get("kind") or "contradiction"),
                    existing_fact_id=other.fact_id,
                    new_fact_id=claim_new.fact_id,
                    attribute=claim_new.attribute,
                    existing_value=other.value,
                    new_value=claim_new.value,
                    severity=str(recorded.get("severity") or DEFAULT_SEVERITY),
                    confidence=float(recorded.get("confidence") or 0.5),
                    rationale=(
                        "This conflict was already detected and recorded ("
                        f"status {recorded.get('status')}); replaying the event does not "
                        "create a duplicate relationship or alert."
                    ),
                    review_status=str(recorded.get("review_status") or "NEEDS_REVIEW"),
                    explicit_rule=recorded.get("rule"),
                    contradicts=True,
                    already_recorded=True,
                )
            )
            continue

        overlapping = _intervals_overlap(claim_new, other)
        same_subject = bool(
            other.subject_id and claim_new.subject_id and other.subject_id == claim_new.subject_id
        )
        kind, rule = _classify(
            claim_new,
            other,
            overlapping=overlapping,
            prior_ambiguity=prior_ambiguity,
            source_is_unverified=source_is_unverified,
            same_subject=same_subject,
        )
        confidence = _score_candidate(
            claim_new,
            other,
            rule=rule,
            overlapping=overlapping,
            prior_ambiguity=prior_ambiguity,
        )
        severity = rule.severity if rule else (
            "high" if normalise_attribute(claim_new.attribute) in HIGH_SEVERITY_ATTRIBUTES else DEFAULT_SEVERITY
        )
        contradicts = kind in ("contradiction", "unverified")
        rationale = _rationale(kind, claim_new, other, rule, overlapping, prior_ambiguity)
        candidate = ContradictionCandidate(
            kind=kind,
            existing_fact_id=other.fact_id,
            new_fact_id=claim_new.fact_id,
            attribute=claim_new.attribute,
            existing_value=other.value,
            new_value=claim_new.value,
            severity=severity,
            confidence=confidence,
            rationale=rationale,
            review_status="NEEDS_REVIEW" if contradicts else "AUTO_ACCEPTED",
            explicit_rule=rule.name if rule else None,
            temporal_overlap=overlapping,
            contradicts=contradicts,
        )
        candidates.append(candidate)
        counts[kind] = counts.get(kind, 0) + 1

    result = ContradictionResult(
        new_fact_id=claim_new.fact_id,
        new_claim=claim_new,
        candidates=sorted(
            candidates,
            key=lambda c: (not c.contradicts, -c.confidence, c.existing_fact_id or ""),
        ),
        considered=len(considered),
        summary=counts,
    )

    if not considered:
        result.notes.append(
            "No existing fact shares this subject or attribute: the claim is unrelated "
            "to current knowledge and is ingested as new information."
        )
        counts["unrelated"] = counts.get("unrelated", 0)
    if source_is_unverified:
        result.notes.append(
            f"Source confidence {claim_new.confidence:.2f} is below the verified floor "
            f"{verified_confidence_floor:.2f} (or the claim is marked unverified): "
            "conflicts are recorded for review and are not treated as established truth."
        )
    if prior_ambiguity:
        result.notes.append(
            "Prior knowledge about this subject and attribute is already internally "
            "inconsistent, so the new claim cannot be resolved automatically."
        )

    if llm is not None and result.contradictions:
        result.llm_used = True
        for candidate in result.contradictions:
            existing_claim = claim_from_node(index.node(candidate.existing_fact_id), index)  # type: ignore[arg-type]
            try:
                verdict = llm.compare_facts(existing_claim, claim_new)
            except Exception as exc:  # noqa: BLE001 - LLM is optional by design
                result.notes.append(f"LLM comparison unavailable: {exc}")
                result.llm_used = False
                break
            if not isinstance(verdict, dict):
                result.notes.append("LLM comparison returned an unusable payload; ignored.")
                continue
            candidate.llm_assisted = True
            reason = verdict.get("reason")
            if reason:
                candidate.rationale = f"{candidate.rationale} LLM note: {reason}"
            relation = str(verdict.get("relation") or "").strip().lower()
            # An LLM may only *soften* an automatic verdict.  It can never upgrade
            # a claim to verified truth or mark a conflict resolved.
            if relation in ("unrelated", "additive", "different_time") and candidate.kind == "contradiction":
                candidate.kind = "temporal" if relation == "different_time" else "additive"
                candidate.contradicts = False
                candidate.review_status = "NEEDS_REVIEW"
                candidate.rationale = (
                    f"{candidate.rationale} Softened to '{candidate.kind}' by LLM "
                    "comparison; retained for human review rather than auto-resolved."
                )
                counts["contradiction"] = max(0, counts.get("contradiction", 0) - 1)
                counts[candidate.kind] = counts.get(candidate.kind, 0) + 1
            llm_confidence = verdict.get("confidence")
            if isinstance(llm_confidence, (int, float)):
                candidate.confidence = round(
                    min(0.95, max(candidate.confidence, float(llm_confidence) * 0.9)), 3
                )
        result.candidates.sort(
            key=lambda c: (not c.contradicts, -c.confidence, c.existing_fact_id or "")
        )
    return result


def _rationale(
    kind: str,
    new: FactClaim,
    old: FactClaim,
    rule: Optional[ExplicitRule],
    overlapping: bool,
    prior_ambiguity: bool,
) -> str:
    """Human-readable justification for a classification."""
    rule_note = f" Rule '{rule.name}': {rule.explanation}" if rule else ""
    if kind == "contradiction":
        return (
            f"Both facts describe '{new.attribute}' for {new.subject_name}: the earlier "
            f"record states '{old.value}' while the new record states '{new.value}', "
            "with overlapping validity, so they cannot both hold."
            f"{rule_note}"
        )
    if kind == "unverified":
        return (
            f"The new record conflicts with '{old.value}' on '{new.attribute}', but its "
            f"source is not verified (confidence {new.confidence:.2f}), so the conflict "
            "is recorded for review instead of being accepted."
            f"{rule_note}"
        )
    if kind == "ambiguous":
        return (
            f"Existing records already disagree about '{new.attribute}' for "
            f"{new.subject_name}, so the new value '{new.value}' neither confirms nor "
            "cleanly contradicts them."
            f"{rule_note}"
        )
    if kind == "temporal":
        return (
            f"The earlier record's validity ended before the new record begins "
            f"({old.valid_to} <= {new.valid_from}): this is a change over time rather "
            "than a contradiction."
            f"{rule_note}"
        )
    if kind == "additive":
        return (
            f"The new record adds information about '{new.attribute}' for "
            f"{new.subject_name} without conflicting with '{old.value}'."
        )
    if kind == "unrelated":
        return "The two records describe different attributes and do not interact."
    return "Classification could not be determined."
