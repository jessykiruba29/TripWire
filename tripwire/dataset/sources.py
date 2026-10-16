"""Northwind Labs source artifacts: the raw records knowledge is extracted from.

Exactly 40 Slack messages, 15 tickets, 3 PRDs and 2 meeting notes (spec S13).

These are the *documented adapter input shapes* (spec S5): no live Slack or Jira
integration exists in this environment, so each record is a faithful, self-describing
source record - id, author, timestamp, channel, and the entity/fact references it
evidences.  ``mentions`` and ``states`` are explicit rather than NLP-guessed, which
keeps the seeded graph deterministic and means every claimed dependency in the
demo is traceable to a real record.

Deliberate design points
------------------------
* Jonas Berg authors the partner quarterly review note and resolves five of the
  Frankfurt/EU tickets - the evidence behind the planted hidden expert.
* The unrelated streams (``#apac``, dark-mode, warehouse split) are genuinely
  disconnected from the EU/Frankfurt chain, so tests can prove the engine leaves
  them alone.
* Every fact in :mod:`tripwire.dataset.entities` is stated by at least one of
  these records, so no fact floats without provenance.
"""

from __future__ import annotations

from typing import Any


def _slack(
    number: int,
    channel: str,
    author: str,
    timestamp: str,
    text: str,
    mentions: tuple[str, ...] = (),
    states: tuple[str, ...] = (),
    confidence: float = 0.80,
) -> dict[str, Any]:
    """Build one Slack source record."""
    return {
        "kind": "slack",
        "external_id": f"nw-slack-{number:03d}",
        "channel": channel,
        "title": text[:70],
        "text": text,
        "author": author,
        "timestamp": timestamp,
        "mentions": list(mentions),
        "states": list(states),
        "confidence": confidence,
        "source_ref": f"slack:{channel}/{timestamp[:10]}",
    }


def _ticket(
    number: int,
    summary: str,
    description: str,
    reporter: str,
    resolver: str,
    timestamp: str,
    mentions: tuple[str, ...] = (),
    states: tuple[str, ...] = (),
    status: str = "done",
    confidence: float = 0.85,
) -> dict[str, Any]:
    """Build one ticket source record."""
    return {
        "kind": "ticket",
        "external_id": f"NWL-{number}",
        "doc_type": "ticket",
        "title": summary,
        "text": description,
        "author": reporter,
        "resolved": resolver,
        "timestamp": timestamp,
        "mentions": list(mentions),
        "states": list(states),
        "status": status,
        "confidence": confidence,
        "source_ref": f"ticket:NWL-{number}",
    }


def _document(
    external_id: str,
    doc_type: str,
    title: str,
    text: str,
    author: str,
    timestamp: str,
    mentions: tuple[str, ...] = (),
    states: tuple[str, ...] = (),
    participants: tuple[str, ...] = (),
    confidence: float = 0.90,
) -> dict[str, Any]:
    """Build one PRD or meeting-note source record."""
    return {
        "kind": doc_type,
        "external_id": external_id,
        "doc_type": doc_type,
        "title": title,
        "text": text,
        "author": author,
        "timestamp": timestamp,
        "mentions": list(mentions),
        "states": list(states),
        "participants": list(participants),
        "confidence": confidence,
        "source_ref": f"{doc_type}:{external_id}",
    }


