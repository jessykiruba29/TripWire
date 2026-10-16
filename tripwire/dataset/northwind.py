"""Deterministic Northwind Labs dataset builder, manifest and demo scenarios.

``build_subgraph()`` turns the data in :mod:`tripwire.dataset.entities` and
:mod:`tripwire.dataset.sources` into real nodes and edges.  It is a pure function:
no randomness, no clock reads, no sleeps.  Running the seeder twice therefore
produces identical content and identical counts, which is what makes
``seed`` idempotent and ``reset`` reproducible (spec S13).

Every edge in the seed is justified by a source record or an explicit
organisational fact - there are no decorative relationships added to make the
visualisation look denser.  Concretely:

* ``AUTHORED`` / ``RESOLVED`` / ``MENTIONS`` / ``STATES`` all come from the 60
  source artifacts, so provenance is real.
* ``ASSUMES`` / ``SUPPORTED_BY`` reflect the reasoning actually written down in
  the PRDs and Slack threads.
* ``OWNS`` is the *official* org chart, deliberately kept separate from
  contribution evidence so the shadow org chart is meaningful.
"""

from __future__ import annotations

from typing import Any, Iterable

from ..core.ids import document_id, message_id, slug
from ..core.models import Edge, Node, Subgraph
from . import entities as E
from . import sources as S

DATASET_VERSION = "1.0.0"
DATASET_NAME = "northwind-labs"

STORYLINE = (
    "Northwind Labs plans an EU launch that depends on the Frankfurt hosting partner. The launch decision "
    "assumes EU data residency, which is supported by the partner's EU compliance certification AND, "
    "independently, a SOC 2 Type II attestation. A separate regulatory-eligibility decision rests on the "
    "certification alone. When the certification is revoked, Tripwire traces the affected decisions, shows "
    "that the launch still has independent supporting evidence (so it is only potentially affected), "
    "confirms that the regulatory decision has lost its only support, preserves both facts and their "
    "validity windows, surfaces the engineer who actually understands the partner integration, and raises "
    "explainable alerts."
)

#: Fact ids that the demo revolves around.
COMPLIANCE_FACT_ID = "fact:frankfurt-partner-compliance-valid"
SOC2_FACT_ID = "fact:frankfurt-partner-soc2-attestation-valid"
RATE_FACT_ID = "fact:frankfurt-partner-rate-hold"

#: Node ids the demo and tests refer to by name.
KEY_IDS: dict[str, str] = {
    "eu_launch_decision": E.decision_node_id("eu-launch"),
    "pricing_decision": E.decision_node_id("pricing-eu"),
    "hiring_decision": E.decision_node_id("hiring-eu-support"),
    "legal_signoff_decision": E.decision_node_id("legal-signoff-eu"),
    "apac_decision": E.decision_node_id("apac-datacentre"),
    "dark_mode_decision": E.decision_node_id("dark-mode-default"),
    "warehouse_decision": E.decision_node_id("warehouse-regional-split"),
    "frankfurt_partner": E.system_node_id("Frankfurt Hosting Partner"),
    "residency_controls": E.system_node_id("EU Data Residency Controls"),
    "ingest_pipeline": E.system_node_id("Northwind Ingest Pipeline"),
    "compliance_fact": COMPLIANCE_FACT_ID,
    "soc2_fact": SOC2_FACT_ID,
    "rate_fact": RATE_FACT_ID,
    "residency_assumption": E.assumption_node_id("data-residency-eu"),
    "eligibility_assumption": E.assumption_node_id("eu-regulatory-eligibility"),
    "cost_assumption": E.assumption_node_id("eu-cost-base"),
    "eu_launch_project": E.project_node_id("EU Launch"),
    "pricing_project": E.project_node_id("Pricing v2"),
    "hiring_project": E.project_node_id("Q3 Hiring Plan"),
    "apac_project": E.project_node_id("APAC Expansion"),
    "mobile_project": E.project_node_id("Mobile Redesign"),
    "data_governance_project": E.project_node_id("Data Governance Overhaul"),
    # The planted hidden expert and the official owner they are hidden behind.
    "hidden_expert": E.person_node_id("Jonas Berg"),
    "official_owner": E.person_node_id("Priya Raman"),
    "vendor_owner": E.person_node_id("Lena Fischer"),
}


