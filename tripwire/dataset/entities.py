"""Northwind Labs entity definitions: people, teams, systems, projects, decisions,
assumptions and facts.

This module is **data only** - no behaviour, no random numbers, no clock reads.
Every value here is fixed, which is what makes the demo reproducible: seeding
twice produces byte-identical graph content.

The central storyline
---------------------
Northwind Labs plans an EU launch on an external Frankfurt hosting partner.  The
launch decision assumes EU data residency, which is supported by two *independent*
facts: the partner's EU compliance certification and a separate SOC 2 Type II
attestation.  A second decision (regulatory eligibility, under the data-governance
project) rests on the certification **alone**.

That asymmetry is deliberate and load-bearing:

* when the certification is revoked, the EU launch is **potentially** affected -
  the SOC 2 attestation survives, so the engine must show restraint;
* the regulatory-eligibility decision is **confirmed for review**, because nothing
  else supports it.

Unrelated decisions (APAC region migration, dark-mode default, warehouse
migration) exist so the test-suite can prove the engine leaves them alone.

Entities are also shaped to expose a *shadow org chart*: Jonas Berg, a senior
engineer, resolves the Frankfurt and EU tickets and authors the partner review
note, while official ownership sits with Priya Raman and Lena Fischer.
"""

from __future__ import annotations

from typing import Any

from ..core.ids import (
    assumption_id,
    decision_id,
    person_id,
    project_id,
    system_id,
    team_id,
)

# --------------------------------------------------------------------------- #
# Teams (4)
# --------------------------------------------------------------------------- #
TEAMS: tuple[tuple[str, dict[str, Any]], ...] = (
    ("Platform Engineering", {"focus": "Core platform, hosting and data ingestion", "cost_centre": "ENG-100"}),
    ("Data & Compliance", {"focus": "Data governance, residency and regulatory readiness", "cost_centre": "CMP-200"}),
    ("Growth & Monetisation", {"focus": "Pricing, packaging and new-market commercial models", "cost_centre": "GRW-300"}),
    ("Customer Operations", {"focus": "Support, vendor management and people operations", "cost_centre": "OPS-400"}),
)

# --------------------------------------------------------------------------- #
# People (12)
# --------------------------------------------------------------------------- #
#: ``(name, role, team, extra properties)``
PEOPLE: tuple[tuple[str, str, str, dict[str, Any]], ...] = (
    ("Priya Raman", "VP Engineering", "Platform Engineering", {"handle": "@priya", "location": "London", "tenure_years": 6}),
    # Jonas is the planted hidden expert: high contribution, mid-level title.
    ("Jonas Berg", "Senior Platform Engineer", "Platform Engineering", {"handle": "@jonas", "location": "Berlin", "tenure_years": 3}),
    ("Aisha Khan", "Head of Compliance", "Data & Compliance", {"handle": "@aisha", "location": "London", "tenure_years": 5}),
    ("Ahmed Osman", "Data Platform Lead", "Data & Compliance", {"handle": "@ahmed", "location": "Cairo", "tenure_years": 4}),
    ("Tomás Silva", "Product Manager, EU", "Growth & Monetisation", {"handle": "@tomas", "location": "Lisbon", "tenure_years": 2}),
    ("Sofia Marchetti", "Pricing Manager", "Growth & Monetisation", {"handle": "@sofia", "location": "Milan", "tenure_years": 3}),
    ("Marcus Webb", "Chief Technology Officer", "Growth & Monetisation", {"handle": "@marcus", "location": "London", "tenure_years": 8}),
    ("Elena Novak", "Support Lead", "Customer Operations", {"handle": "@elena", "location": "Prague", "tenure_years": 5}),
    ("Yuki Tanaka", "People Operations Lead", "Customer Operations", {"handle": "@yuki", "location": "Osaka", "tenure_years": 4}),
    ("Daniel Osei", "Site Reliability Engineer", "Platform Engineering", {"handle": "@daniel", "location": "Accra", "tenure_years": 2}),
    ("Raj Patel", "Billing Engineer", "Platform Engineering", {"handle": "@raj", "location": "Manchester", "tenure_years": 3}),
    ("Lena Fischer", "Vendor Manager", "Customer Operations", {"handle": "@lena", "location": "Munich", "tenure_years": 7}),
)

