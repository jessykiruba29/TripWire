/**
 * Tripwire deterministic demo dataset — Northwind Labs.
 *
 * Provenance: authored for this project because the workspace contained no backend
 * and no fixtures. Everything here is SIMULATED (see `simulated: true` on sources).
 * It is served by mock-backend/ and is the same data the frontend mock adapter uses.
 *
 * Time model
 *  - SEEDED_AT : when the deterministic dataset was loaded (recorded time floor)
 *  - DEMO_CLOCK: "now" for the demo session; the tripwire event is recorded here
 *  - WORLD_VALID_*: when things were true in the story's world
 */

export const SEEDED_AT = '2026-10-16T06:00:00.000Z';
export const DEMO_CLOCK = '2026-10-16T09:00:00.000Z';
export const EVENT_OCCURRED_AT = '2026-10-15T08:40:00.000Z';

/** The three ids the guided demo path is built from (surfaced via /api/demo/state). */
export const STORYLINE = {
  fact_id: 'FACT-FRANKFURT-EU-CERTIFIED',
  new_fact_id: 'FACT-FRANKFURT-EU-CERT-LOST',
  assumption_id: 'ASM-DATA-RESIDENCY',
  decision_id: 'DEC-EU-LAUNCH',
  partner_id: 'ORG-FRANKFURT-HOSTING',
  trigger_text: 'Our Frankfurt hosting partner has lost its EU compliance certification.',
};

export const TEAMS = [
  { id: 'TEAM-PLATFORM', name: 'Platform & Infrastructure', focus: 'Runs the EU hosting estate, edges and regional failover.' },
  { id: 'TEAM-ECOM', name: 'E-commerce', focus: 'Owns the EU launch plan, checkout and storefront.' },
  { id: 'TEAM-SECURITY', name: 'Security & Compliance', focus: 'Certifications, DPAs, data residency reviews.' },
  { id: 'TEAM-DATA', name: 'Data Platform', focus: 'Warehouse, analytics and reporting.' },
];

export const PEOPLE = [
  { id: 'PER-MAYA-IYER', name: 'Maya Iyer', team_id: 'TEAM-ECOM', title: 'Head of E-commerce Engineering', official_owner_of: [], joined: '2024-02-12',
    blurb: 'Decision owner for the EU launch. Signs off on regional go/no-go.' },
  { id: 'PER-TOM-BRANDT', name: 'Tom Brandt', team_id: 'TEAM-PLATFORM', title: 'Staff Platform Engineer', official_owner_of: ['SYS-FRANKFURT-HOSTING'], joined: '2022-09-01',
    blurb: 'Listed owner of the Frankfurt hosting cluster.' },
  { id: 'PER-ANA-SILVA', name: 'Ana Silva', team_id: 'TEAM-PLATFORM', title: 'Platform Engineer', official_owner_of: [], joined: '2023-05-22',
    blurb: 'EU checkout edge, caching and deploy tooling.' },
  { id: 'PER-PRIYA-RAGHAVAN', name: 'Priya Raghavan', team_id: 'TEAM-SECURITY', title: 'Compliance Engineer', official_owner_of: [], joined: '2023-01-09',
    blurb: 'Runs certification and DPA reviews.' },
  { id: 'PER-LUKAS-MEYER', name: 'Lukas Meyer', team_id: 'TEAM-PLATFORM', title: 'Site Reliability Engineer (Frankfurt edge)', official_owner_of: [], joined: '2023-11-06',
    blurb: 'On-call for European edge traffic. Not the listed system owner.' },
  { id: 'PER-DIEGO-RAMOS', name: 'Diego Ramos', team_id: 'TEAM-DATA', title: 'Data Platform Lead', official_owner_of: ['SYS-ANALYTICS-WAREHOUSE'], joined: '2022-04-18',
    blurb: 'EU analytics estate, warehouse residency.' },
  { id: 'PER-SARA-KHAN', name: 'Sara Khan', team_id: 'TEAM-ECOM', title: 'Product Manager, EU Launch', official_owner_of: [], joined: '2024-06-03',
    blurb: 'Author of the EU launch and pricing PRDs.' },
  { id: 'PER-JONAS-WEBER', name: 'Jonas Weber', team_id: 'TEAM-SECURITY', title: 'Security Engineer', official_owner_of: ['SYS-IDENTITY'], joined: '2023-08-14',
    blurb: 'Identity, SSO consolidation and key management.' },
  { id: 'PER-EMMA-CLARKE', name: 'Emma Clarke', team_id: 'TEAM-ECOM', title: 'Engineering Manager, E-commerce', official_owner_of: [], joined: '2023-03-27',
    blurb: 'Chairs launch go/no-go meetings.' },
  { id: 'PER-RAJ-PATEL', name: 'Raj Patel', team_id: 'TEAM-DATA', title: 'Analytics Engineer', official_owner_of: [], joined: '2024-01-15',
    blurb: 'Pricing analytics and reporting pipelines.' },
  { id: 'PER-OLIVIA-NGUYEN', name: 'Olivia Nguyen', team_id: 'TEAM-PLATFORM', title: 'Director of Infrastructure', official_owner_of: ['SYS-DATA-RESIDENCY-GATEWAY'], joined: '2021-10-04',
    blurb: 'Owns infrastructure budget and the residency gateway.' },
  { id: 'PER-NOAH-FISCHER', name: 'Noah Fischer', team_id: 'TEAM-ECOM', title: 'Frontend Engineer', official_owner_of: [], joined: '2025-01-20',
    blurb: 'Storefront UI. Very active in chat.' },
];

