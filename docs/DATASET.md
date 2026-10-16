# Tripwire — The Northwind Labs Dataset

This document describes the deterministic demonstration dataset in
`tripwire/dataset/`. Every table below was generated from the real data
(`tripwire/dataset/entities.py`, `tripwire/dataset/sources.py`) by seeding a
`GraphEngine` over an in-memory store and reading the graph back; nothing here is
hand-written from memory. The dataset has a version (`1.0.0`) and a machine-readable
manifest (`northwind.dataset_manifest()`).

Totals: **114 nodes, 345 edges**; expected counts per label:

```json
{
  "Message": 40, "Document": 20, "Person": 12, "Team": 4,
  "System": 8, "Project": 6, "Decision": 7, "Assumption": 4, "Fact": 13
}
```

Seeding is a pure function (`build_subgraph()`): no randomness and no clock read in
the *content*, so seeding twice produces identical nodes and edges.

## 1. The organisation

### 1.1 People (12)

| Id | Name | Role | Team |
| --- | --- | --- | --- |
| `person:priya-raman` | Priya Raman | VP Engineering | Platform Engineering |
| `person:jonas-berg` | Jonas Berg | Senior Platform Engineer | Platform Engineering |
| `person:aisha-khan` | Aisha Khan | Head of Compliance | Data & Compliance |
| `person:ahmed-osman` | Ahmed Osman | Data Platform Lead | Data & Compliance |
| `person:tomas-silva` | Tomás Silva | Product Manager, EU | Growth & Monetisation |
| `person:sofia-marchetti` | Sofia Marchetti | Pricing Manager | Growth & Monetisation |
| `person:marcus-webb` | Marcus Webb | Chief Technology Officer | Growth & Monetisation |
| `person:elena-novak` | Elena Novak | Support Lead | Customer Operations |
| `person:yuki-tanaka` | Yuki Tanaka | People Operations Lead | Customer Operations |
| `person:daniel-osei` | Daniel Osei | Site Reliability Engineer | Platform Engineering |
| `person:raj-patel` | Raj Patel | Billing Engineer | Platform Engineering |
| `person:lena-fischer` | Lena Fischer | Vendor Manager | Customer Operations |

Each person also carries `handle`, `location` and `tenure_years`.

### 1.2 Teams (4)

| Id | Name | Focus | Cost centre |
| --- | --- | --- | --- |
| `team:platform-engineering` | Platform Engineering | Core platform, hosting and data ingestion | ENG-100 |
| `team:data-compliance` | Data & Compliance | Data governance, residency and regulatory readiness | CMP-200 |
| `team:growth-monetisation` | Growth & Monetisation | Pricing, packaging and new-market commercial models | GRW-300 |
| `team:customer-operations` | Customer Operations | Support, vendor management and people operations | OPS-400 |

### 1.3 Systems (8)

| Id | Name | Type | Region | Criticality |
| --- | --- | --- | --- | --- |
| `system:frankfurt-hosting-partner` | Frankfurt Hosting Partner | external_partner | eu-central | tier-1 |
| `system:eu-data-residency-controls` | EU Data Residency Controls | internal_control | eu-central | tier-1 |
| `system:northwind-ingest-pipeline` | Northwind Ingest Pipeline | internal_service | multi | tier-1 |
| `system:billing-service` | Billing Service | internal_service | multi | tier-1 |
| `system:identity-gateway` | Identity Gateway | internal_service | multi | tier-2 |
| `system:reporting-warehouse` | Reporting Warehouse | internal_service | multi | tier-2 |
| `system:edge-cache` | Edge Cache | internal_service | multi | tier-2 |
| `system:notification-bus` | Notification Bus | internal_service | multi | tier-3 |

### 1.4 Projects (6)

| Id | Name | Target date | Owner role |
| --- | --- | --- | --- |
| `project:eu-launch` | EU Launch | 2026-06-30 | VP Engineering |
| `project:pricing-v2` | Pricing v2 | 2026-07-31 | Product Manager, EU |
| `project:q3-hiring-plan` | Q3 Hiring Plan | 2026-09-30 | Support Lead |
| `project:apac-expansion` | APAC Expansion | 2026-11-30 | Chief Technology Officer |
| `project:data-governance-overhaul` | Data Governance Overhaul | 2026-08-15 | Head of Compliance |
| `project:mobile-redesign` | Mobile Redesign | 2026-10-31 | Pricing Manager |

