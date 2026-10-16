/**
 * Deterministic dataset + engine validator.
 * Run: node mock-backend/validate.js   (or: npm run validate inside mock-backend)
 *
 * Checks the fixture budget from the project brief, referential integrity,
 * byte-level determinism, and the full Frankfurt demo flow through the router.
 */

import { buildDataset } from './engine/dataset.js';
import { createRouter, TripwireStore } from './engine/router.js';

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    process.stdout.write(`  PASS  ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// ---------------------------------------------------------------- fixtures
section('Fixture budget and referential integrity');
const dataset = buildDataset();
const byType = dataset.sources.reduce((acc, s) => {
  acc[s.type] = (acc[s.type] || 0) + 1;
  return acc;
}, {});

ok('40 Slack messages', byType.slack_message === 40, `got ${byType.slack_message}`);
ok('15 tickets', byType.ticket === 15, `got ${byType.ticket}`);
ok('3 PRDs', byType.prd === 3, `got ${byType.prd}`);
ok('2 meeting notes', byType.meeting_note === 2, `got ${byType.meeting_note}`);
ok('12 people', dataset.counts.people === 12, `got ${dataset.counts.people}`);
ok('4 teams', dataset.counts.teams === 4, `got ${dataset.counts.teams}`);
ok('8 systems', dataset.counts.systems === 8, `got ${dataset.counts.systems}`);
ok('6 projects', dataset.counts.projects === 6, `got ${dataset.counts.projects}`);
ok('60 sources total', dataset.sources.length === 60, `got ${dataset.sources.length}`);

const nodeIds = new Set(dataset.nodes.map((n) => n.id));
const dupIds = dataset.sources.map((s) => s.id).filter((id, i, arr) => arr.indexOf(id) !== i);
ok('source ids unique', dupIds.length === 0, dupIds.join(','));
ok('node ids unique', nodeIds.size === dataset.nodes.length);

const peopleIds = new Set(dataset.nodes.filter((n) => n.type === 'person').map((n) => n.id));
const badAuthors = dataset.sources.filter((s) => !peopleIds.has(s.author_id)).map((s) => s.id);
ok('every source author is a known person', badAuthors.length === 0, badAuthors.join(','));

const graphRefIds = new Set(dataset.nodes.map((n) => n.id));
const badEntity = dataset.sources.flatMap((s) => (s.entity_ids || []).filter((e) => !graphRefIds.has(e)).map((e) => `${s.id}:${e}`));
ok('every source entity_id resolves to a node', badEntity.length === 0, badEntity.slice(0, 5).join(','));
const badFact = dataset.sources.flatMap((s) => (s.fact_ids || []).filter((e) => !graphRefIds.has(e)).map((e) => `${s.id}:${e}`));
ok('every source fact_id resolves to a node', badFact.length === 0, badFact.slice(0, 5).join(','));

// ---------------------------------------------------------------- determinism
section('Determinism');
ok('buildDataset() is byte-stable', JSON.stringify(buildDataset()) === JSON.stringify(buildDataset()));

// ---------------------------------------------------------------- baseline
section('Baseline demo state');
const store = new TripwireStore();
const router = createRouter(store);
const baseline = router.handle('GET', '/api/demo/state').body;
ok('baseline phase', baseline.phase === 'baseline' && baseline.event_applied === false);
ok('baseline has no alerts (honest empty state)', router.handle('GET', '/api/alerts').body.total === 0);
ok('health reports mock-backend mode', router.handle('GET', '/api/health').body.mode === 'mock-backend');
ok('graph returns nodes and edges', router.handle('GET', '/api/graph').body.nodes.length > 100);

const baselineSnapshot = JSON.stringify(router.handle('GET', '/api/graph').body);

// ---------------------------------------------------------------- demo flow
section('Frankfurt demonstration flow');
const trigger = router.handle('POST', '/api/demo/trigger-event', {}, {
  text: 'Our Frankfurt hosting partner has lost its EU compliance certification.',
});
ok('trigger returns 201', trigger.status === 201, `status ${trigger.status}`);
const body = trigger.body;
ok('new fact materialised', body.extraction?.new_fact?.id === 'FACT-FRANKFURT-EU-CERT-LOST');
ok('contradicted fact identified', body.extraction?.contradicted_fact?.id === 'FACT-FRANKFURT-EU-CERTIFIED');
ok('event record created with source', Boolean(body.event?.id && body.event?.source_id));
ok('EU launch decision flagged for review', body.propagation.decisions.some((d) => d.id === 'DEC-EU-LAUNCH' && d.requires_investigation));
ok('DPA decision flagged', body.propagation.decisions.some((d) => d.id === 'DEC-DPA-TERMS'));
ok('analytics decision held back as uncertain', body.propagation.uncertain.some((d) => d.id === 'DEC-ANALYTICS-BQ'));
ok('analytics uncertainty carries alternate evidence', (body.propagation.uncertain.find((d) => d.id === 'DEC-ANALYTICS-BQ')?.alternate_evidence || []).length > 0);
ok('unrelated decisions explicitly listed as not affected', body.propagation.not_affected.length >= 3);
ok('unrelated decisions carry a reason', body.propagation.not_affected.every((d) => typeof d.reason === 'string' && d.reason.length > 20));
ok('at least one alert raised', body.alerts.length >= 1);
ok('path reaches the decision', (body.path.nodes || []).includes('DEC-EU-LAUNCH'));
ok('explanation names the challenged assumption', body.explanation?.connecting_assumption?.id === 'ASM-DATA-RESIDENCY');
ok('recorded time differs from world validity', body.event.recorded_at > body.event.occurred_at);
ok('uncertainty is reported', (body.uncertainty || []).length > 0);

const afterGraph = router.handle('GET', '/api/graph').body;
const oldFact = afterGraph.nodes.find((n) => n.id === 'FACT-FRANKFURT-EU-CERTIFIED');
const newFact = afterGraph.nodes.find((n) => n.id === 'FACT-FRANKFURT-EU-CERT-LOST');
ok('old fact is marked contradicted', oldFact.state === 'contradicted');
ok('old fact validity was closed', Boolean(oldFact.valid_to));
ok('new fact is marked new_fact', newFact.state === 'new_fact');
ok('decision node shows needs_review', afterGraph.nodes.find((n) => n.id === 'DEC-EU-LAUNCH').state === 'needs_review');
ok('contradicts edge exists', afterGraph.edges.some((e) => e.type === 'contradicts'));
ok('supersedes edge exists', afterGraph.edges.some((e) => e.type === 'supersedes'));

const again = router.handle('POST', '/api/demo/trigger-event', {}, { text: 'Our Frankfurt hosting partner has lost its EU compliance certification.' });
ok('repeat trigger is idempotent', again.status === 200 && again.body.already_applied === true);

const unmatched = router.handle('POST', '/api/demo/trigger-event', {}, { text: 'The office coffee machine is broken again.' });
ok('unmatched event returns 422 unparsed', unmatched.status === 422 && unmatched.body.error.details.unparsed === true);

// ---------------------------------------------------------------- alerts
section('Alert review workflow');
const alertList = router.handle('GET', '/api/alerts').body;
const firstAlert = alertList.alerts[0];
ok('alert starts as NEW', firstAlert.status === 'NEW');
ok('alert explains what changed', typeof firstAlert.what_changed === 'string' && firstAlert.what_changed.length > 10);
ok('alert lists affected decision', (firstAlert.decision_ids || []).length > 0);
ok('alert carries an evidence path', (firstAlert.source_ids || []).length > 0);
ok('alert names relevant people', (firstAlert.people || []).length > 0);

const illegal = router.handle('POST', `/api/alerts/${firstAlert.id}/review-status`, {}, { status: 'NEW' });
ok('illegal transition rejected with 409', illegal.status === 409);
const reviewed = router.handle('POST', `/api/alerts/${firstAlert.id}/review-status`, {}, { status: 'NEEDS_REVIEW', actor: 'Faleesha Zaeen', note: 'Assigning to platform.' });
ok('legal transition accepted', reviewed.status === 200 && reviewed.body.status === 'NEEDS_REVIEW');
ok('review appends history with actor', reviewed.body.history.some((h) => h.actor === 'Faleesha Zaeen'));
const confirmed = router.handle('POST', `/api/alerts/${firstAlert.id}/review-status`, {}, { status: 'CONFIRMED_STALE', actor: 'Faleesha Zaeen' });
ok('confirmed stale accepted', confirmed.status === 200 && confirmed.body.status === 'CONFIRMED_STALE');
const confirmedGraph = router.handle('GET', '/api/graph').body;
ok('confirmed stale propagates to the decision node', confirmedGraph.nodes.find((n) => n.id === firstAlert.decision_ids[0]).state === 'confirmed_stale');

// ---------------------------------------------------------------- experts
section('Contribution-based expertise');
const experts = router.handle('GET', '/api/experts', {}, {}, { system_id: 'SYS-FRANKFURT-HOSTING' }).body;
ok('experts ranked', experts.experts.length >= 2);
ok('hidden expert outranks the listed owner', experts.experts[0].person_id === 'PER-LUKAS-MEYER' && experts.experts[0].is_official_owner === false, experts.experts.map((e) => `${e.person_id}:${e.score}`).join(','));
ok('top expert is discoverable from real contributions', experts.experts[0].contribution_counts.tickets_resolved >= 3);
ok('ranking explanation is provided', experts.experts[0].ranking_explanation.length > 30);
ok('uncertainty and limitations are reported', experts.experts[0].uncertainty.length > 0 && Boolean(experts.experts[0].limitations));
ok('noisy unrelated contributor is excluded with a reason', experts.excluded.some((e) => e.person_id === 'PER-NOAH-FISCHER'));
ok('official owner still appears', experts.experts.some((e) => e.is_official_owner === true));

// ---------------------------------------------------------------- provenance
section('Provenance and bi-temporal history');
const provenance = router.handle('GET', '/api/facts/FACT-FRANKFURT-EU-CERTIFIED/provenance').body;
const kinds = new Set(provenance.chain.map((c) => c.kind));
ok('provenance starts at the original source', kinds.has('original_source'));
ok('provenance includes extracted claim', kinds.has('extracted_claim'));
ok('provenance includes system interpretation', kinds.has('system_interpretation'));
ok('provenance ends in a business decision', kinds.has('business_decision'));
ok('simulated sources are flagged', provenance.chain.filter((c) => c.kind === 'original_source').every((c) => c.simulated === true));

const before = router.handle('GET', '/api/history', {}, {}, { at: '2026-09-01T00:00:00.000Z' }).body;
const lostBefore = before.facts.find((f) => f.id === 'FACT-FRANKFURT-EU-CERT-LOST');
const certBefore = before.facts.find((f) => f.id === 'FACT-FRANKFURT-EU-CERTIFIED');
ok('pre-event view does not know the new fact', lostBefore.belief === 'unknown_yet');
ok('pre-event view believed the certification', certBefore.belief === 'believed_true');
ok('pre-event view shows EU launch as active', before.decisions.find((d) => d.id === 'DEC-EU-LAUNCH').status_at_time === 'active');
ok('pre-event view shows the change later', certBefore.current_state === 'contradicted');

const after = router.handle('GET', '/api/history', {}, {}, { at: '2026-10-16T12:00:00.000Z' }).body;
ok('post-event view knows the new fact', after.facts.find((f) => f.id === 'FACT-FRANKFURT-EU-CERT-LOST').belief === 'believed_true');
ok('post-event view marks the old fact contradicted', after.decisions.find((d) => d.id === 'DEC-EU-LAUNCH').status_now === 'needs_review');
ok('history reports both time axes', after.facts.every((f) => f.valid_from !== undefined && f.recorded_at !== undefined));

// ---------------------------------------------------------------- ingestion
section('Ingestion');
const badType = router.handle('POST', '/api/ingest', {}, { source_type: 'email', text: 'This should be rejected.' });
ok('unsupported source_type rejected', badType.status === 422);
const shortText = router.handle('POST', '/api/ingest', {}, { source_type: 'slack_message', text: 'too short' });
ok('short text rejected', shortText.status === 422);
const badAuthor = router.handle('POST', '/api/ingest', {}, { source_type: 'slack_message', text: 'A statement about the checkout service.', author_id: 'PER-NOPE' });
ok('unknown author rejected', badAuthor.status === 422);
const ingested = router.handle('POST', '/api/ingest', {}, {
  source_type: 'slack_message', title: '#platform-infra', author_id: 'PER-ANA-SILVA',
  text: 'Frankfurt edge deploy is green again. The checkout service p95 is still under the latency budget after the change.',
});
ok('valid ingestion returns 201', ingested.status === 201, `status ${ingested.status}`);
ok('ingestion returns extraction with claims', ingested.body.extraction.claims.length > 0);
ok('unreviewed claims are flagged', ingested.body.extraction.claims.some((c) => c.needs_review === true));
ok('ingestion reports graph delta', ingested.body.graph_delta.nodes_added.length > 0);
ok('ingestion does not invent alerts', ingested.body.impact.alerts_created.length === 0);
const integrations = router.handle('GET', '/api/ingest/integrations').body;
ok('integrations report no live providers', integrations.integrations.every((i) => i.available === false || i.mechanism === 'paste_or_upload'));

// ---------------------------------------------------------------- decisions
const decision = router.handle('GET', '/api/decisions/DEC-EU-LAUNCH').body;
ok('decision detail includes assumptions', decision.assumptions.length > 0);
ok('decision detail includes sources', decision.sources.length > 0);
ok('decision detail includes history', decision.history.length > 0);
ok('decision detail reports unavailable relations honestly', Array.isArray(decision.unavailable));
const explanation = router.handle('GET', '/api/decisions/DEC-EU-LAUNCH/explanation').body;
ok('explanation lists why it was flagged', explanation.why_flagged.length >= 3);
ok('explanation includes the graph path', explanation.path.nodes.length >= 3);
ok('explanation lists supporting sources', explanation.supporting_sources.length > 0);
ok('explanation reports uncertainty', explanation.uncertainty.length > 0);
ok('explanation suggests investigators', explanation.suggested_investigators.length > 0);
const pathRes = router.handle('GET', '/api/graph/path', {}, {}, { from: 'FACT-FRANKFURT-EU-CERT-LOST', to: 'DEC-EU-LAUNCH' });
ok('graph path endpoint connects the fact to the decision', pathRes.status === 200 && pathRes.body.found);
const disconnected = router.handle('GET', '/api/graph/path', {}, {}, { from: 'FACT-FRANKFURT-EU-CERT-LOST', to: 'PER-NOAH-FISCHER' });
ok('unconnected path returns not_connected', disconnected.status === 404 && disconnected.body.error.code === 'not_connected');
const missing = router.handle('GET', '/api/decisions/DEC-DOES-NOT-EXIST');
ok('invalid identifier returns 404', missing.status === 404 && missing.body.error.code === 'not_found');
const wrongMethod = router.handle('DELETE', '/api/graph');
ok('unsupported method returns 405', wrongMethod.status === 405);

// ---------------------------------------------------------------- reset
section('Reset');
const reset = router.handle('POST', '/api/demo/reset').body;
ok('reset restores baseline phase', reset.demo_state.phase === 'baseline');
ok('reset clears alerts', router.handle('GET', '/api/alerts').body.total === 0);
ok('reset restores the exact baseline graph', JSON.stringify(router.handle('GET', '/api/graph').body) === baselineSnapshot);
const retrigger = router.handle('POST', '/api/demo/trigger-event', {}, { text: 'Our Frankfurt hosting partner has lost its EU compliance certification.' });
ok('reset makes the demo reproducible', retrigger.status === 201 && retrigger.body.alerts.length === body.alerts.length);
ok('replay produces identical propagation', JSON.stringify(retrigger.body.propagation) === JSON.stringify(body.propagation));

// ---------------------------------------------------------------- summary
section('Summary');
process.stdout.write(`  ${checks - failures}/${checks} checks passed\n`);
process.stdout.write(`  nodes: ${dataset.nodes.length}  edges: ${dataset.edges.length}  sources: ${dataset.sources.length}\n`);
process.stdout.write(`  alerts after trigger: ${body.alerts.length} (flagged decisions ${body.propagation.decisions.length}, uncertain ${body.propagation.uncertain.length}, unaffected ${body.propagation.not_affected.length})\n`);
if (failures > 0) {
  process.stdout.write(`\n${failures} CHECK(S) FAILED\n`);
  process.exit(1);
}
process.stdout.write('\nAll deterministic checks passed.\n');
