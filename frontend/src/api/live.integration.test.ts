/**
 * Live integration test: exercises the app's real HTTP client against a RUNNING
 * Tripwire backend. This is the check that proves the contract works end to end —
 * it is not a mock, and it is skipped unless explicitly enabled.
 *
 *   node ../mock-backend/server.js           # or the real backend
 *   $env:TRIPWIRE_LIVE='1'; npx vitest run src/api/live.integration.test.ts
 *
 * Enable with `TRIPWIRE_LIVE=1` (optionally `TRIPWIRE_API_BASE_URL`).
 */

import { describe, expect, it } from 'vitest';
import { createHttpTransport } from './transport';
import { createTripwireClient } from './client';

const LIVE = process.env.TRIPWIRE_LIVE === '1';
const BASE = process.env.TRIPWIRE_API_BASE_URL ?? 'http://127.0.0.1:8787';
const TRIGGER = 'Our Frankfurt hosting partner has lost its EU compliance certification.';

describe.runIf(LIVE)('live backend integration', () => {
  const client = createTripwireClient(createHttpTransport({ baseUrl: BASE, timeoutMs: 20000 }));

  it('answers /api/health with a mode string the UI can render verbatim', async () => {
    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(typeof health.mode).toBe('string');
    expect(health.counts.nodes).toBeGreaterThan(0);
  });

  it('serves a graph the UI can filter and lay out', async () => {
    const graph = await client.graph();
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.truncated).toBe(false);
    for (const node of graph.nodes) {
      expect(typeof node.id).toBe('string');
      expect(typeof node.type).toBe('string');
      expect(typeof node.state).toBe('string');
    }
  });

  it('reports the storyline ids instead of the UI hardcoding them', async () => {
    const state = await client.demoState();
    expect(state.storyline.trigger_text).toContain('Frankfurt hosting partner');
    expect(state.storyline.decision_id).toBeTruthy();
  });

  it('flags a decision at the baseline without pretending a chain exists', async () => {
    await client.resetDemo();
    const explanation = await client.explanation('DEC-EU-LAUNCH');
    // At the baseline there is no contradiction: new_information is null and the
    // headline says so. The UI renders that state explicitly.
    expect(explanation.new_information).toBeNull();
    expect(explanation.headline.length).toBeGreaterThan(0);
  });

  it('applies the Frankfurt event end to end and returns a usable propagation payload', async () => {
    await client.resetDemo();
    const result = await client.triggerEvent({ text: TRIGGER });

    expect(result.already_applied).toBe(false);
    expect(result.graph_revision).toBeGreaterThan(1);

    // the three groups the UI renders separately
    expect(result.propagation.decisions.length).toBeGreaterThan(0);
    expect(result.propagation.not_affected.length).toBeGreaterThan(0);

    // the causal chain the graph highlights, hop by hop
    expect(result.path.nodes).toContain('DEC-EU-LAUNCH');
    expect(result.path.nodes).toContain('ASM-DATA-RESIDENCY');
    expect(result.path.edges.map((e) => e.type)).toContain('contradicts');
    expect(result.path.narration?.length ?? 0).toBeGreaterThan(0);

    // reasoning, uncertainty and alternate evidence are all present
    expect(result.explanation?.why_flagged.length ?? 0).toBeGreaterThan(0);
    expect(result.alerts.length).toBeGreaterThan(0);

    // the explanation endpoint agrees with the trigger response
    const explanation = await client.explanation('DEC-EU-LAUNCH');
    expect(explanation.new_information?.fact_id).toBe(result.extraction?.new_fact.id);
    expect(explanation.challenged_fact?.id).toBe(result.extraction?.contradicted_fact.id);
    expect(explanation.path.nodes.length).toBeGreaterThan(0);
  });

  it('serves provenance levels, experts and recorded-time history for the panels', async () => {
    const newFactId = 'FACT-FRANKFURT-EU-CERT-LOST';

    const provenance = await client.provenance(newFactId);
    expect(provenance.chain.length).toBeGreaterThan(0);

    const experts = await client.experts({ system_id: 'SYS-FRANKFURT-HOSTING' });
    expect(experts.experts.length).toBeGreaterThan(0);
    expect(experts.experts[0].limitations.length).toBeGreaterThan(0);
    expect(experts.experts[0].ranking_explanation.length).toBeGreaterThan(0);

    const history = await client.history({ at: '2026-09-01T00:00:00.000Z' });
    expect(history.mode).toBe('recorded_time');
    expect(history.facts.length).toBeGreaterThan(0);
    const lost = history.facts.find((f) => f.id === newFactId);
    // before the event was recorded, Tripwire did not know about it
    expect(lost?.belief).toBe('unknown_yet');

    const timeline = await client.timeline(10);
    expect(timeline.events.length).toBeGreaterThan(0);
  });

  it('accepts a review transition and only then reflects the new status', async () => {
    const before = await client.alerts();
    expect(before.alerts.length).toBeGreaterThan(0);
    const target = before.alerts[0];

    const updated = await client.reviewAlert(target.id, {
      status: 'NEEDS_REVIEW',
      note: 'Live integration check',
      actor: 'integration-test',
    });

    expect(updated.status).toBe('NEEDS_REVIEW');
    expect(updated.history.some((h) => h.note === 'Live integration check')).toBe(true);

    // the graph reflects the review state on the decision node
    const graph = await client.graph();
    expect(graph.nodes.find((n) => n.id === target.decision_ids[0])?.state).toBe('needs_review');
  });

  it('restores the exact baseline on reset, so the demo is repeatable', async () => {
    const first = await client.triggerEvent({ text: TRIGGER });
    const reset = await client.resetDemo();
    expect(reset.status).toBe('reset');
    expect(reset.demo_state.phase).toBe('baseline');
    expect(reset.demo_state.counts.alerts_open).toBe(0);

    const replay = await client.triggerEvent({ text: TRIGGER });
    expect(replay.propagation.decisions.map((d) => d.id)).toEqual(first.propagation.decisions.map((d) => d.id));
    expect(replay.path.nodes).toEqual(first.path.nodes);
  });

  it('rejects event text it cannot link to the graph, with a typed error', async () => {
    const error = await client.triggerEvent({ text: 'The office coffee machine is broken again.' }).catch((e) => e);
    expect(error).toMatchObject({ status: 422, isValidation: true });
  });
});