def dataset_manifest() -> dict[str, Any]:
    """Machine-readable description of the dataset, including expected counts."""
    return {
        "name": DATASET_NAME,
        "version": DATASET_VERSION,
        "storyline": STORYLINE,
        "expected_counts": {
            "Message": len(S.SLACK),
            "Document": len(S.TICKETS) + len(S.PRDS) + len(S.MEETING_NOTES),
            "Person": len(E.PEOPLE),
            "Team": len(E.TEAMS),
            "System": len(E.SYSTEMS),
            "Project": len(E.PROJECTS),
            "Decision": len(E.DECISIONS),
            "Assumption": len(E.ASSUMPTIONS),
            "Fact": len(E.FACTS),
        },
        "breakdown": {
            "slack_messages": len(S.SLACK),
            "tickets": len(S.TICKETS),
            "prds": len(S.PRDS),
            "meeting_notes": len(S.MEETING_NOTES),
        },
        "key_ids": dict(KEY_IDS),
    }


# --------------------------------------------------------------------------- #
# Builders
# --------------------------------------------------------------------------- #
def _team_nodes() -> tuple[list[Node], list[Edge]]:
    nodes, edges = [], []
    for name, props in E.TEAMS:
        nodes.append(Node(id=E.team_node_id(name), label="Team", name=name, props=dict(props)))
    return nodes, edges


def _person_nodes() -> tuple[list[Node], list[Edge]]:
    nodes, edges = [], []
    for name, role, team, extra in E.PEOPLE:
        identifier = E.person_node_id(name)
        nodes.append(
            Node(
                id=identifier,
                label="Person",
                name=name,
                props={
                    "role": role,
                    "team_name": team,
                    "team_id": E.team_node_id(team),
                    **extra,
                },
            )
        )
        edges.append(
            Edge(
                src=identifier,
                rel="ON_TEAM",
                dst=E.team_node_id(team),
                props={"at": "2025-01-01T00:00:00Z", "role": role},
            )
        )
    return nodes, edges


def _system_nodes() -> tuple[list[Node], list[Edge]]:
    nodes = [
        Node(id=E.system_node_id(name), label="System", name=name, props=dict(props))
        for name, props in E.SYSTEMS
    ]
    return nodes, []


def _project_nodes() -> tuple[list[Node], list[Edge]]:
    nodes = [
        Node(id=E.project_node_id(name), label="Project", name=name, props=dict(props))
        for name, props in E.PROJECTS
    ]
    return nodes, []


def _decision_nodes() -> tuple[list[Node], list[Edge]]:
    nodes, edges = [], []
    for key, name, statement, maker, status, impacts, depends_on in E.DECISIONS:
        identifier = E.decision_node_id(key)
        nodes.append(
            Node(
                id=identifier,
                label="Decision",
                name=name,
                props={
                    "statement": statement,
                    "status": status,
                    "review_status": "UNREVIEWED",
                    "made_at": "2026-02-02T08:30:00Z",
                    "created_at": "2026-02-02T08:30:00Z",
                    "recorded_at": "2026-02-02T08:30:00Z",
                    "decision_key": key,
                },
            )
        )
        edges.append(
            Edge(
                src=E.person_node_id(maker),
                rel="MADE",
                dst=identifier,
                props={"at": "2026-02-02T08:30:00Z", "role": "decision maker"},
            )
        )
        if impacts:
            edges.append(
                Edge(
                    src=identifier,
                    rel="IMPACTS",
                    dst=E.project_node_id(impacts),
                    props={"at": "2026-02-02T08:30:00Z"},
                )
            )
        if depends_on:
            edges.append(
                Edge(
                    src=identifier,
                    rel="DEPENDS_ON",
                    dst=E.decision_node_id(depends_on),
                    props={
                        "at": "2026-02-02T08:30:00Z",
                        "recorded_at": "2026-02-02T08:30:00Z",
                        "reason": "Recorded as a dependency in the launch planning documents.",
                    },
                )
            )
    return nodes, edges