export const SYSTEMS = [
  { id: 'SYS-FRANKFURT-HOSTING', title: 'Frankfurt Hosting Cluster', owner_id: 'PER-TOM-BRANDT', criticality: 'high',
    blurb: 'Primary EU compute/edge estate operated by Frankfurt Hosting GmbH.' },
  { id: 'SYS-EU-CHECKOUT', title: 'EU Checkout Service', owner_id: 'PER-ANA-SILVA', criticality: 'high',
    blurb: 'Checkout path serving EU storefronts.' },
  { id: 'SYS-DATA-RESIDENCY-GATEWAY', title: 'Data Residency Gateway', owner_id: 'PER-OLIVIA-NGUYEN', criticality: 'high',
    blurb: 'Enforces region pinning for EU personal data.' },
  { id: 'SYS-CRM-SYNC', title: 'CRM Sync Service', owner_id: 'PER-DIEGO-RAMOS', criticality: 'medium', blurb: 'Bi-directional CRM replication.' },
  { id: 'SYS-PRICING-ENGINE', title: 'Pricing Engine', owner_id: 'PER-RAJ-PATEL', criticality: 'medium', blurb: 'Dynamic pricing and FX handling.' },
  { id: 'SYS-IDENTITY', title: 'Identity Service', owner_id: 'PER-JONAS-WEBER', criticality: 'high', blurb: 'Authentication and SSO.' },
  { id: 'SYS-ANALYTICS-WAREHOUSE', title: 'Analytics Warehouse (Dublin)', owner_id: 'PER-DIEGO-RAMOS', criticality: 'medium', blurb: 'EU analytics warehouse, physically hosted in Dublin.' },
  { id: 'SYS-NOTIFICATIONS', title: 'Notification Service', owner_id: 'PER-ANA-SILVA', criticality: 'low', blurb: 'Transactional email and push delivery.' },
];

