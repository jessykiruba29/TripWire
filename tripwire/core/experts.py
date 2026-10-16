"""Contribution-based expert finding (``find_experts``) and the shadow org chart.

The point of this module is to answer "who actually understands this system?"
rather than "who owns it on the org chart?".  Raw message counts do not prove
expertise, so the ranking is a transparent weighted sum over *typed* evidence
with explicit relevance, recency and quality factors (spec S10):

    score = weight(type) x relevance(distance) x recency(age) x quality(confidence)

Evidence types and why they are weighted as they are:

===================================  ======  =============================================
evidence                             weight  rationale
===================================  ======  =============================================
resolved a ticket about the target      3.0  hands-on debugging is the strongest signal
made a decision that affects it         3.0  decisions require system understanding
authored its PRD                        2.5  defines the system's contract
authored meeting notes about it         2.0  present in design discussion, not just copied
authored a design document              2.0  durable technical artefact
authored a message discussing it        1.0  cheap, noisy, easily inflated
===================================  ======  =============================================

Every contribution is returned with its artefact id, timestamp and the computed
score components, so a reviewer can audit the ranking instead of trusting it.
Nothing is inferred: if the graph has no evidence for a person, they do not
appear, and thin evidence is reported as uncertainty.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Optional, Sequence

from .ids import slug
from .index import GraphIndex
from .models import Node
from .timeutil import parse_iso

__all__ = [
    "Contribution",
    "ExpertRank",
    "ExpertReport",
    "find_experts",
    "CONTRIBUTION_WEIGHTS",
    "RECENCY_HALF_LIFE_DAYS",
]

CONTRIBUTION_WEIGHTS: dict[str, float] = {
    "resolved_ticket": 3.0,
    "made_decision": 3.0,
    "authored_prd": 2.5,
    "authored_meeting_note": 2.0,
    "authored_design_doc": 2.0,
    "authored_document": 1.5,
    "authored_message": 1.0,
    "contributed_to_meeting": 0.9,
    "discussed_target": 0.6,
}

#: Evidence older than this contributes progressively less; 180 days is a
#: deliberately short half-life so a recent contributor outranks a historical one.
RECENCY_HALF_LIFE_DAYS = 180.0

#: Distance penalties: direct evidence about the target vs. structurally related
#: evidence (a decision that impacts the project, a system the project uses) vs.
#: evidence one hop further out.
RELEVANCE_DIRECT = 1.0
RELEVANCE_STRUCTURAL = 0.8
RELEVANCE_INDIRECT = 0.6
RELEVANCE_WEAK = 0.4

MIN_EVIDENCE_FOR_CONFIDENCE = 2
LOW_SCORE_THRESHOLD = 0.25


@dataclass
class Contribution:
    """One piece of evidence that a person worked on the target."""

    person_id: str
    person_name: str
    artifact_id: str
    artifact_label: str
    artifact_name: str
    contribution_type: str
    weight: float
    relevance: float
    recency: float
    quality: float
    score: float
    timestamp: Optional[str] = None
    source_ref: Optional[str] = None
    note: str = ""

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form, exposing every score component for audit."""
        return {
            "person_id": self.person_id,
            "person_name": self.person_name,
            "artifact_id": self.artifact_id,
            "artifact_label": self.artifact_label,
            "artifact_name": self.artifact_name,
            "contribution_type": self.contribution_type,
            "weight": round(self.weight, 3),
            "relevance": round(self.relevance, 3),
            "recency": round(self.recency, 3),
            "quality": round(self.quality, 3),
            "score": round(self.score, 3),
            "timestamp": self.timestamp,
            "source_ref": self.source_ref,
            "note": self.note,
        }


