# Tripwire

**Tripwire remembers what a company's decisions were based on — and tells people when the facts underneath those decisions have changed.**

Companies decide things on top of facts, assumptions, messages and documents. Facts change.
The decisions usually don't. Tripwire closes that gap with a provenance graph:

```
Decision --ASSUMES--> Assumption --SUPPORTED_BY--> Fact --STATES--> Message / Document / Ticket
```

When new information contradicts an earlier fact, Tripwire finds the existing fact it conflicts with,
traces every decision that rested on it, preserves both versions of the truth with bi-temporal
history, identifies the people who actually understand the affected systems, and raises an
**explainable** alert — with real evidence paths, never a plausible-looking guess.

### The restraint principle

Tripwire helps people *review* decisions. It never silently declares a decision invalid.

In the Northwind Labs demo, a hosting partner's EU compliance certification is revoked. The EU launch
decision that assumed EU data residency is flagged **`POTENTIALLY_STALE`**, not stale — because an
independent SOC 2 attestation still supports the same assumption. The alert says so, cites the
surviving evidence, and lowers its own confidence. Only an explicit human review promotes a decision
to `STALE`.

---

## Quickstart

### Option A — fully offline (no Docker, no API keys)

The demo runs completely offline with a deterministic JSON-backed graph and rule-based extraction.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

$env:TRIPWIRE_STORE = "json"          # offline, persistent graph at data/graph.json
.\.venv\Scripts\python.exe -m tripwire seed
.\.venv\Scripts\python.exe -m uvicorn tripwire.api.app:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000/docs> for the interactive API, or run the headline scenario from the CLI:

```powershell
.\.venv\Scripts\python.exe -m tripwire state
.\.venv\Scripts\python.exe -m tripwire trigger-event frankfurt_compliance_revoked
```

### Option B — FalkorDB (the target architecture)

```powershell
docker compose up -d falkordb
.\.venv\Scripts\python.exe -m tripwire seed          # TRIPWIRE_STORE defaults to falkordb
.\.venv\Scripts\python.exe -m uvicorn tripwire.api.app:app --port 8000
```

If FalkorDB is unreachable and `TRIPWIRE_STORE_FALLBACK` is true (the default), Tripwire logs a
warning and falls back to the JSON store so the demo still works. `/api/health` always reports which
backend is actually serving.

### Frontend

```powershell
cd frontend
npm ci
$env:VITE_API_MODE = "live"
$env:VITE_API_BASE_URL = "http://localhost:8000"
npm run dev            # http://localhost:5173
```

`VITE_API_MODE` accepts `live`, `mock`, and `auto` (default). `auto` probes the backend and falls back
to the bundled deterministic reference engine in `mock-backend/`, showing the active mode in the UI.
Explicit `live` reports backend failures instead of masking them with mock data.

---

## What is actually implemented

| Area | Status |
|---|---|
| Graph schema — 11 node types, 19 relationship types, documented property conventions | Implemented |
| Stores — FalkorDB adapter, JSON-backed store, in-memory store behind one primitive interface | Implemented |
| Knowledge ingestion — Slack / ticket / PRD / meeting-note adapters, provenance, entity resolution, dedup, review status, ingestion events | Implemented |
| Contradiction detection — 6-way classification with typed evidence, confidence and explicit rules | Implemented |
| Staleness propagation — cycle-safe, deduplicated, bounded-depth, with real evidence paths | Implemented |
| Bi-temporal history — `valid_from`/`valid_to` (world) vs `recorded_at`/`recorded_to` (belief) | Implemented |
| Explanations — `explain_path`, decision/fact/alert explanations, never fabricates a path | Implemented |
| Contribution-based expert finder + shadow org chart | Implemented |
| Proactive alert engine — dedup, 5 statuses, history, reviewer routing | Implemented |
| MCP server — stdio + streamable HTTP, tools call the same engine | Implemented |
| HTTP API — FastAPI, validated models, consistent error envelope | Implemented |
| Northwind Labs dataset — 12 people, 4 teams, 8 systems, 6 projects, 40 Slack messages, 15 tickets, 3 PRDs, 2 meeting notes, deterministic | Implemented |
| LLM extraction + semantic comparison | Implemented, **not verified against a live provider** (no credentials in this environment) |
| FalkorDB against a live server | Adapter implemented, **not verified live** (no Docker in this environment) |

Honest gaps are also tracked in the follow-up sections below. Nothing in this table is claimed to
work merely because it is described in a specification.

---

## HTTP API at a glance