export const PROJECTS = [
  { id: 'PRJ-EU-LAUNCH', title: 'EU Launch (Q4)', status: 'in_progress', team_id: 'TEAM-ECOM', system_ids: ['SYS-EU-CHECKOUT', 'SYS-FRANKFURT-HOSTING', 'SYS-DATA-RESIDENCY-GATEWAY'],
    decision_ids: ['DEC-EU-LAUNCH', 'DEC-FRANKFURT-PRIMARY', 'DEC-CHECKOUT-CACHE'], assumption_ids: ['ASM-DATA-RESIDENCY', 'ASM-LATENCY-BUDGET'],
    blurb: 'Primary EU launch of storefront and checkout.' },
  { id: 'PRJ-ATLANTA-RETRY', title: 'Atlanta Regional Retry', status: 'planned', team_id: 'TEAM-PLATFORM', system_ids: ['SYS-NOTIFICATIONS'],
    decision_ids: ['DEC-ATLANTA-RETRY'], assumption_ids: ['ASM-ATLANTA-DEMAND'], blurb: 'Second attempt at a US-East region.' },
  { id: 'PRJ-PRICING-REVAMP', title: 'Pricing Revamp', status: 'in_progress', team_id: 'TEAM-DATA', system_ids: ['SYS-PRICING-ENGINE'],
    decision_ids: ['DEC-PRICING-V2'], assumption_ids: ['ASM-FX-VOLATILITY'], blurb: 'Dynamic pricing v2 rollout.' },
  { id: 'PRJ-DATA-GOVERNANCE', title: 'Data Governance Program', status: 'in_progress', team_id: 'TEAM-SECURITY', system_ids: ['SYS-DATA-RESIDENCY-GATEWAY', 'SYS-ANALYTICS-WAREHOUSE'],
    decision_ids: ['DEC-ANALYTICS-BQ'], assumption_ids: ['ASM-DATA-RESIDENCY', 'ASM-EU-DATA-TRANSFER'], blurb: 'Residency, retention and classification.' },
  { id: 'PRJ-IDENTITY-SSO', title: 'Identity SSO Consolidation', status: 'in_progress', team_id: 'TEAM-SECURITY', system_ids: ['SYS-IDENTITY'],
    decision_ids: ['DEC-SSO-MIGRATION'], assumption_ids: ['ASM-SSO-MANDATE'], blurb: 'Move all staff auth onto one IdP.' },
  { id: 'PRJ-CHECKOUT-LATENCY', title: 'Checkout Latency Reduction', status: 'in_progress', team_id: 'TEAM-PLATFORM', system_ids: ['SYS-EU-CHECKOUT'],
    decision_ids: ['DEC-CHECKOUT-CACHE', 'DEC-BACKUP-REGION'], assumption_ids: ['ASM-LATENCY-BUDGET', 'ASM-COST-CEILING'], blurb: 'Cut EU p95 checkout latency.' },
];