def _assumption_nodes() -> tuple[list[Node], list[Edge]]:
    nodes, edges = [], []
    for key, name, statement, assumed_by, facts in E.ASSUMPTIONS:
        identifier = E.assumption_node_id(key)
        nodes.append(
            Node(
                id=identifier,
                label="Assumption",
                name=name,
                props={
                    "statement": statement,
                    "status": "ACTIVE",
                    "review_status": "UNREVIEWED",
                    "created_at": "2026-02-02T08:30:00Z",
                    "recorded_at": "2026-02-02T08:30:00Z",
                    "assumption_key": key,
                },
            )
        )
        edges.append(
            Edge(
                src=E.decision_node_id(assumed_by),
                rel="ASSUMES",
                dst=identifier,
                props={"at": "2026-02-02T08:30:00Z", "recorded_at": "2026-02-02T08:30:00Z"},
            )
        )
        for fact_id in facts:
            edges.append(
                Edge(
                    src=identifier,
                    rel="SUPPORTED_BY",
                    dst=fact_id,
                    props={
                        "at": "2026-02-02T08:30:00Z",
                        "recorded_at": "2026-02-02T08:30:00Z",
                        "note": "Supporting fact recorded at assumption creation.",
                    },
                )
            )
    return nodes, edges


def _fact_nodes() -> tuple[list[Node], list[Edge]]:
    nodes, edges = [], []
    for row in E.FACTS:
        (
            fact_identifier,
            subject,
            attribute,
            value,
            statement,
            valid_from,
            valid_to,
            recorded_at,
            confidence,
            verified,
            status,
            source_ref,
        ) = row
        subject_id_value = E.resolve_entity_id(subject)
        nodes.append(
            Node(
                id=fact_identifier,
                label="Fact",
                name=statement,
                props={
                    "subject_id": subject_id_value,
                    "subject_name": subject,
                    "attribute": attribute,
                    "value": value,
                    "statement": statement,
                    "valid_from": valid_from,
                    "valid_to": valid_to,
                    "recorded_at": recorded_at,
                    "recorded_to": None,
                    "confidence": confidence,
                    "verified": verified,
                    "status": status,
                    "review_status": "AUTO_ACCEPTED" if verified else "NEEDS_REVIEW",
                    "source_ref": source_ref,
                    "provenance_class": "verified" if verified else "unverified_claim",
                },
            )
        )
        edges.append(
            Edge(
                src=fact_identifier,
                rel="ABOUT",
                dst=subject_id_value,
                props={"at": recorded_at, "attribute": attribute},
            )
        )
    return nodes, edges


def _ownership_edges() -> list[Edge]:
    edges = []
    for holder, target in E.OWNERSHIP:
        target_id = E.resolve_entity_id(target)
        label = "System" if target_id.startswith("system:") else "Project"
        edges.append(
            Edge(
                src=E.person_node_id(holder),
                rel="OWNS",
                dst=target_id,
                props={
                    "at": "2025-06-01T00:00:00Z",
                    "ownership_type": "official",
                    "target_label": label,
                },
            )
        )
    return edges


def _usage_edges() -> list[Edge]:
    return [
        Edge(
            src=E.project_node_id(project),
            rel="USES",
            dst=E.system_node_id(system),
            props={"at": "2026-01-05T00:00:00Z", **props},
        )
        for project, system, props in E.SYSTEM_USAGE
    ]