# --------------------------------------------------------------------------- #
# Slack (40)
# --------------------------------------------------------------------------- #
SLACK: tuple[dict[str, Any], ...] = (
    # -- #eu-launch (8) ----------------------------------------------------
    _slack(1, "#eu-launch", "Priya Raman", "2026-02-02T08:30:00Z",
           "Kicking off the EU launch workstream. Target date is 30 June 2026 and Frankfurt is our primary hosting partner.",
           ("EU Launch", "Frankfurt Hosting Partner", "Priya Raman"), ("fact:eu-launch-target-date",)),
    _slack(2, "#eu-launch", "Tomás Silva", "2026-02-02T09:05:00Z",
           "Pricing needs the contracted Frankfurt cost base confirmed before we can publish the EU tier.",
           ("EU Launch", "Frankfurt Hosting Partner", "Pricing v2"), ("fact:frankfurt-partner-rate-hold",)),
    _slack(3, "#eu-launch", "Jonas Berg", "2026-02-03T07:45:00Z",
           "Tenant onboarding for EU is going to need the ingest pipeline pinned to Frankfurt, otherwise residency is unenforceable.",
           ("EU Launch", "Northwind Ingest Pipeline", "EU Data Residency Controls"), ("fact:ingest-pipeline-tenant-isolation",), 0.85),
    _slack(4, "#eu-launch", "Aisha Khan", "2026-02-03T10:12:00Z",
           "Compliance position: EU customer data must stay in Frankfurt. That depends on the partner's certification staying valid.",
           ("EU Launch", "Frankfurt Hosting Partner", "EU Data Residency Controls"), ("fact:frankfurt-partner-compliance-valid",), 0.88),
    _slack(5, "#eu-launch", "Elena Novak", "2026-02-04T11:20:00Z",
           "Support cannot absorb the EU launch with the current rota. I will bring a hiring proposal gated on the launch going ahead.",
           ("EU Launch", "Q3 Hiring Plan", "Elena Novak")),
    _slack(6, "#eu-launch", "Jonas Berg", "2026-02-05T13:02:00Z",
           "Ran a dry-run of the EU onboarding path against Frankfurt. Region pinning holds, but the residency controls need sign-off.",
           ("EU Launch", "EU Data Residency Controls", "Frankfurt Hosting Partner"), (), 0.82),
    _slack(7, "#eu-launch", "Priya Raman", "2026-02-06T16:40:00Z",
           "Decision recorded: we proceed with the EU launch on Frankfurt. Full reasoning is in the launch PRD.",
           ("EU Launch", "Frankfurt Hosting Partner", "Priya Raman")),
    _slack(8, "#eu-launch", "Jonas Berg", "2026-02-11T17:10:00Z",
           "Go/no-go notes are written up. Main open risk is the certification renewal timing, everything else is green.",
           ("EU Launch", "Frankfurt Hosting Partner", "Data Governance Overhaul"), (), 0.84),
    # -- #data-compliance (6) ----------------------------------------------
    _slack(9, "#data-compliance", "Aisha Khan", "2026-01-12T10:05:00Z",
           "Verified the partner's EU compliance certification DE-CMP-4471 as current. Recording it as our residency basis.",
           ("Frankfurt Hosting Partner", "EU Data Residency Controls", "Aisha Khan"), ("fact:frankfurt-partner-compliance-valid",), 0.95),
    _slack(10, "#data-compliance", "Ahmed Osman", "2026-01-13T09:30:00Z",
           "Residency controls will enforce region pinning at the warehouse layer. Starting the implementation ticket today.",
           ("EU Data Residency Controls", "Reporting Warehouse")),
    _slack(11, "#data-compliance", "Jonas Berg", "2026-01-20T14:30:00Z",
           "Partner shared the SOC 2 Type II attestation, valid to March 2027. Filing it alongside the certification.",
           ("Frankfurt Hosting Partner", "EU Data Residency Controls"), ("fact:frankfurt-partner-soc2-attestation-valid",), 0.90),
    _slack(12, "#data-compliance", "Aisha Khan", "2026-01-21T08:15:00Z",
           "Important nuance: the SOC 2 attestation and the EU certification are separate documents with separate renewal cycles.",
           ("Frankfurt Hosting Partner", "EU Data Residency Controls")),
    _slack(13, "#data-compliance", "Ahmed Osman", "2026-02-05T15:20:00Z",
           "EU data-residency controls are implemented and enforcing region pinning across ingest and warehouse.",
           ("EU Data Residency Controls", "Northwind Ingest Pipeline"), ("fact:eu-residency-controls-implemented",), 0.88),
    _slack(14, "#data-compliance", "Aisha Khan", "2026-02-19T09:40:00Z",
           "Reminder for the launch readiness review: regulated-sector eligibility is currently resting on the partner certification alone.",
           ("EU Launch", "Frankfurt Hosting Partner", "Data Governance Overhaul")),
    # -- #platform-eng (8) -------------------------------------------------
    _slack(15, "#platform-eng", "Daniel Osei", "2026-01-05T09:00:00Z",
           "Edge Cache primary region is eu-central-1 after last week's migration. Updating the runbook.",
           ("Edge Cache",), ("fact:edge-cache-region-eu",), 0.70),
    _slack(16, "#platform-eng", "Daniel Osei", "2026-01-06T11:00:00Z",
           "There is still an old record claiming Edge Cache runs in us-east-1. I think that is stale but cannot confirm yet.",
           ("Edge Cache",), ("fact:edge-cache-region-us",), 0.62),
    _slack(17, "#platform-eng", "Jonas Berg", "2026-01-22T10:45:00Z",
           "Ingest pipeline needs region-pinned routing for EU tenants. Drafting the change now.",
           ("Northwind Ingest Pipeline", "EU Data Residency Controls", "EU Launch")),
    _slack(18, "#platform-eng", "Raj Patel", "2026-01-28T10:00:00Z",
           "Billing Service p95 is holding at 120 ms against the new objective. SLO stays as documented.",
           ("Billing Service", "Pricing v2"), ("fact:billing-service-latency-slo",), 0.80),
    _slack(19, "#platform-eng", "Jonas Berg", "2026-02-08T09:45:00Z",
           "Confirmed the ingest pipeline pins EU tenants to Frankfurt. That closes the residency enforcement gap for launch.",
           ("Northwind Ingest Pipeline", "EU Launch", "Frankfurt Hosting Partner"), ("fact:ingest-pipeline-tenant-isolation",), 0.86),
    _slack(20, "#platform-eng", "Daniel Osei", "2026-02-09T14:10:00Z",
           "Notification Bus is dropping ordering guarantees under load. Filing a ticket rather than papering over it.",
           ("Notification Bus",)),
    _slack(21, "#platform-eng", "Priya Raman", "2026-02-10T08:05:00Z",
           "Ingest pipeline is the critical path for the EU launch. Anything that touches it gets priority review.",
           ("Northwind Ingest Pipeline", "EU Launch", "Priya Raman")),
    _slack(22, "#platform-eng", "Jonas Berg", "2026-02-13T11:30:00Z",
           "Identity Gateway onboarding for EU staff is ready. Only the region-pinning check remains for the hiring ramp.",
           ("Identity Gateway", "Q3 Hiring Plan")),
    # -- #pricing (4) ------------------------------------------------------
    _slack(23, "#pricing", "Tomás Silva", "2026-02-01T09:00:00Z",
           "Contract insert holds the Frankfurt rate through 2027. That is the cost base for the EU tier.",
           ("Pricing v2", "Frankfurt Hosting Partner", "Billing Service"), ("fact:frankfurt-partner-rate-hold",), 0.85),
    _slack(24, "#pricing", "Sofia Marchetti", "2026-02-01T13:25:00Z",
           "If the Frankfurt cost base moves, the EU tier economics change materially. Keep the dependency explicit in the PRD.",
           ("Pricing v2", "Frankfurt Hosting Partner")),
    _slack(25, "#pricing", "Tomás Silva", "2026-02-04T15:00:00Z",
           "Pricing v2 decision recorded: EU tier priced against the contracted Frankfurt cost base.",
           ("Pricing v2", "Frankfurt Hosting Partner", "Tomás Silva")),
    _slack(26, "#pricing", "Sofia Marchetti", "2026-02-12T10:20:00Z",
           "Dark mode is a separate scope for the mobile redesign and does not touch EU pricing.",
           ("Mobile Redesign", "Sofia Marchetti")),
    # -- #support (4) ------------------------------------------------------
    _slack(27, "#support", "Elena Novak", "2026-02-04T11:40:00Z",
           "EU launch will need six additional support engineers. Proposal depends on the launch decision.",
           ("Q3 Hiring Plan", "EU Launch", "Elena Novak")),
    _slack(28, "#support", "Jonas Berg", "2026-02-07T09:15:00Z",
           "Documented the escalation path for EU residency incidents and handed it to support.",
           ("EU Data Residency Controls", "EU Launch")),
    _slack(29, "#support", "Elena Novak", "2026-02-08T12:00:00Z",
           "Support runbook for EU residency questions is live. Jonas did most of the drafting.",
           ("EU Data Residency Controls", "Jonas Berg", "EU Launch")),
    _slack(30, "#support", "Yuki Tanaka", "2026-02-09T08:50:00Z",
           "Headcount approval for the EU hires is in the Q3 plan and gated on the launch proceeding.",
           ("Q3 Hiring Plan", "EU Launch", "Yuki Tanaka")),
    # -- #apac (3) ---------------------------------------------------------
    _slack(31, "#apac", "Marcus Webb", "2026-02-14T13:30:00Z",
           "Approved the Singapore region for APAC production. Reporting workloads move first.",
           ("APAC Expansion", "Reporting Warehouse", "Marcus Webb"), ("fact:apac-singapore-region-approved",), 0.84),
    _slack(32, "#apac", "Ahmed Osman", "2026-02-15T10:05:00Z",
           "Splitting the reporting warehouse by region to support the APAC move. Separate track from EU work.",
           ("APAC Expansion", "Reporting Warehouse")),
    _slack(33, "#apac", "Marcus Webb", "2026-02-16T09:20:00Z",
           "APAC expansion has its own timeline and is deliberately not gated on the EU programme.",
           ("APAC Expansion", "EU Launch")),
    # -- #vendor-management (4) -------------------------------------------
    _slack(34, "#vendor-management", "Lena Fischer", "2026-01-15T12:00:00Z",
           "Hosting agreement with Frankfurt Hosting Partner is signed and active through March 2027.",
           ("Frankfurt Hosting Partner", "Lena Fischer"), ("fact:frankfurt-partner-contract-status",), 0.93),
    _slack(35, "#vendor-management", "Lena Fischer", "2026-01-29T14:00:00Z",
           "Partner annual security audit came back clean with no material findings.",
           ("Frankfurt Hosting Partner",), ("fact:frankfurt-partner-audit-clean",), 0.82),
    _slack(36, "#vendor-management", "Jonas Berg", "2026-02-10T16:40:00Z",
           "Partner DR test passed with a four-hour RTO. Recording it against the launch readiness checklist.",
           ("Frankfurt Hosting Partner", "EU Launch"), ("fact:frankfurt-partner-dr-test-passed",), 0.80),
    _slack(37, "#vendor-management", "Lena Fischer", "2026-02-17T10:30:00Z",
           "Quarterly partner review is Thursday. Jonas, please present the technical readiness summary.",
           ("Frankfurt Hosting Partner", "Jonas Berg", "EU Launch")),
    # -- #incidents (3) ----------------------------------------------------
    _slack(38, "#incidents", "Daniel Osei", "2026-02-18T07:55:00Z",
           "Frankfurt partner reported a load-balancer failover this morning. No EU customer impact recorded.",
           ("Frankfurt Hosting Partner", "EU Launch")),
    _slack(39, "#incidents", "Jonas Berg", "2026-02-18T09:10:00Z",
           "Failover traced to a partner-side certificate rotation. Residency posture unchanged.",
           ("Frankfurt Hosting Partner", "EU Data Residency Controls")),
    _slack(40, "#incidents", "Raj Patel", "2026-02-18T15:30:00Z",
           "Billing retries during the failover were absorbed without duplicate charges. No action needed.",
           ("Billing Service",)),
)