/** Decisions. `depends_on` are assumption ids; `impact_weight` drives review thresholds. */
export const DECISIONS = [
  { id: 'DEC-EU-LAUNCH', title: 'Proceed with the EU launch on the Frankfurt hosting plan', owner_id: 'PER-MAYA-IYER',
    created_at: '2026-06-18T14:05:00.000Z', depends_on: ['ASM-DATA-RESIDENCY'], project_ids: ['PRJ-EU-LAUNCH'],
    system_ids: ['SYS-FRANKFURT-HOSTING', 'SYS-EU-CHECKOUT'], impact_weight: 0.9, created_from: 'SRC-C-004',
    description: 'Launch the EU storefront and checkout on the Frankfurt estate with the residency gateway pinning EU data to that region. Approved at the go/no-go on 2026-06-18.' },
  { id: 'DEC-FRANKFURT-PRIMARY', title: 'Keep Frankfurt as the primary EU hosting region', owner_id: 'PER-OLIVIA-NGUYEN',
    created_at: '2026-07-30T11:20:00.000Z', depends_on: ['ASM-DATA-RESIDENCY', 'ASM-COST-CEILING'], project_ids: ['PRJ-EU-LAUNCH'],
    system_ids: ['SYS-FRANKFURT-HOSTING'], impact_weight: 0.75, created_from: 'SRC-MTG-002',
    description: 'Frankfurt remains the primary EU region; the Amsterdam build-out is deferred until the cost case is clearer.' },
  { id: 'DEC-DPA-TERMS', title: 'Accept the Frankfurt partner DPA terms as-is', owner_id: 'PER-PRIYA-RAGHAVAN',
    created_at: '2026-06-10T09:15:00.000Z', depends_on: ['ASM-PARTNER-CERT-VALID'], project_ids: ['PRJ-EU-LAUNCH'],
    system_ids: ['SYS-FRANKFURT-HOSTING', 'SYS-DATA-RESIDENCY-GATEWAY'], impact_weight: 0.6, created_from: 'SRC-B-TKT-215',
    description: 'Legal accepted the processor DPA without amendment, relying on the partner holding valid EU certifications.' },
  { id: 'DEC-ANALYTICS-BQ', title: 'Keep EU analytics in the Dublin warehouse', owner_id: 'PER-DIEGO-RAMOS',
    created_at: '2026-08-21T13:40:00.000Z', depends_on: ['ASM-DATA-RESIDENCY', 'ASM-EU-DATA-TRANSFER'], project_ids: ['PRJ-DATA-GOVERNANCE'],
    system_ids: ['SYS-ANALYTICS-WAREHOUSE'], impact_weight: 0.5, created_from: 'SRC-C-008',
    description: 'EU user analytics stay in the Dublin warehouse rather than being replicated into the Frankfurt estate.' },
  { id: 'DEC-BACKUP-REGION', title: 'Defer the Amsterdam backup region to Q1', owner_id: 'PER-OLIVIA-NGUYEN',
    created_at: '2026-09-14T15:00:00.000Z', depends_on: ['ASM-COST-CEILING'], project_ids: ['PRJ-CHECKOUT-LATENCY'],
    system_ids: ['SYS-FRANKFURT-HOSTING'], impact_weight: 0.35, created_from: 'SRC-MTG-002',
    description: 'Hold the Amsterdam standby region until infra spend is back under the ceiling.' },
  { id: 'DEC-ATLANTA-RETRY', title: 'Retry the Atlanta regional launch in Q1', owner_id: 'PER-EMMA-CLARKE',
    created_at: '2026-09-02T10:30:00.000Z', depends_on: ['ASM-ATLANTA-DEMAND'], project_ids: ['PRJ-ATLANTA-RETRY'],
    system_ids: ['SYS-NOTIFICATIONS'], impact_weight: 0.4, created_from: 'SRC-B-TKT-228',
    description: 'Retry US-East after the 2025 capacity problem, using reserved capacity.' },
  { id: 'DEC-PRICING-V2', title: 'Ship pricing v2 with dynamic FX', owner_id: 'PER-RAJ-PATEL',
    created_at: '2026-08-05T16:10:00.000Z', depends_on: ['ASM-FX-VOLATILITY'], project_ids: ['PRJ-PRICING-REVAMP'],
    system_ids: ['SYS-PRICING-ENGINE'], impact_weight: 0.3, created_from: 'SRC-C-010',
    description: 'Roll out dynamic FX pricing across EU storefronts.' },
  { id: 'DEC-SSO-MIGRATION', title: 'Migrate staff auth to the central SSO IdP', owner_id: 'PER-JONAS-WEBER',
    created_at: '2026-07-08T08:45:00.000Z', depends_on: ['ASM-SSO-MANDATE'], project_ids: ['PRJ-IDENTITY-SSO'],
    system_ids: ['SYS-IDENTITY'], impact_weight: 0.3, created_from: 'SRC-B-003',
    description: 'Company-wide SSO mandate for all internal tooling.' },
  { id: 'DEC-CHECKOUT-CACHE', title: 'Add edge caching to EU checkout', owner_id: 'PER-ANA-SILVA',
    created_at: '2026-09-28T12:00:00.000Z', depends_on: ['ASM-LATENCY-BUDGET'], project_ids: ['PRJ-CHECKOUT-LATENCY'],
    system_ids: ['SYS-EU-CHECKOUT'], impact_weight: 0.25, created_from: 'SRC-B-TKT-231',
    description: 'Introduce edge caching on non-PII checkout routes to reduce p95 latency.' },
];