@dataclass
class ExpertRank:
    """A ranked person with the evidence that justified their position."""

    person_id: str
    person_name: str
    score: float
    normalized_score: float
    rank: int = 0
    role: Optional[str] = None
    team_name: Optional[str] = None
    contributions: list[Contribution] = field(default_factory=list)
    contribution_counts: dict[str, int] = field(default_factory=dict)
    systems: list[str] = field(default_factory=list)
    projects: list[str] = field(default_factory=list)
    official_owner_of: list[str] = field(default_factory=list)
    is_official_owner: bool = False
    reason: str = ""
    uncertainty: Optional[str] = None

    @property
    def evidence_refs(self) -> list[str]:
        """Ids of the artefacts backing this ranking."""
        seen: list[str] = []
        for contribution in self.contributions:
            if contribution.artifact_id not in seen:
                seen.append(contribution.artifact_id)
        return seen

    @property
    def shadow_signal(self) -> bool:
        """True when a top-ranked person is *not* the official owner.

        This is the shadow-organisational-chart signal: the person who actually
        understands the system differs from the person the org chart names.
        """
        return not self.is_official_owner and self.normalized_score >= 0.5

    def as_dict(self, *, max_contributions: int = 8) -> dict[str, Any]:
        """Serialisable form for the API and MCP tools."""
        return {
            "rank": self.rank,
            "person_id": self.person_id,
            "person_name": self.person_name,
            "role": self.role,
            "team_name": self.team_name,
            "score": round(self.score, 3),
            "normalized_score": round(self.normalized_score, 3),
            "contribution_counts": dict(self.contribution_counts),
            "contribution_total": len(self.contributions),
            "systems": list(self.systems),
            "projects": list(self.projects),
            "is_official_owner": self.is_official_owner,
            "official_owner_of": list(self.official_owner_of),
            "shadow_signal": self.shadow_signal,
            "reason": self.reason,
            "uncertainty": self.uncertainty,
            "evidence_refs": self.evidence_refs,
            "contributions": [
                c.as_dict() for c in self.contributions[:max_contributions]
            ],
        }


@dataclass
class ExpertReport:
    """Result of an expert query."""

    query: str
    target_id: Optional[str] = None
    target_label: Optional[str] = None
    target_name: Optional[str] = None
    experts: list[ExpertRank] = field(default_factory=list)
    official_owners: list[dict[str, Any]] = field(default_factory=list)
    related_targets: list[str] = field(default_factory=list)
    method: str = ""
    notes: list[str] = field(default_factory=list)

    @property
    def hidden_experts(self) -> list[ExpertRank]:
        """Top-ranked contributors who are not the official owner."""
        return [e for e in self.experts if e.shadow_signal]

    def as_dict(self) -> dict[str, Any]:
        """Serialisable form with the ranking method spelled out."""
        return {
            "query": self.query,
            "target_id": self.target_id,
            "target_label": self.target_label,
            "target_name": self.target_name,
            "method": self.method,
            "notes": list(self.notes),
            "related_targets": list(self.related_targets),
            "official_owners": list(self.official_owners),
            "experts": [e.as_dict() for e in self.experts],
            "hidden_experts": [e.as_dict() for e in self.hidden_experts],
        }


# --------------------------------------------------------------------------- #
# Target resolution
# --------------------------------------------------------------------------- #
def resolve_targets(index: GraphIndex, query: str) -> list[Node]:
    """Resolve a free-text target to System/Project (then Team) nodes.

    Exact id, then slug match, then name containment.  Returning the candidates
    (rather than guessing one) lets the caller report ambiguity honestly.
    """
    text = (query or "").strip()
    if not text:
        return []
    node = index.node(text)
    if node is not None and node.label in ("System", "Project", "Team"):
        return [node]

    wanted = slug(text)
    candidates = [
        candidate
        for candidate in index.nodes.values()
        if candidate.label in ("System", "Project", "Team")
    ]
    exact = [c for c in candidates if slug(c.name) == wanted or slug(c.id.split(":", 1)[-1]) == wanted]
    if exact:
        return sorted(exact, key=lambda n: n.id)
    partial = [
        c
        for c in candidates
        if wanted and (wanted in slug(c.name) or slug(c.name) in wanted)
    ]
    return sorted(partial, key=lambda n: n.id)


def _recency_factor(timestamp: Optional[str], now_iso_value: str) -> float:
    """Exponential decay on the artefact timestamp."""
    if not timestamp:
        return 0.5  # neutral: undated evidence neither helps nor dominates
    moment = parse_iso(timestamp)
    now = parse_iso(now_iso_value)
    if moment is None or now is None:
        return 0.5
    age_days = max(0.0, (now - moment).total_seconds() / 86400.0)
    return float(0.5 ** (age_days / RECENCY_HALF_LIFE_DAYS))


def _quality(node: Node, default: float = 0.7) -> float:
    """Evidence quality from the artefact's recorded extraction confidence."""
    value = node.props.get("confidence")
    if value is None:
        return default
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return default