# --------------------------------------------------------------------------- #
# Tickets (15)
# --------------------------------------------------------------------------- #
TICKETS: tuple[dict[str, Any], ...] = (
    # Jonas resolves 5 tickets touching the Frankfurt/EU chain (hidden expert).
    _ticket(2276, "EU tenant onboarding fails when region pinning is enforced",
            "Onboarding EU tenants while enforcing Frankfurt region pinning rejects the tenant on the first write.",
            "Tomás Silva", "Jonas Berg", "2026-01-23T09:15:00Z",
            ("Northwind Ingest Pipeline", "EU Launch", "EU Data Residency Controls"), (), "done", 0.88),
    _ticket(2284, "Residency check does not cover the warehouse read path",
            "The residency enforcement check covers ingest but not warehouse reads, so EU data can be read cross-region.",
            "Aisha Khan", "Jonas Berg", "2026-01-27T11:00:00Z",
            ("EU Data Residency Controls", "EU Launch", "Reporting Warehouse"), (), "done", 0.90),
    _ticket(2288, "Collect partner annual security audit evidence",
            "Request the partner's annual security audit findings for the launch readiness pack.",
            "Aisha Khan", "Aisha Khan", "2026-01-30T11:15:00Z",
            ("Frankfurt Hosting Partner", "EU Launch"), ("fact:frankfurt-partner-audit-clean",), "done", 0.82),
    _ticket(2296, "Frankfurt failover drill does not exercise EU onboarding",
            "The quarterly failover drill skips the EU onboarding path, so launch readiness is not actually evidenced.",
            "Elena Novak", "Jonas Berg", "2026-02-03T14:00:00Z",
            ("Frankfurt Hosting Partner", "EU Launch"), (), "done", 0.86),
    _ticket(2302, "Implement EU data-residency controls",
            "Implement region pinning and enforcement evidence for EU data residency across ingest and warehouse.",
            "Aisha Khan", "Ahmed Osman", "2026-02-05T15:20:00Z",
            ("EU Data Residency Controls", "EU Launch"), ("fact:eu-residency-controls-implemented",), "done", 0.88),
    _ticket(2308, "EU pricing tier needs the contracted cost base wired in",
            "Wire the contracted Frankfurt rate into the EU price book so tier economics track the contract.",
            "Sofia Marchetti", "Raj Patel", "2026-02-02T10:40:00Z",
            ("Pricing v2", "Billing Service", "Frankfurt Hosting Partner"), (), "done", 0.84),
    _ticket(2312, "Ingest pipeline cross-region retry breaks residency guarantee",
            "A cross-region retry path in the ingest pipeline can write EU tenant data outside Frankfurt.",
            "Jonas Berg", "Jonas Berg", "2026-02-08T09:45:00Z",
            ("Northwind Ingest Pipeline", "EU Data Residency Controls", "EU Launch"),
            ("fact:ingest-pipeline-tenant-isolation",), "done", 0.87),
    _ticket(2316, "Edge Cache runbook still references us-east-1",
            "The Edge Cache runbook claims us-east-1 as primary, which conflicts with the post-migration reality.",
            "Daniel Osei", "Daniel Osei", "2026-01-07T09:20:00Z",
            ("Edge Cache",), (), "open", 0.65),
    _ticket(2320, "Approve Singapore region for APAC reporting",
            "Request approval for the Singapore region to host APAC reporting workloads.",
            "Marcus Webb", "Ahmed Osman", "2026-02-14T13:30:00Z",
            ("Reporting Warehouse", "APAC Expansion"), ("fact:apac-singapore-region-approved",), "done", 0.84),
    _ticket(2324, "Notification Bus ordering guarantee regression",
            "Ordering guarantees are not held under sustained load; downstream consumers observe out-of-order delivery.",
            "Daniel Osei", "Daniel Osei", "2026-02-09T14:30:00Z",
            ("Notification Bus",), (), "in_progress", 0.70),
    _ticket(2328, "EU launch readiness checklist",
            "Consolidate the go/no-go checklist for the EU launch, including residency, capacity and support coverage.",
            "Priya Raman", "Jonas Berg", "2026-02-11T17:00:00Z",
            ("EU Launch", "Frankfurt Hosting Partner", "EU Data Residency Controls"), (), "done", 0.90),
    _ticket(2331, "Run partner disaster-recovery test and record the RTO",
            "Execute the partner DR test and record the achieved recovery-time objective for the readiness pack.",
            "Lena Fischer", "Daniel Osei", "2026-02-10T16:40:00Z",
            ("Frankfurt Hosting Partner", "EU Launch"), ("fact:frankfurt-partner-dr-test-passed",), "done", 0.80),
    _ticket(2335, "Identity Gateway onboarding for EU hires",
            "Prepare identity onboarding for the EU support hires so access is ready when the launch proceeds.",
            "Yuki Tanaka", "Jonas Berg", "2026-02-13T11:30:00Z",
            ("Identity Gateway", "Q3 Hiring Plan"), (), "done", 0.78),
    _ticket(2339, "Billing latency objective documentation",
            "Document the Billing Service latency objective formally in the SLO catalogue.",
            "Raj Patel", "Raj Patel", "2026-01-28T10:00:00Z",
            ("Billing Service", "Pricing v2"), ("fact:billing-service-latency-slo",), "done", 0.80),
    _ticket(2343, "Partner load-balancer failover caused by certificate rotation",
            "Investigate the Frankfurt failover and confirm whether residency posture was affected.",
            "Daniel Osei", "Jonas Berg", "2026-02-18T09:10:00Z",
            ("Frankfurt Hosting Partner", "EU Data Residency Controls", "EU Launch"), (), "done", 0.85),
)