### 1.5 Decisions (7)

| Id | Key | Made by | Status | Impacts | Depends on | Name |
| --- | --- | --- | --- | --- | --- | --- |
| `decision:eu-launch` | eu-launch | `person:priya-raman` | ACTIVE | `project:eu-launch` | — | Launch Northwind in the EU on the Frankfurt hosting partner |
| `decision:pricing-eu` | pricing-eu | `person:tomas-silva` | ACTIVE | `project:pricing-v2` | `decision:eu-launch` | Adopt the EU pricing tier aligned to the Frankfurt cost base |
| `decision:hiring-eu-support` | hiring-eu-support | `person:elena-novak` | ACTIVE | `project:q3-hiring-plan` | `decision:eu-launch` | Hire six EU support engineers in Q3 |
| `decision:legal-signoff-eu` | legal-signoff-eu | `person:aisha-khan` | ACTIVE | `project:data-governance-overhaul` | — | Rely on the partner's EU certification for regulatory sign-off |
| `decision:apac-datacentre` | apac-datacentre | `person:marcus-webb` | ACTIVE | `project:apac-expansion` | — | Move APAC workloads to the Singapore region |
| `decision:dark-mode-default` | dark-mode-default | `person:sofia-marchetti` | ACTIVE | `project:mobile-redesign` | — | Default the mobile app to dark mode |
| `decision:warehouse-regional-split` | warehouse-regional-split | `person:ahmed-osman` | ACTIVE | `project:apac-expansion` | `decision:apac-datacentre` | Split reporting by region in the warehouse |

Decisions 1–4 form the connected EU/Frankfurt storyline; decisions 5–7 are the
deliberately unrelated ones (§5).

### 1.6 Assumptions (4)

| Id | Key | Assumed by | Supporting facts | Name |
| --- | --- | --- | --- | --- |
| `assumption:data-residency-eu` | data-residency-eu | `decision:eu-launch` | `fact:frankfurt-partner-compliance-valid`, `fact:frankfurt-partner-soc2-attestation-valid` | EU data residency is contractually enforceable in Frankfurt |
| `assumption:eu-regulatory-eligibility` | eu-regulatory-eligibility | `decision:legal-signoff-eu` | `fact:frankfurt-partner-compliance-valid` | Regulatory eligibility rests on the partner's certification being current |
| `assumption:eu-cost-base` | eu-cost-base | `decision:pricing-eu` | `fact:frankfurt-partner-rate-hold` | EU hosting unit costs stay at the contracted rate |
| `assumption:apac-region-approval` | apac-region-approval | `decision:apac-datacentre` | `fact:apac-singapore-region-approved` | The Singapore region is approved for APAC production |

### 1.7 Facts (13)