def _contribution_type(artifact: Node, resolved: bool, authored: bool) -> str:
    """Classify an evidence artefact into a weighted contribution type."""
    label = artifact.label
    doc_type = str(artifact.props.get("doc_type") or "")
    if resolved and label == "Document" and doc_type == "ticket":
        return "resolved_ticket"
    if label == "Decision":
        return "made_decision"
    if label == "Document":
        if doc_type == "prd":
            return "authored_prd"
        if doc_type == "meeting_note":
            return "authored_meeting_note" if authored else "contributed_to_meeting"
        if doc_type == "design_doc":
            return "authored_design_doc"
        return "authored_document"
    if label == "Message":
        return "authored_message" if authored else "discussed_target"
    return "discussed_target"


# --------------------------------------------------------------------------- #
# Ranking
# --------------------------------------------------------------------------- #
def find_experts(
    index: GraphIndex,
    query: str,
    *,
    limit: int = 5,
    now: Optional[str] = None,
    include_indirect: bool = True,
) -> ExpertReport:
    """Rank people by demonstrated contribution to the queried system/project.

    Parameters
    ----------
    index:
        Graph snapshot.
    query:
        System or project name/id.  Unresolvable queries return an empty ranking
        with an explanation rather than a fabricated one.
    limit:
        Maximum number of people returned.
    now:
        Reference instant for recency decay (defaults to the newest artefact in
        the graph, keeping results deterministic across runs).
    include_indirect:
        Also count evidence about directly related systems/projects at a reduced
        relevance, which is how genuinely cross-cutting contributors surface.

    Returns
    -------
    ExpertReport
        Ranked people with per-contribution score breakdowns, the official owners
        for contrast, and explicit uncertainty where evidence is thin.
    """
    reference = now or _latest_timestamp(index) or "2100-01-01T00:00:00Z"
    report = ExpertReport(
        query=query,
        method=(
            "score = weight(contribution_type) x relevance(distance) x "
            "recency(0.5 ^ (age_days/180)) x quality(artefact confidence), "
            "summed per person and normalised to the top scorer."
        ),
    )
    targets = resolve_targets(index, query)
    if not targets:
        report.notes.append(
            f"No system, project or team matches {query!r}; no ranking is produced "
            "because contributions cannot be attributed without a target."
        )
        return report
    if len(targets) > 1:
        report.notes.append(
            "Multiple targets matched; contributions are aggregated across "
            f"{len(targets)} entities."
        )
    target_ids = {target.id for target in targets}
    report.target_id = targets[0].id
    report.target_label = targets[0].label
    report.target_name = targets[0].name

    # -- build the evidence pool -------------------------------------------
    relevance_map: dict[str, float] = {target_id: RELEVANCE_DIRECT for target_id in target_ids}
    for target in targets:
        # Source artifacts that explicitly mention the target are direct evidence.
        for related in index.incoming(target.id, ["MENTIONS"]):
            relevance_map.setdefault(related.src, RELEVANCE_DIRECT)
    # Structurally related artefacts (a decision that impacts the project, a system
    # the project uses) sit one step out; anything beyond that is indirect.
    if include_indirect:
        for target in targets:
            for related in index.out(target.id, ["USES", "DEPENDS_ON", "IMPACTS"]):
                relevance_map.setdefault(related.dst, RELEVANCE_STRUCTURAL)
            for related in index.incoming(target.id, ["USES", "DEPENDS_ON", "IMPACTS"]):
                relevance_map.setdefault(related.src, RELEVANCE_STRUCTURAL)
        first_ring = dict(relevance_map)
        for node_id, relevance in first_ring.items():
            if relevance == RELEVANCE_DIRECT:
                continue
            node = index.node(node_id)
            if node is None:
                continue
            for related in index.out(node_id, ["USES", "DEPENDS_ON", "IMPACTS", "MENTIONS"]):
                relevance_map.setdefault(related.dst, RELEVANCE_INDIRECT)
            for related in index.incoming(node_id, ["USES", "DEPENDS_ON", "IMPACTS", "MENTIONS"]):
                relevance_map.setdefault(related.src, RELEVANCE_INDIRECT)
    report.related_targets = sorted(
        node_id for node_id, relevance in relevance_map.items() if relevance < RELEVANCE_DIRECT
    )

    contributions: dict[str, list[Contribution]] = {}
    for artifact_id, relevance in relevance_map.items():
        artifact = index.node(artifact_id)
        if artifact is None:
            continue
        for person_id, contribution in _contributions_for_artifact(
            index, artifact, relevance, reference
        ):
            contributions.setdefault(person_id, []).append(contribution)

    # -- exclude the target entities themselves acting as "people" ----------
    contributions = {
        person_id: items
        for person_id, items in contributions.items()
        if index.label(person_id) == "Person"
    }
    if not contributions:
        report.notes.append(
            f"No person-linked evidence was found for {targets[0].name!r}. The graph "
            "contains no contribution records for this target, so reporting expertise "
            "would require inventing it."
        )
        return report

    # Score, then apply the evidence-diversity bonus, then normalise against the
    # highest *final* score so the leader is exactly 1.0 and nobody exceeds it.
    raw_scores = {
        person_id: sum(item.score for item in items)
        * (1.0 + 0.10 * (len({item.contribution_type for item in items}) - 1))
        for person_id, items in contributions.items()
    }
    top_score = max(raw_scores.values()) or 1.0

    ranked: list[ExpertRank] = []
    for person_id, items in contributions.items():
        person = index.node(person_id)
        if person is None:
            continue
        items.sort(key=lambda c: (-c.score, c.artifact_id))
        raw_score = raw_scores[person_id]
        counts: dict[str, int] = {}
        for item in items:
            counts[item.contribution_type] = counts.get(item.contribution_type, 0) + 1
        owner_of = sorted(index.targets(person_id, ["OWNS"]))
        systems = sorted(
            {
                node_id
                for node_id in index.targets(person_id, ["OWNS", "USES"])
                if index.label(node_id) == "System"
            }
        )
        projects = sorted(
            {
                node_id
                for node_id in index.targets(person_id, ["OWNS", "MADE"])
                if index.label(node_id) == "Project"
            }
        )
        team_name = None
        for team_id_value in index.targets(person_id, ["ON_TEAM"]):
            team_name = index.name(team_id_value)
            break
        uncertainty = None
        if len(items) < MIN_EVIDENCE_FOR_CONFIDENCE:
            uncertainty = (
                "Only one piece of evidence links this person to the target; treat the "
                "ranking as a lead, not a conclusion."
            )
        elif raw_score / top_score < LOW_SCORE_THRESHOLD:
            uncertainty = "Contribution score is well below the leading contributor."
        ranked.append(
            ExpertRank(
                person_id=person_id,
                person_name=person.name,
                score=raw_score,
                normalized_score=raw_score / top_score,
                role=person.props.get("role"),
                team_name=team_name,
                contributions=items,
                contribution_counts=counts,
                systems=systems,
                projects=projects,
                official_owner_of=owner_of,
                is_official_owner=bool(target_ids & set(owner_of)),
                reason=_reason(person, items, counts),
                uncertainty=uncertainty,
            )
        )

    ranked.sort(key=lambda rank: (-rank.score, rank.person_id))
    for position, rank in enumerate(ranked[:limit], start=1):
        rank.rank = position
    report.experts = ranked[:limit]

    for target in targets:
        for owner_id in index.sources(target.id, ["OWNS"]):
            owner = index.node(owner_id)
            if owner is None:
                continue
            report.official_owners.append(
                {
                    "person_id": owner_id,
                    "person_name": owner.name,
                    "official_role": owner.props.get("role"),
                    "team_name": (index.targets(owner_id, ["ON_TEAM"]) or [None])[0],
                    "owns": target.id,
                    "owns_name": target.name,
                }
            )
    report.official_owners.sort(key=lambda item: item["person_id"])

    if report.hidden_experts:
        report.notes.append(
            "At least one high-ranking contributor is not the official owner of the "
            "target: this is the shadow-organisational-chart signal."
        )
    return report


