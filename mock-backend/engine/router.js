/**
 * Transport-agnostic request router for the Tripwire contract.
 * Used by mock-backend/server.js (Node HTTP) and by the in-browser mock adapter,
 * so both paths exercise exactly the same implementation.
 */

import { ApiError } from './errors.js';
import { TripwireStore } from './store.js';

const ROUTES = [
  ['GET', /^\/api\/health$/, (s) => s.health()],
  ['GET', /^\/api\/demo\/state$/, (s) => s.demoState()],
  ['POST', /^\/api\/demo\/trigger-event$/, (s, m, body) => s.triggerEvent(body)],
  ['POST', /^\/api\/demo\/reset$/, (s) => ({ status: 'reset', revision: 1, demo_state: s.reset() })],
  ['GET', /^\/api\/graph\/path$/, (s, m, b, q) => s.path(q.from, q.to)],
  ['GET', /^\/api\/graph$/, (s, m, b, q) => s.graph(q)],
  ['GET', /^\/api\/decisions\/([^/]+)\/explanation$/, (s, m) => s.explanation(decodeURIComponent(m[1]))],
  ['GET', /^\/api\/decisions\/([^/]+)$/, (s, m) => s.decision(decodeURIComponent(m[1]))],
  ['GET', /^\/api\/decisions$/, (s) => s.decisions()],
  ['GET', /^\/api\/alerts$/, (s, m, b, q) => s.alerts(q)],
  ['POST', /^\/api\/alerts\/([^/]+)\/review-status$/, (s, m, body) => s.reviewAlert(decodeURIComponent(m[1]), body)],
  ['GET', /^\/api\/alerts\/([^/]+)$/, (s, m) => s.alert(decodeURIComponent(m[1]))],
  ['GET', /^\/api\/facts\/([^/]+)\/provenance$/, (s, m) => s.provenance(decodeURIComponent(m[1]))],
  ['GET', /^\/api\/facts\/([^/]+)$/, (s, m) => s.fact(decodeURIComponent(m[1]))],
  ['GET', /^\/api\/facts$/, (s, m, b, q) => s.facts(q)],
  ['GET', /^\/api\/sources\/([^/]+)$/, (s, m) => s.source(decodeURIComponent(m[1]))],
  ['GET', /^\/api\/sources$/, (s, m, b, q) => s.sources(q)],
  ['GET', /^\/api\/history$/, (s, m, b, q) => s.history(q)],
  ['GET', /^\/api\/timeline$/, (s, m, b, q) => s.timeline(q)],
  ['GET', /^\/api\/people\/([^/]+)$/, (s, m) => s.person(decodeURIComponent(m[1]))],
  ['GET', /^\/api\/people$/, (s) => s.people()],
  ['GET', /^\/api\/experts$/, (s, m, b, q) => s.experts(q)],
  ['GET', /^\/api\/projects$/, (s) => s.projects()],
  ['GET', /^\/api\/systems$/, (s) => s.systems()],
  ['GET', /^\/api\/teams$/, (s) => s.teams()],
  ['GET', /^\/api\/assumptions$/, (s) => s.assumptions()],
  ['GET', /^\/api\/events$/, (s) => s.events()],
  ['GET', /^\/api\/search$/, (s, m, b, q) => s.search(q)],
  ['GET', /^\/api\/ingest\/integrations$/, (s) => s.integrations()],
  ['POST', /^\/api\/ingest$/, (s, m, body) => s.ingest(body)],
];

export function createRouter(store = new TripwireStore()) {
  return {
    store,
    /** Returns { status, body }. Never throws for a known route. */
    handle(method, rawPath, query = {}, body = {}) {
      const path = rawPath.split('?')[0].replace(/\/+$/, '') || '/';
      const pathname = path === '' ? '/' : path;
      let pathMatched = false;
      let methodMatched = false;

      for (const [verb, pattern, handler] of ROUTES) {
        const m = pathname.match(pattern);
        if (!m) continue;
        pathMatched = true;
        if (verb !== method.toUpperCase()) continue;
        methodMatched = true;
        try {
          const result = handler(store, m, body ?? {}, query ?? {});
          if (result && typeof result === 'object' && 'status' in result && 'body' in result && Object.keys(result).length === 2 && typeof result.status === 'number') {
            return { status: result.status, body: result.body };
          }
          return { status: method.toUpperCase() === 'POST' ? 201 : 200, body: result };
        } catch (error) {
          if (error instanceof ApiError) {
            return { status: error.status, body: error.toJSON() };
          }
          return {
            status: 500,
            body: { error: { code: 'internal_error', message: error?.message || 'Unexpected engine failure', details: {} } },
          };
        }
      }

      if (pathMatched && !methodMatched) {
        return { status: 405, body: { error: { code: 'method_not_allowed', message: `${method} is not allowed on ${pathname}`, details: {} } } };
      }
      return { status: 404, body: { error: { code: 'not_found', message: `No route for ${method} ${pathname}`, details: { path: pathname } } } };
    },
  };
}

export { TripwireStore };