# --------------------------------------------------------------------------- #
# Systems (8)
# --------------------------------------------------------------------------- #
SYSTEMS: tuple[tuple[str, dict[str, Any]], ...] = (
    ("Frankfurt Hosting Partner", {"system_type": "external_partner", "region": "eu-central", "criticality": "tier-1"}),
    ("EU Data Residency Controls", {"system_type": "internal_control", "region": "eu-central", "criticality": "tier-1"}),
    ("Northwind Ingest Pipeline", {"system_type": "internal_service", "region": "multi", "criticality": "tier-1"}),
    ("Billing Service", {"system_type": "internal_service", "region": "multi", "criticality": "tier-1"}),
    ("Identity Gateway", {"system_type": "internal_service", "region": "multi", "criticality": "tier-2"}),
    ("Reporting Warehouse", {"system_type": "internal_service", "region": "multi", "criticality": "tier-2"}),
    ("Edge Cache", {"system_type": "internal_service", "region": "multi", "criticality": "tier-2"}),
    ("Notification Bus", {"system_type": "internal_service", "region": "multi", "criticality": "tier-3"}),
)

# --------------------------------------------------------------------------- #
# Projects (6)
# --------------------------------------------------------------------------- #
PROJECTS: tuple[tuple[str, dict[str, Any]], ...] = (
    ("EU Launch", {"status": "ACTIVE", "target_date": "2026-06-30", "owner_role": "VP Engineering"}),
    ("Pricing v2", {"status": "ACTIVE", "target_date": "2026-07-31", "owner_role": "Product Manager, EU"}),
    ("Q3 Hiring Plan", {"status": "ACTIVE", "target_date": "2026-09-30", "owner_role": "Support Lead"}),
    ("APAC Expansion", {"status": "ACTIVE", "target_date": "2026-11-30", "owner_role": "Chief Technology Officer"}),
    ("Data Governance Overhaul", {"status": "ACTIVE", "target_date": "2026-08-15", "owner_role": "Head of Compliance"}),
    ("Mobile Redesign", {"status": "ACTIVE", "target_date": "2026-10-31", "owner_role": "Pricing Manager"}),
)

# --------------------------------------------------------------------------- #
# Systems and projects used by the central decisions
# --------------------------------------------------------------------------- #
SYSTEM_USAGE: tuple[tuple[str, str, dict[str, Any]], ...] = (
    ("EU Launch", "Frankfurt Hosting Partner", {"role": "primary hosting"}),
    ("EU Launch", "EU Data Residency Controls", {"role": "residency enforcement"}),
    ("EU Launch", "Northwind Ingest Pipeline", {"role": "EU tenant onboarding"}),
    ("Pricing v2", "Billing Service", {"role": "price book execution"}),
    ("Data Governance Overhaul", "EU Data Residency Controls", {"role": "control ownership"}),
    ("APAC Expansion", "Reporting Warehouse", {"role": "regional reporting"}),
    ("Mobile Redesign", "Edge Cache", {"role": "asset delivery"}),
    ("Q3 Hiring Plan", "Identity Gateway", {"role": "onboarding access"}),
)

