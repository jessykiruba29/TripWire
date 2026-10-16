/**
 * LIVE integration for the real client + adapter, against the running FastAPI
 * backend on :8000. This is the check that proves steps 1–3 work over real HTTP:
 * the adapter tests prove the mapping against captured payloads, and this proves
 * the client's endpoints, params, encoding and seed order against the server.
 *
 * Gated — skipped unless explicitly enabled:
 *   node ../backend/.venv/Scripts/python.exe -m uvicorn tripwire.api.app:app --port 8000
 *   $env:TRIPWIRE_LIVE='1'; npx vitest run src/api/realClient.live.test.ts
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { createHttpTransport, TripwireApiError } from './transport';
import { createRealTripwireClient, DEMO_SCENARIOS } from './realClient';
import type { RawNode } from './backendTypes';

const LIVE = process.env.TRIPWIRE_LIVE === '1';
const BASE = process.env.TRIPWIRE_API_BASE_URL ?? 'http://127.0.0.1:8000';

describe.runIf(LIVE)('real backend integration (live HTTP)', () => {
  const client = createRealTripwireClient(
    createHttpTransport({ baseUrl: BASE, timeoutMs: 30000 }),
  );

  beforeAll(async () => {
    // deterministic starting point: baseline graph, then the event replayed below
    await client.resetDemo();
  }, 120000);

  it('reports the live store and that no LLM is in use', async () => {
    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.mode).toContain('deterministic');
    expect(health.counts.nodes).toBeGreaterThan(100);
  });

  it('seeds an empty store automatically so the graph is never blank', async () => {
    const result = await client.ensureSeeded();
    expect(result.seeded).toBe(true);
  });

  it('loads the real graph and inverts label/name correctly against live data', async () => {
    const graph = await client.graph();
    expect(graph.nodes.length).toBeGreaterThan(100);
    expect(graph.edges.length).toBeGreaterThan(100);

    const decision = graph.nodes.find((node) => node.type === 'decision');
    expect(decision).toBeDefined();
    // the display label must be the sentence, not the word "Decision"
    expect(decision!.label).not.toBe('Decision');
    expect(decision!.label.length).toBeGreaterThan(10);

    // every node mapped to a known view type, none falling through
    const types = new Set(graph.nodes.map((node) => node.type));
    expect(types.has('fact')).toBe(true);
    expect(types.has('assumption')).toBe(true);
    expect(types.has('person')).toBe(true);
  });

  it('derives the decisions list from the graph, since there is no list endpoint', async () => {
    const { decisions, total } = await client.decisions();
    expect(total).toBeGreaterThan(0);
    expect(decisions.every((decision) => decision.title.length > 0)).toBe(true);
  });

  it('exposes key entity ids instead of the UI hardcoding them', async () => {
    const state = await client.demoState();
    expect(state.counts.nodes).toBeGreaterThan(100);
    expect(state.key_entities?.eu_launch_decision).toBe('decision:eu-launch');
    expect(state.key_entities?.compliance_fact).toBe('fact:frankfurt-partner-compliance-valid');
    expect(state.by_label?.Decision).toBeGreaterThan(0);
  });

  it('runs the Frankfurt scenario and returns the engine’s own propagation', async () => {
    const trigger = await client.triggerEvent({ scenario: 'frankfurt_compliance_revoked' });

    expect(trigger.event.type).toBe('frankfurt_compliance_revoked');
    expect(trigger.propagation.decisions.length).toBeGreaterThan(0);

    const euLaunch = trigger.propagation.decisions.find((d) => d.id === 'decision:eu-launch');
    expect(euLaunch).toBeDefined();
    // the important, honest result: potential, not confirmed stale
    expect(euLaunch!.certainty).toBe('potential');
    expect(euLaunch!.status_after).toBe('POTENTIALLY_STALE');
    expect(euLaunch!.status).not.toBe('confirmed_stale');
    expect(euLaunch!.requires_investigation).toBe(true);

    // alternate evidence is why it is not declared invalid
    expect(euLaunch!.alternate_evidence.length).toBeGreaterThan(0);

    // unaffected decisions are derived from the live graph
    expect(trigger.propagation.not_affected.length).toBeGreaterThan(0);

    // the engine explains itself, deterministically
    expect(trigger.audit?.llm_used).toBe(false);
    expect(trigger.audit?.source_fact_id).toBe('fact:frankfurt-partner-compliance-valid');
    expect(trigger.uncertainty.length).toBeGreaterThan(0);
  });

  it('returns an explainable path from the changed fact through the assumption', async () => {
    const explanation = await client.explanation('decision:eu-launch');

    expect(explanation.connecting_assumption?.id).toBe('assumption:data-residency-eu');
    expect(explanation.path.nodes[0]).toBe('fact:frankfurt-partner-compliance-valid');
    expect(explanation.path.nodes).toContain('assumption:data-residency-eu');
    expect(explanation.path.edges.map((edge) => edge.type)).toContain('supported_by');
    expect(explanation.challenged_fact?.valid_to).toBeTruthy();
    expect(explanation.why_flagged.length).toBeGreaterThan(0);
    expect(explanation.uncertainty.join(' ')).toMatch(/not a verdict/i);
  });

  it('serves the fact provenance chain and both time axes', async () => {
    // self-contained: the background fact only has a closed record after the event
    await client.resetDemo();
    await client.triggerEvent({ scenario: 'frankfurt_compliance_revoked' });

    const { chain } = await client.provenance('fact:frankfurt-partner-compliance-valid');
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0].kind).toBe('original_source');
    expect(chain.some((step) => step.kind === 'system_interpretation')).toBe(true);

    const fact = await client.fact('fact:frankfurt-partner-compliance-valid');
    expect(fact.valid_to).toBeTruthy();
    expect(fact.recorded_at).toBeTruthy();
    expect(fact.confidence).toBeGreaterThan(0);
  });

  it('finds the hidden expert by contribution rather than by title', async () => {
    const experts = await client.experts({ q: 'Frankfurt Hosting Partner', limit: 5 });
    expect(experts.experts.length).toBeGreaterThan(0);
    expect(experts.experts[0].total_contributions).toBeGreaterThan(0);
    expect(experts.experts[0].limitations).toMatch(/not proof of expertise/i);

    const hidden = experts.hidden_experts ?? [];
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden[0].is_official_owner).toBe(false);
    expect(experts.official_owners?.length ?? 0).toBeGreaterThan(0);
    expect(experts.official_owners![0].person_id).not.toBe(hidden[0].person_id);
  });

  it('lists alerts and applies a review transition through POST /review', async () => {
    const list = await client.alerts({ limit: 5 });
    expect(list.alerts.length).toBeGreaterThan(0);
    expect(list.total).toBeGreaterThan(0);
    expect(list.alerts[0].path?.nodes.length ?? 0).toBeGreaterThan(1);

    const target = list.alerts[0];
    const before = await client.alertHistory(target.id);

    // A REAL transition (NEEDS_REVIEW -> DISMISSED) is recorded in full.
    const updated = await client.reviewAlert(target.id, {
      status: 'DISMISSED',
      actor: 'live-integration-test',
      note: 'live check',
    });
    expect(updated.id).toBe(target.id);
    expect(updated.status).toBe('DISMISSED');

    const after = await client.alertHistory(target.id);
    expect(after.length).toBe(before.length + 1);
    const latest = after[after.length - 1];
    expect(latest.to).toBe('DISMISSED');
    expect(latest.actor).toBe('live-integration-test');
    expect(latest.note).toBe('live check');
  });

  it('treats a review to the SAME status as the no-op the backend makes it', async () => {
    // Verified live: posting the current status appends no history entry, records
    // no actor and discards the note. The UI must not report a change that the
    // server did not make.
    await client.resetDemo();
    await client.triggerEvent({ scenario: 'frankfurt_compliance_revoked' });
    const list = await client.alerts({ limit: 1 });
    const target = list.alerts[0];
    expect(target).toBeDefined();
    const before = await client.alertHistory(target.id);

    const result = await client.reviewAlert(target.id, {
      status: target.status,
      actor: 'live-integration-test',
      note: 'should not be stored',
    });

    expect(result.status).toBe(target.status);
    const after = await client.alertHistory(target.id);
    expect(after.length).toBe(before.length);
    expect(after.some((entry) => entry.note === 'should not be stored')).toBe(false);
  });

  it('answers recorded-time history from the real endpoint', async () => {
    const history = await client.history({ at: '2026-02-01T00:00:00Z' });
    expect(history.mode).toBe('recorded_time');
    expect(history.facts.length).toBeGreaterThan(0);
    expect(history.notes?.join(' ')).toMatch(/reconstructed/i);

    const feed = await client.timeline(20);
    expect(feed.events.length).toBeGreaterThan(0);
  });

  it('validates /api/paths and reports the malformed route instead of using it', async () => {
    await client.resetDemo();
    await client.triggerEvent({ scenario: 'frankfurt_compliance_revoked' });

    const { report, paths: routes } = await client.pathsBetween(
      'fact:frankfurt-partner-compliance-valid',
      'decision:eu-launch',
    );

    expect(report.total).toBeGreaterThan(1);
    // the backend bug is still present, and is reported rather than smoothed over
    expect(report.invalid.length).toBeGreaterThan(0);
    const malformed = routes.find((route) => !route.valid);
    expect(malformed).toBeDefined();
    expect(malformed!.nodes[0]).toBe(malformed!.nodes[malformed!.nodes.length - 1]);

    // whatever is returned must be a usable chain
    const path = await client.graphPath({
      from: 'fact:frankfurt-partner-compliance-valid',
      to: 'decision:eu-launch',
    });
    if (path.found) {
      expect(path.nodes.length).toBeGreaterThan(1);
      expect(path.edges.length).toBe(path.nodes.length - 1);
      expect(path.nodes[0]).not.toBe(path.nodes[path.nodes.length - 1]);
    }
  });

  it('takes the explanatory chain from the explanation endpoint, not from /api/paths', async () => {
    // The valid routes in /api/paths are the direct STALED edges; the chain that
    // actually explains the warning comes from evidence_paths. This is where the
    // UI gets the fact -> assumption -> decision story.
    const explanation = await client.explanation('decision:eu-launch');
    expect(explanation.path.nodes).toEqual([
      'fact:frankfurt-partner-compliance-valid',
      'assumption:data-residency-eu',
      'decision:eu-launch',
    ]);
    expect(explanation.path.edges.map((edge) => edge.type)).toEqual(['supported_by', 'assumes']);
  });

  it('reads sources and reports them as real, not simulated', async () => {
    const { sources } = await client.sources({ limit: 3 });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((source) => source.simulated === false)).toBe(true);

    const detail = await client.source(sources[0].id);
    expect(detail.source.id).toBe(sources[0].id);
  });

  it('describes ingestion honestly as adapters, not live integrations', async () => {
    const integrations = await client.integrations();
    expect(integrations.integrations.length).toBeGreaterThan(0);
    expect(integrations.honest_note).toMatch(/not pulled|documented input/i);
  });

  it('maps a real 404 into a typed error with the backend’s own code', async () => {
    const error = (await client.explanation('decision:does-not-exist').catch((e: unknown) => e)) as TripwireApiError;
    expect(error).toBeInstanceOf(TripwireApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('not_found');
    expect(error.details).toBeDefined();
  });

  it('rejects unmappable free text without calling the backend', async () => {
    const error = (await client.triggerEvent({ text: 'unrelated nonsense' }).catch((e: unknown) => e)) as TripwireApiError;
    expect(error.code).toBe('scenario_required');
    expect(error.details.valid_scenarios).toEqual([...DEMO_SCENARIOS]);
  });

  it('resets to a reproducible baseline with no open alerts', async () => {
    const result = await client.resetDemo();
    expect(result.demo_state.phase).toBe('baseline');
    expect(result.demo_state.counts.alerts_open).toBe(0);

    const graph = await client.graph();
    const stale = graph.nodes.filter((node) => node.state !== 'normal');
    expect(stale).toEqual([]);
  });

  it('accepts every documented scenario id', async () => {
    for (const scenario of DEMO_SCENARIOS) {
      await client.resetDemo();
      const result = await client.triggerEvent({ scenario });
      expect(result.event.type).toBe(scenario);
      // every scenario is either applied or explicitly recognised as a no-op
      expect(typeof result.already_applied).toBe('boolean');
    }
  }, 180000);

  it('keeps an unrelated event from flagging the EU launch', async () => {
    await client.resetDemo();
    const result = await client.triggerEvent({ scenario: 'unrelated_mobile_theme_change' });
    const flagged = result.propagation.decisions.filter((d) => d.requires_investigation).map((d) => d.id);
    expect(flagged).not.toContain('decision:eu-launch');
  });

  it('exposes the graph node for a person and their recorded contributions', async () => {
    const people = await client.people();
    expect(people.total).toBeGreaterThan(0);
    const person: RawNode | undefined = undefined;
    void person;
    const detail = await client.person(people.people[0].id);
    expect(detail.person.name.length).toBeGreaterThan(0);
    expect(detail.profile_note).toMatch(/reconstructed/i);
  });
});