def _source_nodes_and_edges() -> tuple[list[Node], list[Edge]]:
    """Turn the 60 source records into Message/Document nodes with provenance."""
    nodes: list[Node] = []
    edges: list[Edge] = []

    for record in S.ALL_SOURCES:
        kind = record["kind"]
        external_id = record["external_id"]
        if kind == "slack":
            identifier = message_id("slack", external_id)
            label = "Message"
            doc_type = None
        else:
            identifier = document_id(kind, external_id)
            label = "Document"
            doc_type = record.get("doc_type") or kind

        nodes.append(
            Node(
                id=identifier,
                label=label,
                name=f"{record.get('title') or external_id}",
                props={
                    "source_system": kind,
                    "external_id": external_id,
                    "doc_type": doc_type,
                    "title": record.get("title"),
                    "text": record.get("text"),
                    "channel": record.get("channel"),
                    "timestamp": record["timestamp"],
                    "recorded_at": record["timestamp"],
                    "source_ref": record.get("source_ref"),
                    "confidence": record.get("confidence", 0.8),
                    "status": record.get("status"),
                    "author_id": E.person_node_id(record["author"]),
                },
            )
        )

        author_id = E.person_node_id(record["author"])
        edges.append(
            Edge(
                src=author_id,
                rel="AUTHORED",
                dst=identifier,
                props={"at": record["timestamp"]},
            )
        )

        resolver = record.get("resolved")
        if resolver:
            edges.append(
                Edge(
                    src=E.person_node_id(resolver),
                    rel="RESOLVED",
                    dst=identifier,
                    props={"at": record["timestamp"], "status": record.get("status")},
                )
            )
            # A resolver discussing the ticket is also evidence they engaged with it.
            edges.append(
                Edge(
                    src=E.person_node_id(resolver),
                    rel="MENTIONS",
                    dst=identifier,
                    props={"at": record["timestamp"], "role": "resolver"},
                )
            )

        for entity_name in record.get("mentions", ()) or ():
            target_id = E.resolve_entity_id(entity_name)
            edges.append(
                Edge(
                    src=identifier,
                    rel="MENTIONS",
                    dst=target_id,
                    props={"at": record["timestamp"]},
                )
            )

        for fact_identifier in record.get("states", ()) or ():
            edges.append(
                Edge(
                    src=identifier,
                    rel="STATES",
                    dst=fact_identifier,
                    props={"at": record["timestamp"], "recorded_at": record["timestamp"]},
                )
            )

        for participant in record.get("participants", ()) or ():
            edges.append(
                Edge(
                    src=E.person_node_id(participant),
                    rel="MENTIONS",
                    dst=identifier,
                    props={"at": record["timestamp"], "role": "participant"},
                )
            )
    return nodes, edges


def build_subgraph() -> Subgraph:
    """Build the complete, deterministic Northwind Labs graph."""
    nodes: list[Node] = []
    edges: list[Edge] = []

    for builder in (
        _team_nodes,
        _person_nodes,
        _system_nodes,
        _project_nodes,
        _decision_nodes,
        _assumption_nodes,
        _fact_nodes,
        _source_nodes_and_edges,
    ):
        produced_nodes, produced_edges = builder()
        nodes.extend(produced_nodes)
        edges.extend(produced_edges)

    edges.extend(_ownership_edges())
    edges.extend(_usage_edges())

    # De-duplicate by identity: identical relationships built from two paths must
    # not be inserted twice.
    unique_edges: dict[tuple[str, str, str], Edge] = {}
    for edge in edges:
        unique_edges.setdefault(edge.key, edge)
    return Subgraph(nodes=nodes, edges=list(unique_edges.values()))