# --------------------------------------------------------------------------- #
# Decisions (7) - four connected, three deliberately unrelated
# --------------------------------------------------------------------------- #
#: ``(key, name, statement, maker, status, impacts_project, depends_on_decision_key)``
DECISIONS: tuple[tuple[str, str, str, str, str, str | None, str | None], ...] = (
    (
        "eu-launch",
        "Launch Northwind in the EU on the Frankfurt hosting partner",
        "Proceed with the EU launch using the Frankfurt hosting partner as the primary "
        "hosting provider for EU customer data.",
        "Priya Raman",
        "ACTIVE",
        "EU Launch",
        None,
    ),
    (
        "pricing-eu",
        "Adopt the EU pricing tier aligned to the Frankfurt cost base",
        "Ship the EU pricing tier priced against the contracted Frankfurt hosting cost base.",
        "Tomás Silva",
        "ACTIVE",
        "Pricing v2",
        "eu-launch",
    ),
    (
        "hiring-eu-support",
        "Hire six EU support engineers in Q3",
        "Fund six EU support engineer hires to cover the launch, gated on the EU launch proceeding.",
        "Elena Novak",
        "ACTIVE",
        "Q3 Hiring Plan",
        "eu-launch",
    ),
    (
        "legal-signoff-eu",
        "Rely on the partner's EU certification for regulatory sign-off",
        "Use the Frankfurt partner's EU compliance certification as the sole basis for "
        "regulatory eligibility sign-off with EU regulated-sector customers.",
        "Aisha Khan",
        "ACTIVE",
        "Data Governance Overhaul",
        None,
    ),
    (
        "apac-datacentre",
        "Move APAC workloads to the Singapore region",
        "Relocate APAC production workloads to the Singapore region.",
        "Marcus Webb",
        "ACTIVE",
        "APAC Expansion",
        None,
    ),
    (
        "dark-mode-default",
        "Default the mobile app to dark mode",
        "Make dark mode the default theme for new mobile installs.",
        "Sofia Marchetti",
        "ACTIVE",
        "Mobile Redesign",
        None,
    ),
    (
        "warehouse-regional-split",
        "Split reporting by region in the warehouse",
        "Partition the reporting warehouse by region to support the APAC migration.",
        "Ahmed Osman",
        "ACTIVE",
        "APAC Expansion",
        "apac-datacentre",
    ),
)

# --------------------------------------------------------------------------- #
# Assumptions (4)
# --------------------------------------------------------------------------- #
#: ``(key, name, statement, assumed_by_decision_key, supporting_fact_ids)``
ASSUMPTIONS: tuple[tuple[str, str, str, str, tuple[str, ...]], ...] = (
    (
        "data-residency-eu",
        "EU data residency is contractually enforceable in Frankfurt",
        "EU customer data can be stored and processed exclusively in Frankfurt because the "
        "partner's EU compliance certification is valid in the launch window.",
        "eu-launch",
        ("fact:frankfurt-partner-compliance-valid", "fact:frankfurt-partner-soc2-attestation-valid"),
    ),
    (
        "eu-regulatory-eligibility",
        "Regulatory eligibility rests on the partner's certification being current",
        "Northwind remains eligible to serve EU regulated-sector customers because the "
        "partner's EU compliance certification is current.",
        "legal-signoff-eu",
        ("fact:frankfurt-partner-compliance-valid",),
    ),
    (
        "eu-cost-base",
        "EU hosting unit costs stay at the contracted rate",
        "EU hosting unit costs remain at the contracted Frankfurt rate through 2027.",
        "pricing-eu",
        ("fact:frankfurt-partner-rate-hold",),
    ),
    (
        "apac-region-approval",
        "The Singapore region is approved for APAC production",
        "The Singapore region satisfies the latency and residency requirements for APAC.",
        "apac-datacentre",
        ("fact:apac-singapore-region-approved",),
    ),
)