| Id | Subject | Attribute | Value | valid_from | valid_to | recorded_at | conf | verified | source_ref |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fact:frankfurt-partner-compliance-valid` | Frankfurt Hosting Partner | compliance_status | valid | 2025-04-01 | — | 2026-01-12 | 0.95 | true | slack:#data-compliance/2026-01-12 |
| `fact:frankfurt-partner-soc2-attestation-valid` | Frankfurt Hosting Partner | certification_status | soc2_type_ii_valid | 2026-01-20 | 2027-03-31 | 2026-01-20 | 0.90 | true | prd:NWL-PRD-002 |
| `fact:frankfurt-partner-rate-hold` | Frankfurt Hosting Partner | pricing | contracted_rate_hold_through_2027 | 2026-02-01 | 2027-01-01 | 2026-02-01 | 0.85 | true | slack:#pricing/2026-02-01 |
| `fact:frankfurt-partner-dr-test-passed` | Frankfurt Hosting Partner | dr_resilience | 4h_rto_verified | 2026-02-10 | — | 2026-02-10 | 0.80 | true | ticket:NWL-2331 |
| `fact:frankfurt-partner-audit-clean` | Frankfurt Hosting Partner | audit_result | clean | 2026-01-30 | — | 2026-01-30 | 0.82 | true | ticket:NWL-2288 |
| `fact:frankfurt-partner-contract-status` | Frankfurt Hosting Partner | contract_status | active | 2025-04-01 | 2027-03-31 | 2026-01-15 | 0.93 | true | slack:#vendor-management/2026-01-15 |
| `fact:eu-residency-controls-implemented` | EU Data Residency Controls | deployment_status | implemented | 2026-02-05 | — | 2026-02-05 | 0.88 | true | ticket:NWL-2302 |
| `fact:ingest-pipeline-tenant-isolation` | Northwind Ingest Pipeline | tenant_isolation | region_pinned | 2026-02-08 | — | 2026-02-08 | 0.86 | true | slack:#platform-eng/2026-02-08 |
| `fact:billing-service-latency-slo` | Billing Service | latency_slo | 120ms p95 | 2026-01-28 | — | 2026-01-28 | 0.80 | true | slack:#platform-eng/2026-01-28 |
| `fact:apac-singapore-region-approved` | Reporting Warehouse | hosting_region | ap-southeast-1 | 2026-02-14 | — | 2026-02-14 | 0.84 | true | ticket:NWL-2320 |
| `fact:eu-launch-target-date` | EU Launch | target_date | 2026-06-30 | 2026-02-02 | — | 2026-02-02 | 0.90 | true | prd:NWL-PRD-001 |
| `fact:edge-cache-region-eu` | Edge Cache | hosting_region | eu-central-1 | 2026-01-05 | — | 2026-01-05 | 0.70 | true | slack:#platform-eng/2026-01-05 |
| `fact:edge-cache-region-us` | Edge Cache | hosting_region | us-east-1 | 2026-01-06 | — | 2026-01-06 | 0.62 | **false** | slack:#platform-eng/2026-01-06 |

(`—` = null / open interval. Dates are `T00:00:00Z` unless shown; `recorded_at`
values above show the date portion only.)

Two facts are designed to be in prior disagreement: `fact:edge-cache-region-eu` and
`fact:edge-cache-region-us` both assert `hosting_region` for the same subject with
different values, and the second is unverified. That is what makes a *new* claim
about `Edge Cache.hosting_region` classify as `ambiguous` (§7).

## 2. The source corpus

The dataset contains **60 source artifacts**: 40 Slack messages, 15 tickets, 3 PRDs
and 2 meeting notes.

| Kind | Count | Node label | doc_type | Ids |
| --- | --- | --- | --- | --- |
| Slack messages | 40 | `Message` | — | `message:slack:nw-slack-001` … `nw-slack-040` |
| Tickets | 15 | `Document` | `ticket` | `document:ticket:nwl-2276` … `nwl-2343` |
| PRDs | 3 | `Document` | `prd` | `document:prd:nwl-prd-001/002/003` |
| Meeting notes | 2 | `Document` | `meeting_note` | `document:meeting-note:nwl-mn-001/002` |

Slack channels used (with message counts): `#eu-launch` (8), `#platform-eng` (8),
`#data-compliance` (6), `#pricing` (4), `#support` (4), `#vendor-management` (4),
`#apac` (3), `#incidents` (3).

**How each artifact is linked into the graph.** From `northwind._source_nodes_and_edges`:

| Field on the source record | Edge created | Direction |
| --- | --- | --- |
| `author` | `AUTHORED` | `Person → Message/Document` (one per artifact, 60 total) |
| `resolved` (tickets) | `RESOLVED` + `MENTIONS` (`role=resolver`) | `Person → Document` (15 total) |
| `mentions` | `MENTIONS` | `Message/Document → entity` |
| `states` | `STATES` | `Message/Document → Fact` (31 total) |
| `participants` (meeting notes) | `MENTIONS` (`role=participant`) | `Person → Document` |

Resulting seeded edge counts by relationship: `MENTIONS` 167, `AUTHORED` 60,
`STATES` 31, `RESOLVED` 15, `ABOUT` 13, `OWNS` 13, `ON_TEAM` 12, `USES` 8, `MADE` 7,
`IMPACTS` 7, `SUPPORTED_BY` 5, `ASSUMES` 4, `DEPENDS_ON` 3.

## 3. The central storyline

The chain is: a **fact** supports an **assumption**, which a **decision assumes**,
which **impacts** a **project**.