def _contributions_for_artifact(
    index: GraphIndex,
    artifact: Node,
    relevance: float,
    reference: str,
) -> list[tuple[str, Contribution]]:
    """Evidence rows linking people to one artefact."""
    if artifact.label not in ("Message", "Document", "Decision"):
        # Only knowledge artifacts carry contribution evidence.  Person/System
        # nodes never become "evidence" for themselves.
        return []
    rows: list[tuple[str, Contribution]] = []
    authors = index.sources(artifact.id, ["AUTHORED"])
    resolvers = index.sources(artifact.id, ["RESOLVED"])
    makers = index.sources(artifact.id, ["MADE"])
    timestamp = artifact.props.get("timestamp") or artifact.props.get("recorded_at")
    recency = _recency_factor(timestamp, reference)
    quality = _quality(artifact)

    for person_id in authors:
        contribution_type = _contribution_type(artifact, resolved=False, authored=True)
        rows.append(
            (
                person_id,
                _build(
                    index,
                    person_id,
                    artifact,
                    contribution_type,
                    relevance,
                    recency,
                    quality,
                    timestamp,
                    note="Authored this artefact.",
                ),
            )
        )
    for person_id in makers:
        rows.append(
            (
                person_id,
                _build(
                    index,
                    person_id,
                    artifact,
                    "made_decision" if artifact.label == "Decision" else "authored_document",
                    relevance,
                    recency,
                    quality,
                    timestamp,
                    note=(
                        "Made this decision, which requires understanding of the system it affects."
                        if artifact.label == "Decision"
                        else "Recorded as the owner of this artefact."
                    ),
                ),
            )
        )
    for person_id in resolvers:
        if person_id in authors and artifact.props.get("doc_type") == "ticket":
            # A resolver who also authored the ticket is the same evidence: do not
            # double count the same artefact as two contributions.
            continue
        rows.append(
            (
                person_id,
                _build(
                    index,
                    person_id,
                    artifact,
                    "resolved_ticket" if artifact.props.get("doc_type") == "ticket" else "made_decision",
                    relevance,
                    recency,
                    quality,
                    timestamp,
                    note="Resolved this ticket, which is direct hands-on evidence.",
                ),
            )
        )
    # Non-authoring participants in a meeting note are weaker evidence.
    for person_id in index.sources(artifact.id, ["MENTIONS"]):
        if person_id in authors or index.label(person_id) != "Person":
            continue
        if artifact.props.get("doc_type") != "meeting_note":
            continue
        rows.append(
            (
                person_id,
                _build(
                    index,
                    person_id,
                    artifact,
                    "contributed_to_meeting",
                    relevance,
                    recency,
                    quality,
                    timestamp,
                    note="Listed as a participant in this meeting note.",
                ),
            )
        )
    return rows