/** Assumptions. `supported_by` are fact ids that carry them at baseline. */
export const ASSUMPTIONS = [
  { id: 'ASM-DATA-RESIDENCY', label: 'EU launch data must reside with an EU-certified processor',
    statement: 'EU user data must be processed by a provider holding a current EU data-residency certification, and the Frankfurt estate satisfies this.',
    supported_by: ['FACT-FRANKFURT-EU-CERTIFIED'], decision_ids: ['DEC-EU-LAUNCH', 'DEC-FRANKFURT-PRIMARY', 'DEC-ANALYTICS-BQ'] },
  { id: 'ASM-PARTNER-CERT-VALID', label: 'The Frankfurt partner maintains valid EU certifications',
    statement: 'The hosting partner keeps its EU certifications current for the life of the DPA.',
    supported_by: ['FACT-FRANKFURT-EU-CERTIFIED', 'FACT-DPA-SIGNED'], decision_ids: ['DEC-DPA-TERMS'] },
  { id: 'ASM-EU-DATA-TRANSFER', label: 'EU user data is not transferred outside the EU',
    statement: 'No EU personal data leaves EU regions; the residency gateway blocks out-of-region writes.',
    supported_by: ['FACT-DATA-FLOW-EU-ONLY', 'FACT-IRELAND-WAREHOUSE-EU'], decision_ids: ['DEC-ANALYTICS-BQ'] },
  { id: 'ASM-COST-CEILING', label: 'Infrastructure spend stays under €40k/month',
    statement: 'Total infra spend remains below the €40k monthly ceiling while the EU estate grows.',
    supported_by: ['FACT-COST-BASELINE'], decision_ids: ['DEC-FRANKFURT-PRIMARY', 'DEC-BACKUP-REGION'] },
  { id: 'ASM-ATLANTA-DEMAND', label: 'Atlanta demand justifies a regional retry',
    statement: 'US-East demand growth justifies a second regional attempt in Q1.',
    supported_by: ['FACT-ATLANTA-CAPACITY'], decision_ids: ['DEC-ATLANTA-RETRY'] },
  { id: 'ASM-FX-VOLATILITY', label: 'FX volatility stays inside the pricing band',
    statement: 'EUR/USD movement stays inside ±5%, so dynamic FX pricing is safe.',
    supported_by: ['FACT-FX-BAND'], decision_ids: ['DEC-PRICING-V2'] },
  { id: 'ASM-LATENCY-BUDGET', label: 'EU p95 checkout latency stays under 300 ms',
    statement: 'EU checkout p95 stays under 300 ms without regional changes.',
    supported_by: ['FACT-CHECKOUT-P95'], decision_ids: ['DEC-CHECKOUT-CACHE'] },
  { id: 'ASM-SSO-MANDATE', label: 'The company SSO mandate lands in Q1',
    statement: 'Central SSO becomes mandatory for internal tooling in Q1.',
    supported_by: ['FACT-SSO-VENDOR'], decision_ids: ['DEC-SSO-MIGRATION'] },
];

/**
 * Facts. Baseline records only — the tripwire fact (FACT-FRANKFURT-EU-CERT-LOST)
 * is created by triggering the demo event, never pre-seeded.
 */
