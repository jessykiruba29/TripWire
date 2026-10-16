/**
 * Deterministic reference backend for the Tripwire API contract.
 *
 * Zero dependencies (node:http only). Serves the Northwind Labs fixture set and
 * implements every endpoint in docs/API_CONTRACT.md.
 *
 *   node mock-backend/server.js            # http://localhost:8787
 *   PORT=9000 node mock-backend/server.js
 *
 * This is NOT a live company system: /api/health reports mode "mock-backend" and
 * every source record is marked simulated, so the UI can never present fixtures
 * as live data.
 */

import http from 'node:http';
import { createRouter, TripwireStore } from './engine/router.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const LATENCY_MS = Number(process.env.MOCK_LATENCY_MS || 0);

const router = createRouter(new TripwireStore());

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(payload);
}

function parseQuery(url) {
  const out = {};
  for (const [k, v] of url.searchParams.entries()) out[k] = v;
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        send(res, 400, { error: { code: 'bad_request', message: 'Request body is not valid JSON', details: {} } });
        return;
      }
    }
    const { status, body: responseBody } = router.handle(req.method, url.pathname, parseQuery(url), body);
    const done = () => send(res, status, responseBody);
    if (LATENCY_MS > 0) setTimeout(done, LATENCY_MS);
    else done();
  });
});

server.listen(PORT, HOST, () => {
  const health = router.store.health();
  process.stdout.write([
    `tripwire mock backend listening on http://${HOST}:${PORT}`,
    `mode: ${health.mode} (deterministic fixtures: ${health.dataset.name})`,
    `nodes: ${health.counts.nodes}  edges: ${health.counts.edges}  sources: ${health.counts.sources}`,
    `sources: ${JSON.stringify(health.source_counts_by_type)}`,
    'reminder: simulated data, not a live company system',
    '',
  ].join('\n'));
});

export { server, router };