def _build(
    index: GraphIndex,
    person_id: str,
    artifact: Node,
    contribution_type: str,
    relevance: float,
    recency: float,
    quality: float,
    timestamp: Optional[str],
    *,
    note: str,
) -> Contribution:
    """Assemble a :class:`Contribution` with its score components."""
    weight = CONTRIBUTION_WEIGHTS.get(contribution_type, CONTRIBUTION_WEIGHTS["discussed_target"])
    return Contribution(
        person_id=person_id,
        person_name=index.name(person_id),
        artifact_id=artifact.id,
        artifact_label=artifact.label,
        artifact_name=artifact.name,
        contribution_type=contribution_type,
        weight=weight,
        relevance=relevance,
        recency=recency,
        quality=quality,
        score=weight * relevance * recency * quality,
        timestamp=timestamp,
        source_ref=artifact.props.get("source_ref"),
        note=note,
    )


def _reason(person: Node, items: Sequence[Contribution], counts: dict[str, int]) -> str:
    """Concise, evidence-backed justification for a ranking."""
    labels = {
        "resolved_ticket": "resolved {n} ticket(s) about the target",
        "made_decision": "made {n} decision(s) affecting the target",
        "authored_prd": "authored the requirements document",
        "authored_meeting_note": "authored {n} meeting note(s) on the target",
        "authored_design_doc": "authored {n} design document(s)",
        "authored_document": "authored {n} document(s)",
        "authored_message": "discussed the target in {n} message(s)",
        "contributed_to_meeting": "participated in {n} meeting(s)",
        "discussed_target": "appears in {n} artefact(s) about the target",
    }
    parts = []
    for contribution_type, count in sorted(counts.items(), key=lambda item: -item[1]):
        template = labels.get(contribution_type)
        if template:
            parts.append(template.format(n=count))
    strongest = items[0]
    return (
        f"{person.name} ({person.props.get('role') or 'role not recorded'}): "
        + ", ".join(parts)
        + f". Strongest single contribution: '{strongest.artifact_name}' "
        f"({strongest.contribution_type}, score {strongest.score:.2f})."
    )


def _latest_timestamp(index: GraphIndex) -> Optional[str]:
    """Newest **artefact** timestamp, used as the deterministic recency reference.

    Deliberately restricted to knowledge artefacts.  ``Event`` nodes carry
    wall-clock ``recorded_at`` values, and including them would make the recency
    decay - and therefore the ranking - depend on when Tripwire happened to be run,
    which would break determinism between a fresh seed and a re-run.
    """
    stamps = [
        node.props.get("timestamp") or node.props.get("recorded_at")
        for node in index.nodes.values()
        if node.label in ("Message", "Document", "Decision")
        and (node.props.get("timestamp") or node.props.get("recorded_at"))
    ]
    return max(stamps) if stamps else None