export const FACTS = [
  { id: 'FACT-FRANKFURT-EU-CERTIFIED', statement: 'Frankfurt Hosting GmbH holds a current EU data-residency certification (EU-DPF-2025).',
    kind: 'fact', valid_from: '2026-06-02T00:00:00.000Z', valid_to: null, recorded_at: '2026-06-03T06:10:00.000Z',
    confidence: 0.91, extracted_from: 'SRC-C-001', supports: ['ASM-DATA-RESIDENCY', 'ASM-PARTNER-CERT-VALID'], system_ids: ['SYS-FRANKFURT-HOSTING'], project_ids: ['PRJ-EU-LAUNCH'] },
  { id: 'FACT-DPA-SIGNED', statement: 'Processing DPA with Frankfurt Hosting GmbH was signed on 2026-06-10.',
    kind: 'fact', valid_from: '2026-06-10T00:00:00.000Z', valid_to: null, recorded_at: '2026-06-10T09:02:00.000Z',
    confidence: 0.97, extracted_from: 'SRC-B-TKT-215', supports: ['ASM-PARTNER-CERT-VALID'], system_ids: ['SYS-DATA-RESIDENCY-GATEWAY'], project_ids: ['PRJ-EU-LAUNCH'] },
  { id: 'FACT-DATA-FLOW-EU-ONLY', statement: 'Region pinning keeps EU personal data inside EU regions; no out-of-region writes in the last 90 days.',
    kind: 'fact', valid_from: '2026-08-01T00:00:00.000Z', valid_to: null, recorded_at: '2026-08-01T07:30:00.000Z',
    confidence: 0.85, extracted_from: 'SRC-C-008', supports: ['ASM-EU-DATA-TRANSFER'], system_ids: ['SYS-DATA-RESIDENCY-GATEWAY'], project_ids: ['PRJ-DATA-GOVERNANCE'] },
  { id: 'FACT-IRELAND-WAREHOUSE-EU', statement: 'The EU analytics warehouse is physically hosted in Dublin, Ireland.',
    kind: 'fact', valid_from: '2026-05-19T00:00:00.000Z', valid_to: null, recorded_at: '2026-05-19T10:00:00.000Z',
    confidence: 0.95, extracted_from: 'SRC-C-008', supports: ['ASM-EU-DATA-TRANSFER'], system_ids: ['SYS-ANALYTICS-WAREHOUSE'], project_ids: ['PRJ-DATA-GOVERNANCE'] },
  { id: 'FACT-COST-BASELINE', statement: 'Infrastructure spend is €31.4k/month against a €40k/month ceiling.',
    kind: 'fact', valid_from: '2026-09-30T00:00:00.000Z', valid_to: null, recorded_at: '2026-09-30T16:20:00.000Z',
    confidence: 0.93, extracted_from: 'SRC-MTG-002', supports: ['ASM-COST-CEILING'], system_ids: [], project_ids: ['PRJ-CHECKOUT-LATENCY'] },
  { id: 'FACT-ATLANTA-CAPACITY', statement: 'Reserved US-East capacity in Atlanta is available until 2026-12-31.',
    kind: 'fact', valid_from: '2026-08-28T00:00:00.000Z', valid_to: null, recorded_at: '2026-08-28T11:45:00.000Z',
    confidence: 0.88, extracted_from: 'SRC-B-TKT-228', supports: ['ASM-ATLANTA-DEMAND'], system_ids: [], project_ids: ['PRJ-ATLANTA-RETRY'] },
  { id: 'FACT-FX-BAND', statement: 'EUR/USD stayed inside the ±5% band for the last two quarters.',
    kind: 'fact', valid_from: '2026-09-01T00:00:00.000Z', valid_to: null, recorded_at: '2026-09-01T09:10:00.000Z',
    confidence: 0.82, extracted_from: 'SRC-C-010', supports: ['ASM-FX-VOLATILITY'], system_ids: ['SYS-PRICING-ENGINE'], project_ids: ['PRJ-PRICING-REVAMP'] },
  { id: 'FACT-CHECKOUT-P95', statement: 'EU checkout p95 latency is 271 ms.',
    kind: 'fact', valid_from: '2026-09-25T00:00:00.000Z', valid_to: null, recorded_at: '2026-09-25T08:05:00.000Z',
    confidence: 0.9, extracted_from: 'SRC-B-TKT-231', supports: ['ASM-LATENCY-BUDGET'], system_ids: ['SYS-EU-CHECKOUT'], project_ids: ['PRJ-CHECKOUT-LATENCY'] },
  { id: 'FACT-SSO-VENDOR', statement: 'The SSO vendor was selected and the rollout plan approved.',
    kind: 'fact', valid_from: '2026-07-02T00:00:00.000Z', valid_to: null, recorded_at: '2026-07-02T13:25:00.000Z',
    confidence: 0.86, extracted_from: 'SRC-B-003', supports: ['ASM-SSO-MANDATE'], system_ids: ['SYS-IDENTITY'], project_ids: ['PRJ-IDENTITY-SSO'] },
  { id: 'FACT-FRANKFURT-LATENCY', statement: 'Frankfurt edge p95 latency is 168 ms for EU storefront traffic.',
    kind: 'fact', valid_from: '2026-07-15T00:00:00.000Z', valid_to: null, recorded_at: '2026-07-15T07:00:00.000Z',
    confidence: 0.87, extracted_from: 'SRC-B-007', supports: [], system_ids: ['SYS-FRANKFURT-HOSTING'], project_ids: ['PRJ-EU-LAUNCH'] },
  { id: 'FACT-EU-USER-COUNT', statement: 'The EU waitlist passed 18,000 signups before launch.',
    kind: 'fact', valid_from: '2026-09-20T00:00:00.000Z', valid_to: null, recorded_at: '2026-09-20T09:00:00.000Z',
    confidence: 0.8, extracted_from: 'SRC-B-012', supports: [], system_ids: ['SYS-EU-CHECKOUT'], project_ids: ['PRJ-EU-LAUNCH'] },
  { id: 'FACT-PARTNER-STATUS-REVIEW', statement: 'Frankfurt Hosting GmbH submitted certification renewal paperwork on 2026-08-30; the review outcome is not yet published.',
    kind: 'fact', valid_from: '2026-08-30T00:00:00.000Z', valid_to: null, recorded_at: '2026-08-31T08:15:00.000Z',
    confidence: 0.6, extracted_from: 'SRC-C-009', supports: [], system_ids: ['SYS-FRANKFURT-HOSTING'], project_ids: ['PRJ-EU-LAUNCH'] },
  { id: 'FACT-CRM-SCHEMA', statement: 'The CRM schema change shipped and the sync service is stable.',
    kind: 'fact', valid_from: '2026-09-10T00:00:00.000Z', valid_to: null, recorded_at: '2026-09-10T14:40:00.000Z',
    confidence: 0.83, extracted_from: 'SRC-B-020', supports: [], system_ids: ['SYS-CRM-SYNC'], project_ids: [] },
  { id: 'FACT-NOTIF-QUEUE', statement: 'Notification queue depth is back to normal after the September backlog.',
    kind: 'fact', valid_from: '2026-09-18T00:00:00.000Z', valid_to: null, recorded_at: '2026-09-18T10:30:00.000Z',
    confidence: 0.79, extracted_from: 'SRC-B-024', supports: [], system_ids: ['SYS-NOTIFICATIONS'], project_ids: ['PRJ-ATLANTA-RETRY'] },
  { id: 'FACT-PRICING-ROLLOUT', statement: 'Pricing v2 is rolled out to 42% of EU traffic.',
    kind: 'fact', valid_from: '2026-10-01T00:00:00.000Z', valid_to: null, recorded_at: '2026-10-01T12:15:00.000Z',
    confidence: 0.9, extracted_from: 'SRC-C-010', supports: [], system_ids: ['SYS-PRICING-ENGINE'], project_ids: ['PRJ-PRICING-REVAMP'] },
  { id: 'FACT-IDENTITY-LATENCY', statement: 'Identity token exchange p95 is 95 ms after the SSO pilot.',
    kind: 'fact', valid_from: '2026-09-12T00:00:00.000Z', valid_to: null, recorded_at: '2026-09-12T09:20:00.000Z',
    confidence: 0.84, extracted_from: 'SRC-B-030', supports: [], system_ids: ['SYS-IDENTITY'], project_ids: ['PRJ-IDENTITY-SSO'] },
  { id: 'FACT-ANALYTICS-COST', statement: 'The Dublin warehouse costs €6.1k/month and is within the governance budget.',
    kind: 'fact', valid_from: '2026-09-15T00:00:00.000Z', valid_to: null, recorded_at: '2026-09-15T11:00:00.000Z',
    confidence: 0.88, extracted_from: 'SRC-C-008', supports: ['ASM-COST-CEILING'], system_ids: ['SYS-ANALYTICS-WAREHOUSE'], project_ids: ['PRJ-DATA-GOVERNANCE'] },
  { id: 'FACT-FRANKFURT-FAILOVER', statement: 'Frankfurt failover to the Frankfurt secondary completed in 42 s during the July drill.',
    kind: 'fact', valid_from: '2026-07-22T00:00:00.000Z', valid_to: null, recorded_at: '2026-07-22T15:10:00.000Z',
    confidence: 0.86, extracted_from: 'SRC-C-006', supports: [], system_ids: ['SYS-FRANKFURT-HOSTING'], project_ids: ['PRJ-EU-LAUNCH'] },
];

/** Baseline event: the certification was verified and recorded. */
export const EVENTS = [
  { id: 'EVT-0001', type: 'certification_verified', summary: 'Frankfurt partner EU data-residency certification verified (EU-DPF-2025)',
    occurred_at: '2026-06-02T00:00:00.000Z', recorded_at: '2026-06-03T06:10:00.000Z', actor: 'PER-PRIYA-RAGHAVAN',
    source_id: 'SRC-C-001', raw_text: 'Frankfurt Hosting GmbH confirmed EU-DPF-2025 data-residency certification for the Frankfurt estate.',
    fact_ids: ['FACT-FRANKFURT-EU-CERTIFIED'] },
];