# --------------------------------------------------------------------------- #
# PRDs (3)
# --------------------------------------------------------------------------- #
PRDS: tuple[dict[str, Any], ...] = (
    _document(
        "NWL-PRD-001", "prd",
        "PRD: EU Launch on Frankfurt Hosting Partner",
        "The EU launch proceeds on the Frankfurt hosting partner as primary host for EU customer data. "
        "The launch depends on the data-residency assumption, which is supported by the partner's EU "
        "compliance certification and, independently, its SOC 2 Type II attestation.",
        "Priya Raman", "2026-02-02T08:30:00Z",
        ("EU Launch", "Frankfurt Hosting Partner", "EU Data Residency Controls", "Northwind Ingest Pipeline"),
        confidence=0.92,
        states=("fact:eu-launch-target-date", "fact:frankfurt-partner-compliance-valid"),
    ),
    _document(
        "NWL-PRD-002", "prd",
        "PRD: Pricing v2 EU tier",
        "The EU pricing tier is priced against the contracted Frankfurt hosting cost base. Economics assume the "
        "contracted rate holds through 2027 and that the partner's attestations remain current.",
        "Tomás Silva", "2026-02-01T09:00:00Z",
        ("Pricing v2", "Billing Service", "Frankfurt Hosting Partner"),
        confidence=0.90,
        states=("fact:frankfurt-partner-rate-hold", "fact:frankfurt-partner-soc2-attestation-valid"),
    ),
    _document(
        "NWL-PRD-003", "prd",
        "PRD: Data Governance Overhaul",
        "Region-pinned residency controls are implemented across ingest and warehouse layers, with evidence "
        "retained for audit. Regulated-sector eligibility currently rests on the partner certification.",
        "Aisha Khan", "2026-02-05T15:20:00Z",
        ("Data Governance Overhaul", "EU Data Residency Controls", "Reporting Warehouse"),
        confidence=0.91,
        states=("fact:eu-residency-controls-implemented", "fact:frankfurt-partner-compliance-valid"),
    ),
)