# --------------------------------------------------------------------------- #
# Demo scenarios
# --------------------------------------------------------------------------- #
#: Incoming events the demo can trigger.  Each is deterministic and needs no
#: network access, so the central demonstration works with no LLM credentials.
SCENARIOS: dict[str, dict[str, Any]] = {
    "frankfurt_compliance_revoked": {
        "description": (
            "The headline scenario: the Frankfurt partner's EU compliance certification is revoked "
            "by a verified internal compliance source. Tripwire must connect it to the data-residency "
            "assumption, trace the affected decisions and projects, show that the EU launch retains "
            "independent SOC 2 support (so it is only potentially affected), and confirm that the "
            "regulatory-eligibility decision has lost its only support."
        ),
        "fact": {
            "subject": "Frankfurt Hosting Partner",
            "subject_label": "System",
            "attribute": "compliance_status",
            "value": "revoked",
            "statement": (
                "Frankfurt Hosting Partner's EU compliance certification DE-CMP-4471 has been revoked "
                "by the issuing authority, effective immediately."
            ),
            "confidence": 0.93,
            "verified": True,
        },
        "source": {
            "kind": "slack",
            "external_id": "nw-slack-evt-001",
            "name": "Compliance alert: partner certification revoked",
            "channel": "#data-compliance",
            "author": "Aisha Khan",
            "timestamp": "2026-02-20T08:15:00Z",
            "source_ref": "slack:#data-compliance/2026-02-20",
            "text": (
                "The issuing authority has revoked Frankfurt Hosting Partner's EU compliance "
                "certification DE-CMP-4471. Their separate SOC 2 attestation is unaffected. "
                "I am flagging this for the launch review immediately."
            ),
        },
        "actor_id": E.person_node_id("Aisha Khan"),
        "recorded_at": "2026-02-20T08:15:00Z",
    },
    "frankfurt_compliance_revoked_unverified": {
        "description": (
            "The same revocation claim, but sourced from an unverified third-party post. Tripwire must "
            "record the conflict without treating it as established truth: the original fact is marked "
            "CONTESTED (not invalidated), its belief interval stays open and every impact stays potential."
        ),
        "fact": {
            "subject": "Frankfurt Hosting Partner",
            "subject_label": "System",
            "attribute": "compliance_status",
            "value": "revoked",
            "statement": (
                "An unverified forum post claims Frankfurt Hosting Partner's EU compliance "
                "certification was revoked."
            ),
            "confidence": 0.35,
            "verified": False,
        },
        "source": {
            "kind": "slack",
            "external_id": "nw-slack-evt-002",
            "name": "Screenshot circulating about partner certification",
            "channel": "#eu-launch",
            "author": "Tomás Silva",
            "timestamp": "2026-02-20T10:40:00Z",
            "source_ref": "slack:#eu-launch/2026-02-20",
            "text": (
                "Someone posted a screenshot claiming the partner's certification was revoked. "
                "Unverified - I could not find a primary source."
            ),
            "confidence": 0.35,
        },
        "actor_id": E.person_node_id("Tomás Silva"),
        "recorded_at": "2026-02-20T10:40:00Z",
    },
    "pricing_rate_renewal_2027": {
        "description": (
            "A new contracted rate covering 2027 onwards. This is succession rather than conflict: the "
            "earlier record's validity simply ends where the new one begins, so Tripwire must not raise "
            "a contradiction alert."
        ),
        "fact": {
            "subject": "Frankfurt Hosting Partner",
            "subject_label": "System",
            "attribute": "pricing",
            "value": "contracted_rate_hold_through_2028",
            "statement": "The contracted Frankfurt hosting rate is renewed and held through 2028.",
            "valid_from": "2027-01-01T00:00:00Z",
            "confidence": 0.88,
            "verified": True,
        },
        "source": {
            "kind": "slack",
            "external_id": "nw-slack-evt-003",
            "name": "Partner rate renewal for 2027",
            "channel": "#vendor-management",
            "author": "Lena Fischer",
            "timestamp": "2026-02-21T09:30:00Z",
            "source_ref": "slack:#vendor-management/2026-02-21",
            "text": "The partner rate is renewed and held through 2028, effective 1 January 2027.",
        },
        "actor_id": E.person_node_id("Lena Fischer"),
        "recorded_at": "2026-02-21T09:30:00Z",
    },
    "additive_edge_cache_provider": {
        "description": (
            "New information about a known subject that conflicts with nothing. Tripwire must classify it "
            "as additive and raise no alert - the restraint case."
        ),
        "fact": {
            "subject": "Edge Cache",
            "subject_label": "System",
            "attribute": "cdn_provider",
            "value": "fastly",
            "statement": "Edge Cache is fronted by a third-party CDN provider.",
            "confidence": 0.8,
            "verified": True,
        },
        "source": {
            "kind": "slack",
            "external_id": "nw-slack-evt-004",
            "name": "Edge Cache CDN provider noted",
            "channel": "#platform-eng",
            "author": "Daniel Osei",
            "timestamp": "2026-02-21T11:00:00Z",
            "source_ref": "slack:#platform-eng/2026-02-21",
            "text": "Adding a CDN provider note to the Edge Cache runbook.",
        },
        "actor_id": E.person_node_id("Daniel Osei"),
        "recorded_at": "2026-02-21T11:00:00Z",
    },
    "ambiguous_edge_cache_region": {
        "description": (
            "A claim about an attribute that existing records already disagree on. Tripwire must report "
            "the ambiguity and refuse to auto-resolve it, raising no alert."
        ),
        "fact": {
            "subject": "Edge Cache",
            "subject_label": "System",
            "attribute": "hosting_region",
            "value": "eu-west-1",
            "statement": "A third record claims the Edge Cache primary region is eu-west-1.",
            "confidence": 0.7,
            "verified": True,
        },
        "source": {
            "kind": "slack",
            "external_id": "nw-slack-evt-005",
            "name": "Third conflicting Edge Cache region claim",
            "channel": "#platform-eng",
            "author": "Daniel Osei",
            "timestamp": "2026-02-21T12:15:00Z",
            "source_ref": "slack:#platform-eng/2026-02-21",
            "text": "Another region claim for Edge Cache, this time eu-west-1. Records still disagree.",
            "confidence": 0.7,
        },
        "actor_id": E.person_node_id("Daniel Osei"),
        "recorded_at": "2026-02-21T12:15:00Z",
    },
    "unrelated_mobile_theme_change": {
        "description": (
            "A fact about a subject with no existing knowledge. Tripwire must report that it is unrelated "
            "to current knowledge and raise no alert."
        ),
        "fact": {
            "subject": "Mobile Redesign",
            "subject_label": "Project",
            "attribute": "theme_default",
            "value": "dark",
            "statement": "The mobile redesign will default new installs to dark mode.",
            "confidence": 0.8,
            "verified": True,
        },
        "source": {
            "kind": "slack",
            "external_id": "nw-slack-evt-006",
            "name": "Dark mode default confirmed",
            "channel": "#pricing",
            "author": "Sofia Marchetti",
            "timestamp": "2026-02-21T14:00:00Z",
            "source_ref": "slack:#pricing/2026-02-21",
            "text": "Confirming dark mode as the default for new mobile installs.",
        },
        "actor_id": E.person_node_id("Sofia Marchetti"),
        "recorded_at": "2026-02-21T14:00:00Z",
    },
}


def scenario_event(name: str) -> dict[str, Any]:
    """Return a fully-formed trigger-event specification for ``name``.

    Raises
    ------
    KeyError
        When the scenario is unknown; the engine converts this into a validation
        error listing the available scenarios.
    """
    if name not in SCENARIOS:
        raise KeyError(
            f"unknown scenario {name!r}; available scenarios: {', '.join(sorted(SCENARIOS))}"
        )
    scenario = SCENARIOS[name]
    return {
        "scenario": name,
        "description": scenario["description"],
        "fact": dict(scenario["fact"]),
        "source": dict(scenario["source"]),
        "actor_id": scenario.get("actor_id"),
        "recorded_at": scenario.get("recorded_at"),
    }


def scenario_names() -> Iterable[str]:
    """All available scenario names, sorted."""
    return sorted(SCENARIOS)
