/**
 * LIVE verification of the application's own boot path against the real backend.
 *
 * This is the test that answers "does the website load graph data from port 8000":
 * it runs exactly what `App` runs — `connect()` → seed → health → demo state →
 * graph → decisions → alerts — with the real HTTP transport, and asserts the
 * resulting application-shaped data.
 *
 * Gated:  $env:TRIPWIRE_LIVE='1'; npx vitest run src/app.mode.live.test.ts
 */

import { describe, expect, it } from 'vitest';
import { connect, DEMO_SCENARIOS } from './api';

const LIVE = process.env.TRIPWIRE_LIVE === '1';
const BASE = process.env.TRIPWIRE_API_BASE_URL ?? 'http://127.0.0.1:8000';

describe.runIf(LIVE)('application boot against the real backend', () => {
  it('resolves live mode, seeds if needed, and loads the real graph', async () => {
    const connection = await connect({ requestedMode: 'live', baseUrl: BASE });

    // mode resolution must be honest
    expect(connection.resolvedMode).toBe('live');
    expect(connection.probeError).toBeNull();
    expect(connection.client.kind).toBe('real');
    expect(connection.client.capabilities.scenarioTrigger).toBe(true);
    expect(connection.client.capabilities.kindIsLabel).toBe(true);

    const client = connection.client;

    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.counts.nodes).toBeGreaterThan(100);

    const demoState = await client.demoState();
    expect(demoState.counts.nodes).toBeGreaterThan(100);
    expect(demoState.key_entities?.eu_launch_decision).toBe('decision:eu-launch');

    // the graph the UI actually renders
    const graph = await client.graph();
    expect(graph.nodes.length).toBeGreaterThan(100);
    expect(graph.edges.length).toBeGreaterThan(100);
    expect(graph.truncated).toBe(false);

    // the label/name inversion, against live data
    const decision = graph.nodes.find((node) => node.type === 'decision');
    expect(decision).toBeDefined();
    expect(decision!.label).not.toBe('Decision');
    expect(decision!.label.length).toBeGreaterThan(10);

    // every backend kind mapped to a view type
    const types = new Set(graph.nodes.map((node) => node.type));
    for (const expected of ['fact', 'assumption', 'decision', 'project', 'person', 'system', 'event']) {
      expect(types.has(expected as never)).toBe(true);
    }

    // decisions derived from the graph, since there is no list endpoint
    const { decisions } = await client.decisions();
    expect(decisions.length).toBeGreaterThan(0);

    // alerts endpoint reachable from boot
    const alerts = await client.alerts();
    expect(alerts).toHaveProperty('alerts');
  }, 120000);

  it('never silently substitutes mock data when live mode is requested', async () => {
    // a port with nothing behind it: live mode must stay live and report the error
    const connection = await connect({ requestedMode: 'live', baseUrl: 'http://127.0.0.1:9' });
    expect(connection.resolvedMode).toBe('live');
    expect(connection.probeError).not.toBeNull();
    expect(connection.client.kind).toBe('real');
  }, 60000);

  it('falls back to the reference engine in auto mode and labels it as mock', async () => {
    const connection = await connect({ requestedMode: 'auto', baseUrl: 'http://127.0.0.1:9' });
    expect(connection.resolvedMode).toBe('mock');
    expect(connection.client.kind).toBe('reference');
    expect(connection.reason).toMatch(/no backend/i);
    // and the fixture engine still serves a usable graph
    const graph = await connection.client.graph();
    expect(graph.nodes.length).toBeGreaterThan(0);
  }, 60000);

  it('runs the full demo story through the application client', async () => {
    const connection = await connect({ requestedMode: 'live', baseUrl: BASE });
    const client = connection.client;

    await client.resetDemo();
    const scenarios = await client.scenarios?.();
    const ids = (scenarios ?? []).map((scenario) => scenario.id);
    for (const id of DEMO_SCENARIOS) expect(ids).toContain(id);

    const trigger = await client.triggerEvent({ scenario: 'frankfurt_compliance_revoked' });

    // the narrative the presentation depends on, verified end to end
    const euLaunch = trigger.propagation.decisions.find((decision) => decision.id === 'decision:eu-launch');
    expect(euLaunch).toBeDefined();
    expect(euLaunch!.certainty).toBe('potential');
    expect(euLaunch!.status_after).toBe('POTENTIALLY_STALE');
    expect(euLaunch!.status).not.toBe('confirmed_stale');
    expect(euLaunch!.requires_investigation).toBe(true);
    expect(euLaunch!.alternate_evidence.length).toBeGreaterThan(0);

    // confirmed-stale entities do exist, and are distinguishable
    const confirmed = (trigger.entity_impacts ?? []).filter((impact) => impact.certainty === 'confirmed');
    expect(confirmed.length).toBeGreaterThan(0);

    // unaffected decisions were derived and reported
    expect(trigger.propagation.not_affected.length).toBeGreaterThan(0);

    // the explanation the panel renders
    expect(trigger.explanation?.connecting_assumption?.id).toBe('assumption:data-residency-eu');
    expect(trigger.explanation?.path.nodes).toContain('assumption:data-residency-eu');

    // alerts were raised and are readable
    expect(trigger.alerts.length).toBeGreaterThan(0);
    expect(trigger.alerts[0].path?.nodes.length ?? 0).toBeGreaterThan(1);

    // experts by contribution, with the hidden expert
    const experts = await client.experts({ q: 'Frankfurt Hosting Partner', limit: 5 });
    expect(experts.experts.length).toBeGreaterThan(0);
    expect((experts.hidden_experts ?? []).length).toBeGreaterThan(0);
    expect(experts.hidden_experts![0].is_official_owner).toBe(false);
  }, 180000);

  it('keeps the pricing project distinguishable from the EU launch', async () => {
    const connection = await connect({ requestedMode: 'live', baseUrl: BASE });
    const client = connection.client;
    await client.resetDemo();
    const trigger = await client.triggerEvent({ scenario: 'frankfurt_compliance_revoked' });

    const pricing = (trigger.entity_impacts ?? []).find((impact) => impact.id.includes('pricing'));
    const euLaunch = (trigger.entity_impacts ?? []).find((impact) => impact.id === 'decision:eu-launch');

    expect(pricing).toBeDefined();
    expect(euLaunch).toBeDefined();
    // they are reported separately, with their own reasons
    expect(pricing!.reason.length).toBeGreaterThan(0);
    expect(euLaunch!.reason.length).toBeGreaterThan(0);
  }, 180000);
});