# --------------------------------------------------------------------------- #
# Facts (13)
# --------------------------------------------------------------------------- #
#: ``(id, subject, attribute, value, statement, valid_from, valid_to, recorded_at,
#:    confidence, verified, status, source_ref)``
FACTS: tuple[tuple[Any, ...], ...] = (
    (
        "fact:frankfurt-partner-compliance-valid",
        "Frankfurt Hosting Partner",
        "compliance_status",
        "valid",
        "Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), "
        "verified on 2026-01-12.",
        "2025-04-01T00:00:00Z",
        None,
        "2026-01-12T10:05:00Z",
        0.95,
        True,
        "ACTIVE",
        "slack:#data-compliance/2026-01-12",
    ),
    (
        "fact:frankfurt-partner-soc2-attestation-valid",
        "Frankfurt Hosting Partner",
        "certification_status",
        "soc2_type_ii_valid",
        "Frankfurt Hosting Partner's independent SOC 2 Type II attestation is valid to "
        "2027-03-31.",
        "2026-01-20T00:00:00Z",
        "2027-03-31T00:00:00Z",
        "2026-01-20T14:30:00Z",
        0.90,
        True,
        "ACTIVE",
        "prd:NWL-PRD-002",
    ),
    (
        "fact:frankfurt-partner-rate-hold",
        "Frankfurt Hosting Partner",
        "pricing",
        "contracted_rate_hold_through_2027",
        "The contracted Frankfurt hosting rate is held until 2027 under the current insert.",
        "2026-02-01T00:00:00Z",
        "2027-01-01T00:00:00Z",
        "2026-02-01T09:00:00Z",
        0.85,
        True,
        "ACTIVE",
        "slack:#pricing/2026-02-01",
    ),
    (
        "fact:frankfurt-partner-dr-test-passed",
        "Frankfurt Hosting Partner",
        "dr_resilience",
        "4h_rto_verified",
        "The partner's disaster-recovery test passed with a four-hour recovery-time objective.",
        "2026-02-10T00:00:00Z",
        None,
        "2026-02-10T16:40:00Z",
        0.80,
        True,
        "ACTIVE",
        "ticket:NWL-2331",
    ),
    (
        "fact:frankfurt-partner-audit-clean",
        "Frankfurt Hosting Partner",
        "audit_result",
        "clean",
        "The partner's annual security audit returned no material findings.",
        "2026-01-30T00:00:00Z",
        None,
        "2026-01-30T11:15:00Z",
        0.82,
        True,
        "ACTIVE",
        "ticket:NWL-2288",
    ),
    (
        "fact:frankfurt-partner-contract-status",
        "Frankfurt Hosting Partner",
        "contract_status",
        "active",
        "The hosting services agreement with Frankfurt Hosting Partner is active and signed.",
        "2025-04-01T00:00:00Z",
        "2027-03-31T00:00:00Z",
        "2026-01-15T12:00:00Z",
        0.93,
        True,
        "ACTIVE",
        "slack:#vendor-management/2026-01-15",
    ),
    (
        "fact:eu-residency-controls-implemented",
        "EU Data Residency Controls",
        "deployment_status",
        "implemented",
        "EU data-residency controls are implemented and enforcing region pinning.",
        "2026-02-05T00:00:00Z",
        None,
        "2026-02-05T15:20:00Z",
        0.88,
        True,
        "ACTIVE",
        "ticket:NWL-2302",
    ),
    (
        "fact:ingest-pipeline-tenant-isolation",
        "Northwind Ingest Pipeline",
        "tenant_isolation",
        "region_pinned",
        "The ingest pipeline pins EU tenants to the Frankfurt region.",
        "2026-02-08T00:00:00Z",
        None,
        "2026-02-08T09:45:00Z",
        0.86,
        True,
        "ACTIVE",
        "slack:#platform-eng/2026-02-08",
    ),
    (
        "fact:billing-service-latency-slo",
        "Billing Service",
        "latency_slo",
        "120ms p95",
        "The Billing Service p95 latency objective is 120 ms.",
        "2026-01-28T00:00:00Z",
        None,
        "2026-01-28T10:00:00Z",
        0.80,
        True,
        "ACTIVE",
        "slack:#platform-eng/2026-01-28",
    ),
    (
        "fact:apac-singapore-region-approved",
        "Reporting Warehouse",
        "hosting_region",
        "ap-southeast-1",
        "The Singapore region is approved for APAC reporting workloads.",
        "2026-02-14T00:00:00Z",
        None,
        "2026-02-14T13:30:00Z",
        0.84,
        True,
        "ACTIVE",
        "ticket:NWL-2320",
    ),
    (
        "fact:eu-launch-target-date",
        "EU Launch",
        "target_date",
        "2026-06-30",
        "The EU launch target date is 30 June 2026.",
        "2026-02-02T00:00:00Z",
        None,
        "2026-02-02T08:30:00Z",
        0.90,
        True,
        "ACTIVE",
        "prd:NWL-PRD-001",
    ),
    # Deliberate prior ambiguity about the Edge Cache region: two live records
    # disagree, so a new claim about it must be reported as ambiguous rather than
    # being auto-resolved.
    (
        "fact:edge-cache-region-eu",
        "Edge Cache",
        "hosting_region",
        "eu-central-1",
        "The Edge Cache primary region is recorded as eu-central-1 after the migration.",
        "2026-01-05T00:00:00Z",
        None,
        "2026-01-05T09:00:00Z",
        0.70,
        True,
        "ACTIVE",
        "slack:#platform-eng/2026-01-05",
    ),
    (
        "fact:edge-cache-region-us",
        "Edge Cache",
        "hosting_region",
        "us-east-1",
        "A second record states the Edge Cache primary region as us-east-1 pending cleanup.",
        "2026-01-06T00:00:00Z",
        None,
        "2026-01-06T11:00:00Z",
        0.62,
        False,
        "ACTIVE",
        "slack:#platform-eng/2026-01-06",
    ),
)