Full contract: [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) (including the `label` vs `name`,
`recorded_to` vs `valid_to`, path `edge_direction` and alert `allowed_transitions` semantics).

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness, active/configured backend, seeded flag |
| `GET /api/graph` · `GET /api/paths` · `GET /api/search` | Graph payload, validated relationship paths, substring search |
| `GET /api/entities` | Every entity kind with snapshot-wide counts |
| `GET /api/decisions` · `/api/people` · `/api/projects` · `/api/systems` · `/api/teams` · `/api/assumptions` · `/api/events` | Dedicated entity lists — `?status=`, `?q=`, `?limit=`, `?offset=` plus documented kind filters; unknown filters are 422 |
| `GET /api/{kind}/{entity_id}` | One entity (same view as the list); unknown id → 404 envelope |
| `GET /api/decisions/{id}/explanation` · `/dependencies?at=` · `POST .../status` | Decision reasoning and audited status changes |
| `GET /api/alerts` · `GET /api/alerts/{id}` · `/history` · `POST .../review` | Alert feed/detail with `allowed_transitions`, append-only history, note-preserving reviews |
| `GET /api/history/belief` · `/valid` · `/changes` | Bitemporal queries (belief time vs world time) |
| `POST /api/demo/seed` · `/reset` · `/trigger-event` · `GET /api/demo/state` | Idempotent demo lifecycle and the Frankfurt scenario |
| `GET /api/experts` · `POST /api/contradictions/find` · `POST /api/staleness/propagate` | Contribution-based experts, contradiction checks, propagation plans |

```bash
curl 'http://127.0.0.1:8000/api/decisions?status=ACTIVE&limit=2'
# → {"kind": "decisions", "total": 7, "count": 2, "counts": {...}, "items": [...], ...}
```

---

## Repository layout

```
graphhacks/
  README.md  pyproject.toml  requirements.txt  requirements-dev.txt
  Dockerfile  docker-compose.yml  .env.example
  tripwire/                 # the backend application package
    core/                   # schema, stores, and ALL graph reasoning
    ingest/                 # adapters, extractors, ingestion pipeline
    dataset/                # the deterministic Northwind Labs graph
    api/                    # FastAPI app + routers
    mcp_server/             # MCP tools
    cli.py  config.py       # `python -m tripwire ...`
  frontend/                 # React 18 + Vite + TypeScript UI
  mock-backend/             # deterministic reference engine for offline/mock mode
  tests/                    # pytest suite (engine, API, MCP, end-to-end)
  docs/                     # API contract, schema, architecture, dataset, MCP
  scripts/                  # smoke test, OpenAPI dump, local run helpers
  data/                     # gitignored runtime state
```

`tripwire/` *is* the server package, so the project root is also the Python project root: `pytest`,
`uvicorn`, and `docker build .` all work from the root with no extra `cd` or install step.

---

## Configuration

Secrets live only in the environment — never in source. Copy `.env.example` to `.env` (git-ignored).

| Variable | Default | Purpose |
|---|---|---|
| `TRIPWIRE_STORE` | `falkordb` | `falkordb`, `json`, or `memory` |
| `TRIPWIRE_STORE_FALLBACK` | `true` | Fall back to the JSON store when FalkorDB is unreachable |
| `TRIPWIRE_STATE_PATH` | `data/graph.json` | JSON store location |
| `FALKOR_HOST` / `FALKOR_PORT` | `localhost` / `6379` | FalkorDB connection |
| `FALKOR_GRAPH` | `tripwire` | Graph (namespace) name |
| `TRIPWIRE_CORS_ORIGINS` | local dev origins | Comma-separated allowed origins — set this for any real deployment |
| `LLM_PROVIDER` | *(unset)* | Unset means deterministic extraction only |
| `LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL` | *(unset)* | OpenAI-compatible endpoint |
| `TRIPWIRE_SEED_ON_STARTUP` | `false` | Seed the dataset when the API boots |

`LLM_PROVIDER` unset is a fully supported mode, not a degraded one: extraction falls back to the
deterministic rules, and every extracted claim is marked `verified: false` with
`review_status: NEEDS_REVIEW`.

---

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

The suite covers graph creation and retrieval, seed idempotency and reset, ingestion and provenance,
entity resolution, contradiction detection **and its negative cases**, staleness propagation and path
correctness, cycles and repeated events, bi-temporal history, expert ranking, alert dedup and status
transitions, MCP tool execution, API validation, and the complete Frankfurt scenario.

Two properties are asserted explicitly because they are the product's whole point:

- an **unrelated** decision stays `ACTIVE` (no false alerts), and
- an **alternate valid supporting fact** changes the review outcome from `confirmed` to `potential`.

FalkorDB integration tests skip cleanly when no server is reachable; a mock is always labelled a mock.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | Endpoints, request/response shapes, error envelope, field semantics |
| [docs/GRAPH_SCHEMA.md](docs/GRAPH_SCHEMA.md) | Node types, relationship types, property conventions, status models |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering, the store abstraction, single-writer engine, extension points |
| [docs/DATASET.md](docs/DATASET.md) | The Northwind Labs storyline, entities, and why each dependency exists |
| [docs/MCP.md](docs/MCP.md) | Connecting an MCP client and invoking each tool |

---

## Known gaps

1. **FalkorDB has never been exercised against a live server from this environment** (no Docker here).
   The adapter, its Cypher generation and its graceful-degradation path are all implemented; the
   live round-trip is not verified.
2. **The LLM path has never run against a real provider** (no credentials). Request construction,
   strict response validation and the deterministic fallback are implemented and unit-tested.
3. **MCP tools are verified in-process**, through a real protocol client, rather than via an external
   MCP application.
4. **The frontend's `mock-backend/` is intentionally retained**: the Vite and TypeScript aliases
   reference it, and it powers offline demos and tests. It is a reference engine, not a live backend.