```
fact:frankfurt-partner-compliance-valid ─SUPPORTED_BY→ assumption:data-residency-eu ←ASSUMES─ decision:eu-launch ─IMPACTS→ project:eu-launch
fact:frankfurt-partner-soc2-attestation-valid ─SUPPORTED_BY→ assumption:data-residency-eu   (independent second support)
fact:frankfurt-partner-compliance-valid ─SUPPORTED_BY→ assumption:eu-regulatory-eligibility ←ASSUMES─ decision:legal-signoff-eu ─IMPACTS→ project:data-governance-overhaul
fact:frankfurt-partner-rate-hold        ─SUPPORTED_BY→ assumption:eu-cost-base              ←ASSUMES─ decision:pricing-eu ─IMPACTS→ project:pricing-v2
decision:pricing-eu ─DEPENDS_ON→ decision:eu-launch
decision:hiring-eu-support ─DEPENDS_ON→ decision:eu-launch ─IMPACTS→ project:q3-hiring-plan
decision:apac-datacentre ─ASSUMES→ assumption:apac-region-approval / ─IMPACTS→ project:apac-expansion
```

| Fact | Supports assumption | Decision | Decision → Project | Evidenced by (STATES source records) |
| --- | --- | --- | --- | --- |
| `fact:frankfurt-partner-compliance-valid` | `assumption:data-residency-eu` | `decision:eu-launch` | `project:eu-launch` | `document:prd:nwl-prd-001`, `document:prd:nwl-prd-003`, `document:meeting-note:nwl-mn-001`, `message:slack:nw-slack-004` (#eu-launch), `message:slack:nw-slack-009` (#data-compliance) |
| `fact:frankfurt-partner-soc2-attestation-valid` | `assumption:data-residency-eu` | `decision:eu-launch` | `project:eu-launch` | `document:prd:nwl-prd-002`, `document:meeting-note:nwl-mn-002`, `message:slack:nw-slack-011` (#data-compliance) |
| `fact:frankfurt-partner-compliance-valid` | `assumption:eu-regulatory-eligibility` | `decision:legal-signoff-eu` | `project:data-governance-overhaul` | same records as row 1 |
| `fact:frankfurt-partner-rate-hold` | `assumption:eu-cost-base` | `decision:pricing-eu` | `project:pricing-v2` | `document:prd:nwl-prd-002`, `message:slack:nw-slack-002` (#eu-launch), `message:slack:nw-slack-023` (#pricing) |
| `fact:apac-singapore-region-approved` | `assumption:apac-region-approval` | `decision:apac-datacentre` | `project:apac-expansion` | `document:ticket:nwl-2320`, `message:slack:nw-slack-031` (#apac) |

The two dependency decisions are recorded as `DEPENDS_ON` in the launch planning
documents (`reason = "Recorded as a dependency in the launch planning documents."`):
`decision:pricing-eu -DEPENDS_ON-> decision:eu-launch` and
`decision:hiring-eu-support -DEPENDS_ON-> decision:eu-launch`. They inherit the
impact transitively through the EU Launch decision's assumption.

## 4. The planted hidden expert

**Name:** Jonas Berg — **official role:** Senior Platform Engineer — **team:**
Platform Engineering (`person:jonas-berg`).

**Targets he outranks and their official owners:**

| Target | Official owner (`OWNS`) | Jonas's rank |
| --- | --- | --- |
| `system:frankfurt-hosting-partner` | `person:lena-fischer` (Lena Fischer, Vendor Manager, Customer Operations) | 1 |
| `project:eu-launch` | `person:priya-raman` (Priya Raman, VP Engineering) | 1 |

Lena Fischer does not appear in the top five for `Frankfurt Hosting Partner` at all.

**Concrete contribution evidence** (all from real source records):

* He **resolved 7 tickets**: `document:ticket:nwl-2276`, `nwl-2284`, `nwl-2296`,
  `nwl-2312`, `nwl-2328`, `nwl-2335`, `nwl-2343`. Of these, 5 sit in the target's
  relevance ring and are counted for the target ranking.
* He **authored the meeting note** `document:meeting-note:nwl-mn-002` ("Meeting
  notes: Frankfurt Partner Quarterly Review", 2026-02-18).
* He authored 9 messages the expert finder counts for the Frankfurt target
  (`message:slack:nw-slack-003/006/008/011/017/019/028/036/039`).
* He is not the official owner of either target.

**How the formula produces the result.** `find_experts()` computes, per contribution,

```
score = weight(contribution_type) × relevance(distance) × recency(0.5 ^ (age_days/180)) × quality(artefact confidence)
```

then `person_score = Σ contribution.score × (1 + 0.10 × (distinct contribution types − 1))`,
normalised to the highest scorer. Weights and rings:

| Contribution | Weight | | Ring | Relevance |
| --- | --- | --- | --- | --- |
| `resolved_ticket` | 3.0 | | direct | 1.0 |
| `made_decision` | 3.0 | | structural | 0.8 |
| `authored_prd` | 2.5 | | indirect | 0.6 |
| `authored_meeting_note` | 2.0 | | weak | 0.4 |
| `authored_design_doc` | 2.0 | | | |
| `authored_document` | 1.5 | | | |
| `authored_message` | 1.0 | | | |
| `contributed_to_meeting` | 0.9 | | | |
| `discussed_target` | 0.6 | | | |

Recency half-life is 180 days. For the `EU Launch` query, Jonas's strongest
contribution is a resolved ticket (`document:ticket:nwl-2328`, confidence 0.90):
`3.0 × 1.0 × 0.388 × 0.90 = 1.047`. Five such resolved tickets, one authored meeting
note and nine authored messages sum to a raw score of `12.711` (rank 1,
`normalized_score` 1.0), against Priya Raman's `5.104` (norm 0.402). His breadth
across *five* distinct contribution types also earns the evidence-diversity bonus.
For the `Frankfurt Hosting Partner` query his score is `11.193` (norm 1.0).

Because `shadow_signal = (not is_official_owner) and normalized_score >= 0.5`, Jonas
is reported as a shadow-organisational-chart signal for every target he tops:
"the person who actually understands the system differs from the person the org
chart names".

(Recency note: the reference instant is the newest `timestamp`/`recorded_at` in the
graph, which after seeding is the seed `Event` node's wall-clock `recorded_at`. The
absolute recency factors therefore shift with the seed time; the ranking order does
not, because all contributions decay together.)

## 5. Deliberately unrelated decisions, and why they exist

Three decisions are included purely so the test-suite can prove the engine leaves
them alone when the Frankfurt chain changes:

| Decision | Project | Why it is disconnected from the EU/Frankfurt chain |
| --- | --- | --- |
| `decision:apac-datacentre` | `project:apac-expansion` | Own assumption (`assumption:apac-region-approval`), own fact, no shared entity with the Frankfurt chain. |
| `decision:dark-mode-default` | `project:mobile-redesign` | No assumption; a mobile theme choice. |
| `decision:warehouse-regional-split` | `project:apac-expansion` | Depends on `decision:apac-datacentre` only. |

After the headline scenario all three remain `ACTIVE`
(`test_trigger_event_headline_scenario` asserts this explicitly).

## 6. Alternate-evidence design and restraint outcomes

The asymmetry is load-bearing:

* `assumption:data-residency-eu` (EU Launch) is supported by **two independent**
  facts: the compliance certification *and* the SOC 2 Type II attestation.
* `assumption:eu-regulatory-eligibility` (legal sign-off) is supported by the
  certification **alone**.

When the certification is revoked:

* The **independent support that survives** is
  `fact:frankfurt-partner-soc2-attestation-valid` (status `ACTIVE`, verified,
  `valid_to = 2027-03-31`, still inside validity at the reference instant). It is
  reported in `alternate_evidence` and keeps the EU Launch decision `potential`.
* The decision **left with no surviving support** is `decision:legal-signoff-eu`
  (and, through it, `project:data-governance-overhaul`). It is reported `confirmed`
  *for review* — never automatically invalidated.

Restraint outcomes from the headline scenario (`frankfurt_compliance_revoked`):

| Affected entity | Label | Certainty | Status after |
| --- | --- | --- | --- |
| `decision:eu-launch` | Decision | `potential` | `POTENTIALLY_STALE` |
| `decision:legal-signoff-eu` | Decision | `confirmed` | `POTENTIALLY_STALE` |
| `decision:hiring-eu-support` | Decision | `potential` | `POTENTIALLY_STALE` |
| `decision:pricing-eu` | Decision | `potential` | `POTENTIALLY_STALE` |
| `project:eu-launch` | Project | `potential` | `POTENTIALLY_STALE` |
| `project:data-governance-overhaul` | Project | `confirmed` | `POTENTIALLY_STALE` |
| `project:pricing-v2` | Project | `potential` | `POTENTIALLY_STALE` |
| `project:q3-hiring-plan` | Project | `potential` | `POTENTIALLY_STALE` |

**All eight are never auto-marked `STALE`.** Promotion to `STALE` requires an
explicit `CONFIRMED_STALE` review; `apply_staleness()` writes only
`POTENTIALLY_STALE` (and a `staleness_flag` on projects).

Eight deduplicated alerts are raised (deterministic ids, since the new fact id
`fact:5f3054083121` and the entity ids are fixed):

| Alert id | Entity |
| --- | --- |
| `alert:befe6bd9fe49` | `decision:eu-launch` |
| `alert:aac1124ace58` | `decision:legal-signoff-eu` |
| `alert:eb11411e6a64` | `decision:hiring-eu-support` |
| `alert:bd0231654219` | `decision:pricing-eu` |
| `alert:db376ccd3d33` | `project:eu-launch` |
| `alert:7a1727f39304` | `project:data-governance-overhaul` |
| `alert:21909486f31e` | `project:pricing-v2` |
| `alert:69b70030d292` | `project:q3-hiring-plan` |

## 7. Scenario catalogue

`SCENARIOS` in `northwind.py` defines six incoming events. Each was run through a
freshly seeded engine; the table reports the real result.

| Scenario | What it demonstrates | Classification kind produced | Detected | Alerts |
| --- | --- | --- | --- | --- |
| `frankfurt_compliance_revoked` | The headline: verified revocation traced to affected decisions/projects; EU Launch stays `potential` (SOC 2 survives), legal sign-off becomes `confirmed`. | `contradiction` (1) + `additive` (5) | Yes | 8 |
| `frankfurt_compliance_revoked_unverified` | The same claim from an untrusted source: recorded, never accepted. Original fact → `CONTESTED` (both intervals open), all impacts stay `potential`. | `unverified` (1) + `additive` (5) | Yes | 8 |
| `pricing_rate_renewal_2027` | Succession, not conflict: the earlier record's validity simply ends where the new one begins. | `temporal` (1) + `additive` (5) | No | 0 |
| `ambiguous_edge_cache_region` | A third claim about an attribute the graph already disagrees on: the ambiguity is reported, not auto-resolved. | `ambiguous` (3) | No | 0 |
| `additive_edge_cache_provider` | New information about a known subject that conflicts with nothing. | `additive` (2) | No | 0 |
| `unrelated_mobile_theme_change` | A subject the graph knows nothing about; ingested as new information. | `unrelated` (considered = 0) | No | 0 |

Notes on the real results:

* `frankfurt_compliance_revoked` produces exactly one `contradiction`
  (confidence `0.936`, rule `compliance_revocation`) against
  `fact:frankfurt-partner-compliance-valid`; the other five candidates are
  `additive` (the claim's attribute does not match theirs).
* `frankfurt_compliance_revoked_unverified` fails the verified floor
  (confidence `0.35` and `verified=False`), so the conflict is classified
  `unverified`; `record_contradiction` reports the original as `CONTESTED` and the
  new fact (`fact:9824a03eade0`) as `UNCERTAIN`, with `valid_to`/`recorded_to`
  staying null.
* `pricing_rate_renewal_2027` yields one `temporal` candidate
  (`fact:frankfurt-partner-rate-hold`, whose `valid_to 2027-01-01 <= 2027-01-01`)
  and five `additive`; nothing is raised.
* `ambiguous_edge_cache_region` yields three `ambiguous` candidates
  (`fact:edge-cache-region-eu`, `fact:edge-cache-region-us`, and — because they share
  the `hosting_region` attribute — `fact:apac-singapore-region-approved`);
  the note "Prior knowledge about this subject and attribute is already internally
  inconsistent" is emitted.
* `unrelated_mobile_theme_change` considers zero existing facts and emits the note
  "No existing fact shares this subject or attribute…".

## 8. Honesty note

* The organisation, people, systems, projects, facts and source records are
  **realistic but entirely fictional**. "Northwind Labs", its staff, the Frankfurt
  partner, the certification `DE-CMP-4471`, the ticket keys and message ids are
  invented for the demonstration. No real company, person or compliance regime is
  described.
* The `mentions` and `states` fields on every source record are **explicit and
  hand-authored**, not NLP-derived. A record declares which entities it mentions and
  which facts it states, so the seeded graph is deterministic and every claimed
  dependency in the demo is traceable to a concrete record. There is no live Slack,
  Jira or Confluence integration in this build; the adapters parse documented JSON
  input shapes (`integration_type: "file_or_webhook_record"`).
* The dependency structure (`ASSUMES` / `SUPPORTED_BY` / `DEPENDS_ON` / `IMPACTS`) is
  curated data, deliberately **not** inferred from prose by the ingestion pipeline,
  which records extracted decisions/assumptions as unlinked `NEEDS_REVIEW`
  candidates.
