/**
 * Core source records (11 of the 60 required Northwind Labs fixtures).
 *
 * These are the records the demo path depends on: they carry the certification fact,
 * the EU launch decision, the alternate evidence and the hidden-expert trail.
 * Bulk/filler records live in sources-bulk.js.
 *
 * Every record here is SIMULATED. `external_id` uses the `simulated://` scheme on
 * purpose so the UI can never imply a live Slack/ticketing integration.
 */

export const CORE_SOURCES = [
  {
    id: 'SRC-C-001', type: 'slack_message', title: '#ecom-launch',
    external_id: 'simulated://slack/northwind/ecom-launch/1780000001.000100',
    author_id: 'PER-PRIYA-RAGHAVAN', timestamp: '2026-06-02T09:31:00.000Z', recorded_at: '2026-06-02T09:31:40.000Z',
    text: 'Confirmed with Frankfurt Hosting GmbH this morning: they hold EU-DPF-2025 for data residency, valid through the contract term. Certificate PDF is in the legal drive. Residency assumption for the EU launch is covered from our side.',
    entity_ids: ['SYS-FRANKFURT-HOSTING', 'SYS-DATA-RESIDENCY-GATEWAY', 'PRJ-EU-LAUNCH', 'ASM-DATA-RESIDENCY'],
    fact_ids: ['FACT-FRANKFURT-EU-CERTIFIED'],
    metadata: { channel: '#ecom-launch', reactions: 6, thread_replies: 2 },
  },
  {
    id: 'SRC-C-002', type: 'ticket', title: 'TKT-211 Verify EU data residency certification for the Frankfurt partner',
    external_id: 'simulated://tickets/northwind/TKT-211',
    author_id: 'PER-PRIYA-RAGHAVAN', timestamp: '2026-06-01T11:02:00.000Z', recorded_at: '2026-06-03T06:09:00.000Z',
    text: 'Acceptance: obtain a current certification reference from Frankfurt Hosting GmbH and record it against the residency gateway.\nOutcome: EU-DPF-2025 verified, valid for the DPA term. No gaps found. Closing as resolved.',
    entity_ids: ['SYS-FRANKFURT-HOSTING', 'SYS-DATA-RESIDENCY-GATEWAY', 'ASM-DATA-RESIDENCY'],
    fact_ids: ['FACT-FRANKFURT-EU-CERTIFIED'],
    metadata: { status: 'resolved', priority: 'P2', resolved_by: 'PER-PRIYA-RAGHAVAN', labels: ['compliance', 'eu-launch'] },
  },
  {
    id: 'SRC-C-003', type: 'prd', title: 'PRD-001 EU Launch — Storefront & Checkout',
    external_id: 'simulated://prd/northwind/PRD-001',
    author_id: 'PER-SARA-KHAN', timestamp: '2026-06-08T10:00:00.000Z', recorded_at: '2026-06-08T10:05:00.000Z',
    text: '## Data residency\nEU customer data must remain with a provider holding a current EU data-residency certification. The Frankfurt estate is our primary region and satisfies this requirement (EU-DPF-2025). The Data Residency Gateway pins all EU personal data to that region.\n\n## Launch scope\nStorefront, checkout and order notifications. Target date: Q4.',
    entity_ids: ['PRJ-EU-LAUNCH', 'SYS-FRANKFURT-HOSTING', 'SYS-EU-CHECKOUT', 'SYS-DATA-RESIDENCY-GATEWAY', 'ASM-DATA-RESIDENCY'],
    fact_ids: ['FACT-FRANKFURT-EU-CERTIFIED'],
    metadata: { version: 'v1.3', section: 'Data residency', status: 'approved', reviewers: ['PER-MAYA-IYER', 'PER-PRIYA-RAGHAVAN'] },
  },
  {
    id: 'SRC-C-004', type: 'meeting_note', title: 'MTG-001 EU Launch Go/No-Go',
    external_id: 'simulated://meetings/northwind/MTG-001',
    author_id: 'PER-EMMA-CLARKE', timestamp: '2026-06-18T14:00:00.000Z', recorded_at: '2026-06-18T14:12:00.000Z',
    text: 'Attendees: Maya Iyer, Sara Khan, Emma Clarke, Priya Raghavan, Olivia Nguyen.\nDecision: proceed with the EU launch on the Frankfurt hosting plan. Rationale: Frankfurt is certified for EU data residency and the gateway pins all EU personal data there.\nActions: keep Amsterdam as standby only, revisit if the certification or cost picture changes.',
    entity_ids: ['DEC-EU-LAUNCH', 'PRJ-EU-LAUNCH', 'SYS-FRANKFURT-HOSTING', 'TEAM-ECOM'],
    fact_ids: ['FACT-FRANKFURT-EU-CERTIFIED'],
    metadata: { attendees: ['PER-MAYA-IYER', 'PER-SARA-KHAN', 'PER-EMMA-CLARKE', 'PER-PRIYA-RAGHAVAN', 'PER-OLIVIA-NGUYEN'], duration_min: 45 },
  },
  {
    id: 'SRC-C-005', type: 'slack_message', title: '#platform-infra',
    external_id: 'simulated://slack/northwind/platform-infra/1783200001.000200',
    author_id: 'PER-LUKAS-MEYER', timestamp: '2026-07-19T20:41:00.000Z', recorded_at: '2026-07-19T20:41:20.000Z',
    text: 'Heads up: I re-pinned the Frankfurt edge certs after the TLS handshake failures. Also wrote up the failover steps for the Frankfurt secondary — if we ever have to drain the primary, the gateway needs its region pin updated first, otherwise residency checks start failing. Took me two incidents to work that out.',
    entity_ids: ['SYS-FRANKFURT-HOSTING', 'SYS-DATA-RESIDENCY-GATEWAY', 'PRJ-EU-LAUNCH'],
    fact_ids: ['FACT-FRANKFURT-FAILOVER'],
    metadata: { channel: '#platform-infra', reactions: 11, thread_replies: 5 },
  },
  {
    id: 'SRC-C-006', type: 'ticket', title: 'TKT-217 Frankfurt failover drill — region pin behaviour',
    external_id: 'simulated://tickets/northwind/TKT-217',
    author_id: 'PER-LUKAS-MEYER', timestamp: '2026-07-22T09:15:00.000Z', recorded_at: '2026-07-22T15:12:00.000Z',
    text: 'Ran the quarterly failover drill against the Frankfurt secondary.\nResult: failover completed in 42 s with no residency violations, but only after updating the region pin on the Data Residency Gateway. Documented the runbook in the Frankfurt edge wiki.\nResolved.',
    entity_ids: ['SYS-FRANKFURT-HOSTING', 'SYS-DATA-RESIDENCY-GATEWAY'],
    fact_ids: ['FACT-FRANKFURT-FAILOVER'],
    metadata: { status: 'resolved', priority: 'P2', resolved_by: 'PER-LUKAS-MEYER', labels: ['frankfurt', 'reliability'] },
  },
  {
    id: 'SRC-C-007', type: 'slack_message', title: '#storefront',
    external_id: 'simulated://slack/northwind/storefront/1784400001.000300',
    author_id: 'PER-NOAH-FISCHER', timestamp: '2026-08-11T13:22:00.000Z', recorded_at: '2026-08-11T13:22:15.000Z',
    text: 'Bumped the CTA contrast on the EU storefront hero — the old blue failed AA. Also swapped the placeholder copy on the residency banner. Looks much better now.',
    entity_ids: ['SYS-EU-CHECKOUT', 'PRJ-EU-LAUNCH'],
    fact_ids: [],
    metadata: { channel: '#storefront', reactions: 4, thread_replies: 1 },
  },
  {
    id: 'SRC-C-008', type: 'slack_message', title: '#compliance',
    external_id: 'simulated://slack/northwind/compliance/1785600001.000400',
    author_id: 'PER-PRIYA-RAGHAVAN', timestamp: '2026-08-01T07:28:00.000Z', recorded_at: '2026-08-01T07:29:10.000Z',
    text: 'Region pinning audit for Q3: 0 out-of-region writes in the last 90 days across the EU estate. Note the analytics warehouse is physically in Dublin and stays in the EU, so it is unaffected by the Frankfurt setup. Keeping EU analytics there rather than replicating into Frankfurt.',
    entity_ids: ['SYS-DATA-RESIDENCY-GATEWAY', 'SYS-ANALYTICS-WAREHOUSE', 'ASM-EU-DATA-TRANSFER', 'DEC-ANALYTICS-BQ'],
    fact_ids: ['FACT-DATA-FLOW-EU-ONLY', 'FACT-IRELAND-WAREHOUSE-EU'],
    metadata: { channel: '#compliance', reactions: 3, thread_replies: 0 },
  },
  {
    id: 'SRC-C-009', type: 'slack_message', title: '#compliance',
    external_id: 'simulated://slack/northwind/compliance/1788300001.000500',
    author_id: 'PER-PRIYA-RAGHAVAN', timestamp: '2026-08-31T08:12:00.000Z', recorded_at: '2026-08-31T08:13:30.000Z',
    text: 'Frankfurt Hosting GmbH submitted their certification renewal paperwork on 2026-08-30. The review outcome is not published yet. I would not treat the renewal as confirmed until we see the published result — the current certificate reference is still the 2025 one.',
    entity_ids: ['SYS-FRANKFURT-HOSTING', 'ASM-DATA-RESIDENCY', 'ASM-PARTNER-CERT-VALID'],
    fact_ids: ['FACT-PARTNER-STATUS-REVIEW'],
    metadata: { channel: '#compliance', reactions: 2, thread_replies: 3 },
  },
  {
    id: 'SRC-C-010', type: 'prd', title: 'PRD-002 Pricing v2 — Dynamic FX',
    external_id: 'simulated://prd/northwind/PRD-002',
    author_id: 'PER-RAJ-PATEL', timestamp: '2026-08-04T09:30:00.000Z', recorded_at: '2026-08-04T09:35:00.000Z',
    text: '## Goal\nMove EU storefront pricing to dynamic FX with a ±5% band. Outside the band the storefront falls back to the last published rate.\n\n## Rollout\nProgressive: 10% → 42% → 100%. No dependency on the EU hosting region.',
    entity_ids: ['PRJ-PRICING-REVAMP', 'SYS-PRICING-ENGINE', 'ASM-FX-VOLATILITY'],
    fact_ids: ['FACT-FX-BAND', 'FACT-PRICING-ROLLOUT'],
    metadata: { version: 'v0.9', section: 'Rollout', status: 'approved', reviewers: ['PER-DIEGO-RAMOS'] },
  },
  {
    id: 'SRC-MTG-002', type: 'meeting_note', title: 'MTG-002 Quarterly Infrastructure Review — Q3',
    external_id: 'simulated://meetings/northwind/MTG-002',
    author_id: 'PER-OLIVIA-NGUYEN', timestamp: '2026-09-30T15:30:00.000Z', recorded_at: '2026-09-30T16:18:00.000Z',
    text: 'Attendees: Olivia Nguyen, Tom Brandt, Ana Silva, Lukas Meyer, Diego Ramos.\nSpend: €31.4k/month against the €40k ceiling.\nDecision: Frankfurt stays the primary EU region; the Amsterdam standby build-out is deferred to Q1 on cost grounds.\nNoted: Lukas flagged that the residency gateway region pin is the fragile part of any regional move — needs an owner.',
    entity_ids: ['DEC-FRANKFURT-PRIMARY', 'DEC-BACKUP-REGION', 'SYS-FRANKFURT-HOSTING', 'ASM-COST-CEILING', 'TEAM-PLATFORM'],
    fact_ids: ['FACT-COST-BASELINE'],
    metadata: { attendees: ['PER-OLIVIA-NGUYEN', 'PER-TOM-BRANDT', 'PER-ANA-SILVA', 'PER-LUKAS-MEYER', 'PER-DIEGO-RAMOS'], duration_min: 60 },
  },
];
