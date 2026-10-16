import { describe, expect, it } from 'vitest';
import { createTripwireClient } from './client';
import { buildUrl, createEngineTransport, createHttpTransport, TripwireApiError } from './transport';
import { connect } from './index';

const TRIGGER_TEXT = 'Our Frankfurt hosting partner has lost its EU compliance certification.';

describe('buildUrl', () => {
  it('joins base and path without duplicating slashes', () => {
    expect(buildUrl('http://localhost:8787/', '/api/health')).toBe('http://localhost:8787/api/health');
  });

  it('drops empty query values and keeps meaningful ones', () => {
    const url = buildUrl('http://x.test', '/api/graph', { types: 'fact,decision', q: '', depth: 2, project_id: undefined });
    expect(url).toBe('http://x.test/api/graph?types=fact%2Cdecision&depth=2');
  });
});

describe('engine transport (mock mode)', () => {
  const client = createTripwireClient(createEngineTransport());

  it('serves the reference dataset and advertises mock mode', async () => {
    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.mode).toBe('mock-backend');
    expect(health.counts.nodes).toBeGreaterThan(0);
  });

  it('exposes the storyline ids without the UI hardcoding them', async () => {
    const state = await client.demoState();
    expect(state.phase).toBe('baseline');
    expect(state.storyline.fact_id).toBe('FACT-FRANKFURT-EU-CERTIFIED');
    expect(state.storyline.decision_id).toBe('DEC-EU-LAUNCH');
    expect(state.storyline.trigger_text).toContain('Frankfurt hosting partner');
  });

  it('returns a graph with typed nodes and edges', async () => {
    const graph = await client.graph();
    expect(graph.nodes.length).toBeGreaterThan(50);
    expect(graph.edges.length).toBeGreaterThan(50);
    expect(graph.truncated).toBe(false);
    for (const type of ['fact', 'assumption', 'decision', 'person'] as const) {
      expect(graph.nodes.some((n) => n.type === type)).toBe(true);
    }
  });

  it('applies the trigger event and reports propagation honestly', async () => {
    const fresh = createTripwireClient(createEngineTransport());
    const result = await fresh.triggerEvent({ text: TRIGGER_TEXT });

    expect(result.already_applied).toBe(false);
    expect(result.event.type).toBe('certification_lost');
    expect(result.propagation.decisions.map((d) => d.id)).toContain('DEC-EU-LAUNCH');
    // not_affected and uncertain must be reported, not collapsed into `decisions`
    expect(result.propagation.not_affected.length).toBeGreaterThan(0);
    expect(result.alerts.length).toBeGreaterThan(0);
    expect(result.explanation?.why_flagged.length ?? 0).toBeGreaterThan(0);
    // the propagation path is the causal chain: new fact -> old fact -> assumption -> decision
    expect(result.path.nodes).toContain('DEC-EU-LAUNCH');
    expect(result.path.nodes).toContain('ASM-DATA-RESIDENCY');
    expect(result.path.edges.map((e) => e.type)).toContain('contradicts');
    expect(result.path.narration?.length).toBeGreaterThan(0);
  });

  it('is idempotent on a repeated trigger', async () => {
    const client2 = createTripwireClient(createEngineTransport());
    await client2.triggerEvent({ text: TRIGGER_TEXT });
    const again = await client2.triggerEvent({ text: TRIGGER_TEXT });
    expect(again.already_applied).toBe(true);
  });

  it('rejects unrelated event text with a validation error', async () => {
    const client3 = createTripwireClient(createEngineTransport());
    await expect(client3.triggerEvent({ text: 'The office coffee machine is broken again.' })).rejects.toThrow(
      TripwireApiError,
    );
  });

  it('reset restores the baseline phase', async () => {
    const client4 = createTripwireClient(createEngineTransport());
    await client4.triggerEvent({ text: TRIGGER_TEXT });
    const reset = await client4.resetDemo();
    expect(reset.status).toBe('reset');
    const state = await client4.demoState();
    expect(state.phase).toBe('baseline');
    expect(state.counts.alerts_open).toBe(0);
  });

  it('surfaces a 404 as a typed error instead of a silent empty render', async () => {
    await expect(client.decision('DEC-DOES-NOT-EXIST')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});

describe('connect() mode resolution', () => {
  it('falls back to mock with an explicit reason when the backend is unreachable', async () => {
    const failingFetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const connection = await connect({ requestedMode: 'auto', baseUrl: 'http://127.0.0.1:1', fetchImpl: failingFetch });

    expect(connection.resolvedMode).toBe('mock');
    expect(connection.reason).toMatch(/no backend/i);
    expect(connection.probeError).not.toBeNull();
    expect((await connection.client.health()).mode).toBe('mock-backend');
  });

  it('keeps live mode when the probe succeeds', async () => {
    const okFetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 'ok', mode: 'production' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch;

    const connection = await connect({ requestedMode: 'auto', baseUrl: 'http://backend.test', fetchImpl: okFetch });
    expect(connection.resolvedMode).toBe('live');
    expect(connection.client.baseUrl).toBe('http://backend.test');
  });

  it('never silently substitutes fixtures in explicit live mode', async () => {
    const failingFetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const connection = await connect({ requestedMode: 'live', baseUrl: 'http://127.0.0.1:1', fetchImpl: failingFetch });
    expect(connection.resolvedMode).toBe('live');
    expect(connection.probeError).not.toBeNull();
  });

  it('honours explicit mock mode without probing the network', async () => {
    const explodingFetch = (() => {
      throw new Error('fetch must not be called in mock mode');
    }) as unknown as typeof fetch;
    const connection = await connect({ requestedMode: 'mock', fetchImpl: explodingFetch });
    expect(connection.resolvedMode).toBe('mock');
    expect((await connection.client.health()).mode).toBe('mock-backend');
  });
});

describe('http transport', () => {
  it('turns a backend error envelope into a typed error', async () => {
    const errorFetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'Decision DEC-999 not found', details: {} } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch;

    const client = createTripwireClient(createHttpTransport({ baseUrl: 'http://backend.test', fetchImpl: errorFetch }));
    await expect(client.decision('DEC-999')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('reports an unreachable backend as offline rather than a crash', async () => {
    const failingFetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const client = createTripwireClient(createHttpTransport({ baseUrl: 'http://127.0.0.1:1', fetchImpl: failingFetch }));
    const error = await client.health().catch((e: unknown) => e as TripwireApiError);

    expect(error).toBeInstanceOf(TripwireApiError);
    expect((error as TripwireApiError).isOffline).toBe(true);
  });
});