# --------------------------------------------------------------------------- #
# Ownership (official ownership, deliberately separate from contribution)
# --------------------------------------------------------------------------- #
OWNERSHIP: tuple[tuple[str, str], ...] = (
    ("Priya Raman", "EU Launch"),
    ("Priya Raman", "Northwind Ingest Pipeline"),
    ("Aisha Khan", "EU Data Residency Controls"),
    ("Aisha Khan", "Data Governance Overhaul"),
    ("Ahmed Osman", "Reporting Warehouse"),
    ("Tomás Silva", "Pricing v2"),
    ("Elena Novak", "Q3 Hiring Plan"),
    ("Marcus Webb", "APAC Expansion"),
    ("Sofia Marchetti", "Mobile Redesign"),
    ("Raj Patel", "Billing Service"),
    ("Daniel Osei", "Edge Cache"),
    ("Daniel Osei", "Notification Bus"),
    # The Frankfurt partner relationship is owned by the vendor manager, while the
    # engineering contribution comes from someone else entirely.
    ("Lena Fischer", "Frankfurt Hosting Partner"),
)


# --------------------------------------------------------------------------- #
# Id helpers (kept in one place so builders and tests agree)
# --------------------------------------------------------------------------- #
def team_node_id(name: str) -> str:
    """Stable team id."""
    return team_id(name)


def person_node_id(name: str) -> str:
    """Stable person id."""
    return person_id(name)


def system_node_id(name: str) -> str:
    """Stable system id."""
    return system_id(name)


def project_node_id(name: str) -> str:
    """Stable project id."""
    return project_id(name)


def decision_node_id(key: str) -> str:
    """Stable decision id."""
    return decision_id(key)


def assumption_node_id(key: str) -> str:
    """Stable assumption id."""
    return assumption_id(key)


def resolve_entity_id(name: str) -> str:
    """Resolve a dataset entity name to its node id (used by source records)."""
    for label_lookup, builder in (
        ((name for name, _ in TEAMS), team_node_id),
        ((name for name, *_ in PEOPLE), person_node_id),
        ((name for name, _ in SYSTEMS), system_node_id),
        ((name for name, _ in PROJECTS), project_node_id),
    ):
        if name in set(label_lookup):
            return builder(name)
    for key, display, *_ in DECISIONS:
        if name in (key, display):
            return decision_node_id(key)
    return f"system:{name.lower().replace(' ', '-')}"