# --------------------------------------------------------------------------- #
# Meeting notes (2)
# --------------------------------------------------------------------------- #
MEETING_NOTES: tuple[dict[str, Any], ...] = (
    _document(
        "NWL-MN-001", "meeting_note",
        "Meeting notes: EU Launch Go/No-Go",
        "Go/no-go review for the EU launch. Residency controls verified; capacity confirmed. The single open "
        "risk is the partner's EU certification renewal timing. Launch remains conditional on the "
        "data-residency assumption holding.",
        "Priya Raman", "2026-02-11T17:10:00Z",
        ("EU Launch", "Frankfurt Hosting Partner", "EU Data Residency Controls"),
        ("fact:frankfurt-partner-compliance-valid",),
        ("Jonas Berg", "Aisha Khan", "Tomás Silva", "Elena Novak"),
        0.93,
    ),
    _document(
        "NWL-MN-002", "meeting_note",
        "Meeting notes: Frankfurt Partner Quarterly Review",
        "Quarterly technical review with the partner. DR test passed at a four-hour RTO, certificate rotation "
        "caused a short failover, and the compliance certification renewal is tracked separately from the "
        "SOC 2 attestation. Actions assigned to Jonas Berg.",
        "Jonas Berg", "2026-02-18T16:00:00Z",
        ("Frankfurt Hosting Partner", "EU Data Residency Controls", "EU Launch"),
        ("fact:frankfurt-partner-dr-test-passed", "fact:frankfurt-partner-soc2-attestation-valid"),
        ("Aisha Khan", "Lena Fischer", "Daniel Osei"),
        0.90,
    ),
)

#: All source artifacts in one ordered sequence.
ALL_SOURCES: tuple[dict[str, Any], ...] = SLACK + TICKETS + PRDS + MEETING_NOTES
