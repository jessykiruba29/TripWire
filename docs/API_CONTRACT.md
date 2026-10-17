# Tripwire HTTP API Contract

Version: **1.0.0** · OpenAPI: [`docs/openapi.json`](openapi.json) (`GET /openapi.json`, docs at `/docs`)

Every route in this document is a **thin adapter over `tripwire.core.engine.GraphEngine`**.
No route re-implements graph reasoning: contradiction detection, staleness
propagation, bitemporal history, explanation, expert ranking and alerts all live
in the engine, and the HTTP layer only validates input, delegates and shapes the
response. The engine's methods are synchronous; routes are declared `def`, so
FastAPI runs them in its worker threadpool.

* Base URL (default): `http://127.0.0.1:8000`
* Request/response format: `application/json`
* All timestamps are ISO-8601 UTC strings (`YYYY-MM-DDTHH:MM:SSZ`).
* The demo works fully offline with `TRIPWIRE_STORE=memory` (no Docker, no
  credentials). `GET /api/health` and `GET /api/demo/state` always report the
  **active** backend, so a fallback cannot masquerade as FalkorDB.

---

## 1. Error envelope

Every failing request returns the same body:

```json
{
  "error": "<stable machine-readable code>",
  "message": "<human-readable explanation, never a stack trace>",
  "details": { "<structured, non-secret context>": "..." }
}
```

`details` is always present (an empty object when there is nothing to add).
`TripwireError` subclasses (`tripwire/core/errors.py`) carry their own `code`
and `http_status`, which are mapped straight onto the response.

| HTTP | `error` code | Raised for |
|---|---|---|
| 422 | `validation_error` | Request-body/query validation (FastAPI `RequestValidationError`) **and** engine `ValidationError` (e.g. unknown scenario, unknown decision status, unconfirmed `STALE`, missing `fact_id`/`candidate`). |
| 422 | `schema_error` | A node/edge violated the graph schema (`SchemaError`). |
| 404 | `not_found` | `NotFoundError` – a referenced entity (decision, fact, alert, source) does not exist. |
| 409 | `invalid_transition` | `TransitionError` – an alert status transition that is not permitted. |
| 501 | `not_implemented` | `FeatureNotAvailable` – ingestion endpoints in this build (see §7). |
| 400 | `bad_request` | `bad_request` HTTP error. |
| 401 / 403 / 405 / 409 / 415 / 503 | `unauthorized` / `forbidden` / `method_not_allowed` / `conflict` / `unsupported_media_type` / `service_unavailable` | Generic routing/HTTP errors, wrapped in the same envelope. |
| 500 | `store_error`, `configuration_error`, `engine_error`, `internal_error` | Internal failures. The catch-all logs the traceback server-side and returns a generic message — **no stack trace is ever returned to a client**. |
| 502 / 503 | `llm_response_invalid` / `llm_unavailable` | Optional LLM path problems (the deterministic rule engine is always the fallback). |

Real examples (copied from running responses):

```json
# GET /api/decisions/decision:nope/explanation  -> 404
{"error": "not_found", "message": "decision 'decision:nope' does not exist", "details": {"decision_id": "decision:nope"}}
```

```json
# POST /api/alerts/alert:21909486f31e/review  {"status": "NEW"}  (alert was DISMISSED) -> 409
{"error": "invalid_transition", "message": "cannot move alert alert:21909486f31e from DISMISSED to NEW",
 "details": {"from": "DISMISSED", "to": "NEW", "allowed": ["NEEDS_REVIEW", "RESOLVED"]}}
```

```json
# GET /api/experts   (missing required q)  -> 422
{"error": "validation_error", "message": "Request validation failed.",
 "details": {"errors": [{"type": "missing", "loc": ["query", "q"], "msg": "Field required", "input": null}]}}
```

```json
# POST /api/decisions/decision:apac-datacentre/status  {"status": "STALE"}  (no confirm) -> 422
{"error": "validation_error",
 "message": "marking a decision STALE requires explicit confirmation (confirm=true); Tripwire never invalidates a decision automatically",
 "details": {}}
```

---

## 2. Pagination

List endpoints take `limit` and `offset` and **echo them**, alongside `total`
(matching items before the window) and `count` (items in the window):

| Endpoint | Defaults | Fields |
|---|---|---|
| `GET /api/alerts` | `limit=50`, `offset=0` | `total`, `count`, `limit`, `offset`, `status_counts` |
| `GET /api/sources` | `limit=50`, `offset=0` | `total`, `count`, `limit`, `offset` |
| `GET /api/search` | `limit=25` | `total`, `results` |
| `GET /api/history/belief` | `limit=200` | `total`, `facts` |

`GET /api/graph` is not offset-paginated; it uses `node_limit` / `edge_limit`
and reports `meta.truncated` plus `meta.total_nodes` / `meta.total_edges`.

---

## 3. Node and edge view shapes

`GET /api/graph`, `GET /api/search`, `GET /api/sources` and history endpoints
return **flattened views** (`Node.to_view()` / `Edge.to_view()`):

**Node view** — identity plus every property inlined; `type` duplicates `label`
for renderers that key on `type`:

```json
{
  "id": "decision:apac-datacentre",
  "label": "Decision",
  "type": "Decision",
  "name": "Move APAC workloads to the Singapore region",
  "statement": "Relocate APAC production workloads to the Singapore region.",
  "status": "ACTIVE",
  "review_status": "UNREVIEWED",
  "made_at": "2026-02-02T08:30:00Z",
  "created_at": "2026-02-02T08:30:00Z",
  "recorded_at": "2026-02-02T08:30:00Z",
  "decision_key": "apac-datacentre"
}
```

**Edge view** — an `id` of `"{src}|{rel}|{dst}"`, `source`/`target`, the
relationship under both `rel` and `type`, plus inlined edge properties:

```json
{
  "id": "decision:pricing-eu|DEPENDS_ON|decision:eu-launch",
  "source": "decision:pricing-eu",
  "target": "decision:eu-launch",
  "rel": "DEPENDS_ON",
  "type": "DEPENDS_ON",
  "at": "2026-02-02T08:30:00Z",
  "recorded_at": "2026-02-02T08:30:00Z",
  "reason": "Recorded as a dependency in the launch planning documents."
}
```

---

## 4. Graph vocabulary (`tripwire/core/schema.py`)

These are the **only** accepted values; anything else is a 422.

**Node types (`NODE_TYPES`)** — `Person, Team, System, Project, Decision,
Assumption, Fact, Message, Document, Event, Alert`.

**Relationship types (`REL_TYPES`)** — spec relationships `ON_TEAM, MADE,
ASSUMES, SUPPORTED_BY, DEPENDS_ON, IMPACTS, USES, STATES, CONTRADICTS,
AUTHORED, ABOUT, TRIGGERED_BY, STALED` plus documented additions `MENTIONS,
RESOLVED, OWNS, REVIEWS, AFFECTS, EVIDENCE_FOR`.

**Fact statuses (`FACT_STATUSES`)** — `ACTIVE, CONTESTED, INVALIDATED, UNCERTAIN`.

**Decision statuses (`DECISION_STATUSES`)** — `ACTIVE, POTENTIALLY_STALE, STALE,
SUPERSEDED, ARCHIVED`. Propagation only ever writes `POTENTIALLY_STALE`;
`STALE` requires an explicit, confirmed review.

**Alert statuses (`ALERT_STATUSES`)** — `NEW, NEEDS_REVIEW, CONFIRMED_STALE,
DISMISSED, RESOLVED`.

**Review statuses (`REVIEW_STATUSES`)** — `UNREVIEWED, NEEDS_REVIEW,
REVIEWED_ACCEPTED, REVIEWED_REJECTED, AUTO_ACCEPTED`.

**Document types (`DOC_TYPES`)** — `ticket, prd, meeting_note, design_doc`.

**Event types (`EVENT_TYPES`)** — `SEED, RESET, INGESTION, FACT_ASSERTED,
FACT_RESTATED, FACT_CHANGE, CONTRADICTION_DETECTED, STALENESS_PROPAGATED,
STATUS_CHANGE, ALERT_STATUS_CHANGE, REVIEW_DECISION, ERROR`.

---

## 5. Alert status transition table

Enforced by `tripwire/core/alerts.py::transition_alert` against
`ALERT_STATUS_TRANSITIONS`. Legend: **✔** allowed, **—** not allowed (409),
**=** same-status request (allowed, idempotent no-op returning 200 with no new
history entry). A target outside `ALERT_STATUSES` is a 422.

| from \ to | NEW | NEEDS_REVIEW | CONFIRMED_STALE | DISMISSED | RESOLVED |
|---|:--:|:--:|:--:|:--:|:--:|
| **NEW**            | = | ✔ | ✔ | ✔ | ✔ |
| **NEEDS_REVIEW**   | — | = | ✔ | ✔ | ✔ |
| **CONFIRMED_STALE**| — | ✔ | = | ✔ | ✔ |
| **DISMISSED**      | — | ✔ | — | = | ✔ |
| **RESOLVED**       | — | ✔ | — | — | = |

Side effects: `CONFIRMED_STALE` promotes the affected decision to `STALE`;
`DISMISSED` returns a flagged decision to `ACTIVE`. Both are recorded as
append-only `ALERT_STATUS_CHANGE` / `STATUS_CHANGE` events.

**Decision status** (`POST /api/decisions/{id}/status`): any of the five statuses
is accepted, but `STALE` requires `confirm: true` (else 422), an unknown status
is 422, and an unknown decision id is 404.

---

## 6. Demo dataset reference

After seeding (`POST /api/demo/seed`) the Northwind Labs dataset has **115 nodes
/ 345 edges**; expected node counts are `Message 40, Document 20, Person 12,
Team 4, System 8, Project 6, Decision 7, Assumption 4, Fact 13` (plus 1 `Event`).
The headline scenario `frankfurt_compliance_revoked` revokes the Frankfurt
partner's EU certification, flags `decision:eu-launch` `POTENTIALLY_STALE`
(certainty `potential`), reports `decision:legal-signoff-eu` as `confirmed`, and
leaves `decision:apac-datacentre`, `decision:dark-mode-default` and
`decision:warehouse-regional-split` `ACTIVE`.

---

## 7. Endpoints

### `GET /api/health`
Composite health. Never raises: a degraded store is reported as `status: degraded`.
Params: none.

```bash
curl -s http://127.0.0.1:8000/api/health
```
```json
{
  "status": "ok",
  "store": {"backend": "memory", "ok": true, "nodes": 0, "edges": 0},
  "configured_backend": "memory",
  "active_backend": "memory",
  "seeded": false,
  "llm_enabled": false,
  "checked_at": "2026-10-15T16:53:20Z"
}
```

### `GET /api/demo/state`
Full demo status: dataset manifest vs. actual counts, alert histogram, history
summary, key entity ids and the secret-free configuration summary.
Params: none.

```json
{
  "seeded": true,
  "dataset": {"name": "northwind-labs", "version": "1.0.0",
    "matches_expected": {"Message": true, "Document": true, "Person": true, "Team": true,
      "System": true, "Project": true, "Decision": true, "Assumption": true, "Fact": true}},
  "counts": {"nodes": 115, "edges": 345,
    "by_label": {"Assumption": 4, "Decision": 7, "Document": 20, "Event": 1, "Fact": 13,
      "Message": 40, "Person": 12, "Project": 6, "System": 8, "Team": 4}},
  "alerts": {"total": 0, "status_counts": {}}
}
```
*(The real body also contains `store`, `llm`, `key_entities`, `history` and `config`.)*

### `POST /api/demo/trigger-event`
Runs the full contradiction → propagation → alert flow. Supply **either**
`scenario` (deterministic, offline) **or** an explicit `new_fact` (+ optional
`source`). `apply` is always true here. Idempotent: replaying an event creates no
duplicates and no status regressions. An unknown scenario is a 422.

Body (`TriggerEventRequest`, all optional but one of *scenario* / *new_fact* required):

| field | type | notes |
|---|---|---|
| `scenario` | string | a name from `GET /api/dataset/scenarios` |
| `new_fact` / `fact` | object | `{subject, attribute, value, statement?, subject_label?, valid_from?, valid_to?, recorded_at?, confidence? (0–1), verified?, status?, extra?}` |
| `source` | object | `{kind?, external_id?, name?, author?, timestamp?, source_ref?, text?, url?, channel?, doc_type?, confidence?}` |
| `actor_id` | string | who triggered the event |
| `recorded_at` | string | transaction time override |
| `use_llm` | boolean | default true (falls back to deterministic rules when no LLM is configured) |

```bash
curl -s -X POST http://127.0.0.1:8000/api/demo/trigger-event \
  -H 'Content-Type: application/json' \
  -d '{"scenario": "frankfurt_compliance_revoked"}'
```
Response (real; `impacts` shown in full):

```json
{
  "event": {"triggered_at": "2026-02-20T08:15:00Z", "scenario": "frankfurt_compliance_revoked",
    "actor_id": "person:aisha-khan", "applied": true, "llm_enabled": false},
  "assertion": {"fact_id": "fact:5f3054083121", "created": true},
  "contradiction": {
    "detected": true,
    "summary": {"contradiction": 1, "unverified": 0, "ambiguous": 0, "temporal": 0, "additive": 5, "unrelated": 0},
    "primary": {"kind": "contradiction", "existing_fact_id": "fact:frankfurt-partner-compliance-valid",
      "new_fact_id": "fact:5f3054083121", "attribute": "compliance_status",
      "existing_value": "valid", "new_value": "revoked", "severity": "high", "confidence": 0.936,
      "review_status": "NEEDS_REVIEW", "explicit_rule": "compliance_revocation",
      "llm_assisted": false, "temporal_overlap": true, "contradicts": true, "already_recorded": false}
  },
  "alert_ids": ["alert:21909486f31e", "alert:69b70030d292", "alert:7a1727f39304", "alert:aac1124ace58",
    "alert:bd0231654219", "alert:befe6bd9fe49", "alert:db376ccd3d33", "alert:eb11411e6a64"],
  "impacts": [
    {"entity_id": "decision:eu-launch", "entity_label": "Decision", "status_before": "ACTIVE", "status_after": "POTENTIALLY_STALE", "certainty": "potential", "has_alternate_evidence": true, "depth": 0},
    {"entity_id": "decision:legal-signoff-eu", "entity_label": "Decision", "status_before": "ACTIVE", "status_after": "POTENTIALLY_STALE", "certainty": "confirmed", "has_alternate_evidence": false, "depth": 0},
    {"entity_id": "decision:hiring-eu-support", "entity_label": "Decision", "status_before": "ACTIVE", "status_after": "POTENTIALLY_STALE", "certainty": "potential", "has_alternate_evidence": true, "depth": 1},
    {"entity_id": "decision:pricing-eu", "entity_label": "Decision", "status_before": "ACTIVE", "status_after": "POTENTIALLY_STALE", "certainty": "potential", "has_alternate_evidence": true, "depth": 1},
    {"entity_id": "project:data-governance-overhaul", "entity_label": "Project", "status_before": "ACTIVE", "status_after": "POTENTIALLY_STALE", "certainty": "confirmed", "has_alternate_evidence": false, "depth": 1},
    {"entity_id": "project:eu-launch", "entity_label": "Project", "status_before": "ACTIVE", "status_after": "POTENTIALLY_STALE", "certainty": "potential", "has_alternate_evidence": true, "depth": 1},
    {"entity_id": "project:pricing-v2", "entity_label": "Project", "status_before": "ACTIVE", "status_after": "POTENTIALLY_STALE", "certainty": "potential", "has_alternate_evidence": true, "depth": 2},
    {"entity_id": "project:q3-hiring-plan", "entity_label": "Project", "status_before": "ACTIVE", "status_after": "POTENTIALLY_STALE", "certainty": "potential", "has_alternate_evidence": true, "depth": 2}
  ]
}
```
*(The real body also carries `contradiction_edges` and `propagation`.)*

Explicit fact (real request):

```bash
curl -s -X POST http://127.0.0.1:8000/api/demo/trigger-event \
  -H 'Content-Type: application/json' \
  -d '{"new_fact": {"subject": "Frankfurt Hosting Partner", "subject_label": "System",
        "attribute": "compliance_status", "value": "revoked",
        "statement": "Partner certification revoked (explicit fact)."},
       "source": {"kind": "slack", "external_id": "api-test-evt-1", "name": "Explicit revocation",
        "author": "Aisha Khan", "timestamp": "2026-02-20T09:00:00Z"},
       "use_llm": false}'
```

### `POST /api/demo/seed`
Seeds the deterministic dataset. Idempotent: re-seeding writes nothing unless
`force` is true. Body (`SeedRequest`, optional): `{force: boolean = false}`.

```json
{"seeded": true, "forced": false, "nodes_before": 0, "nodes_after": 114, "edges_after": 345}
```
*(The real body also carries `edges_before`, `nodes_written`, `edges_written`,
`manifest`, `actual_counts` and `state`.)*

### `POST /api/demo/reset`
Clears the graph and re-seeds (always a forced re-seed). Body optional/ignored.

### `GET /api/dataset/scenarios`
The scenario catalog accepted by `POST /api/demo/trigger-event`.

```json
{
  "total": 6,
  "scenarios": [
    {"name": "additive_edge_cache_provider", "description": "New information about a known subject that conflicts with nothing. Tripwire must classify it as additive and raise no alert - the restraint case."},
    {"name": "ambiguous_edge_cache_region", "description": "A claim about an attribute that existing records already disagree on. Tripwire must report the ambiguity and refuse to auto-resolve it, raising no alert."}
  ]
}
```

### `GET /api/graph`
Nodes/edges as flattened views, with an optional neighbourhood focus.
Query params:

| param | type | default | notes |
|---|---|---|---|
| `label` | string (repeatable) | – | keep only these node types; unknown type → 422 |
| `node_limit` | int ≥ 0 | – | truncate nodes |
| `edge_limit` | int ≥ 0 | – | truncate edges |
| `around` | string | – | focus node id |
| `depth` | int 0–6 | `1` | neighbourhood depth around `around` |
| `include_alerts` | boolean | `true` | when focusing, keep/drop `Alert` nodes |

```bash
curl -s 'http://127.0.0.1:8000/api/graph?label=Decision&node_limit=1'
```
```json
{
  "nodes": [{"id": "decision:apac-datacentre", "label": "Decision", "type": "Decision",
    "name": "Move APAC workloads to the Singapore region",
    "statement": "Relocate APAC production workloads to the Singapore region.",
    "status": "ACTIVE", "review_status": "UNREVIEWED", "made_at": "2026-02-02T08:30:00Z",
    "created_at": "2026-02-02T08:30:00Z", "recorded_at": "2026-02-02T08:30:00Z",
    "decision_key": "apac-datacentre"}],
  "edges": [{"id": "decision:hiring-eu-support|DEPENDS_ON|decision:eu-launch",
    "source": "decision:hiring-eu-support", "target": "decision:eu-launch",
    "rel": "DEPENDS_ON", "type": "DEPENDS_ON", "at": "2026-02-02T08:30:00Z",
    "recorded_at": "2026-02-02T08:30:00Z",
    "reason": "Recorded as a dependency in the launch planning documents."}],
  "meta": {"node_count": 1, "edge_count": 3, "total_nodes": 7, "total_edges": 3,
    "truncated": true, "focus": null, "depth": null}
}
```

### `GET /api/paths`
Bounded, cycle-safe simple relationship paths between two entities.
Query params: `source` (required), `target` (required), `max_depth` (int 1–10,
default 6), `rel` (string, repeatable).

```bash
curl -s 'http://127.0.0.1:8000/api/paths?source=fact:frankfurt-partner-compliance-valid&target=decision:eu-launch'
```
```json
{
  "found": true,
  "path_count": 4,
  "paths": [{
    "nodes": ["fact:frankfurt-partner-compliance-valid", "decision:eu-launch"],
    "rels": ["STALED"],
    "narrative": "Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12. -> -[STALED]-> Launch Northwind in the EU on the Frankfurt hosting partner"
  }]
}
```
When nothing connects the entities the response is `200` with `found: false` and a
reason — a path is never fabricated. *(The real body also carries `source`,
`target`, `reason` and `generated_at`.)*

### `GET /api/search`
Case-insensitive substring search across node names/ids and `statement`/`text`/`role`.
Query params: `q` (required, non-empty), `limit` (int 1–200, default 25).

```bash
curl -s 'http://127.0.0.1:8000/api/search?q=Frankfurt&limit=3'
```
```json
{
  "query": "Frankfurt",
  "total": 61,
  "results": [
    {"id": "alert:21909486f31e", "label": "Alert", "name": "Pricing v2: potential impact from a change to 'Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.'"},
    {"id": "alert:69b70030d292", "label": "Alert", "name": "Q3 Hiring Plan: potential impact from a change to 'Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.'"},
    {"id": "alert:7a1727f39304", "label": "Alert", "name": "Data Governance Overhaul: confirmed impact from a change to 'Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.'"}
  ]
}
```

### `GET /api/sources`
Paginated `Message`/`Document` artifacts. Query params: `type` (optional – matches
node label, `source_system` or `doc_type`, case-insensitive), `limit` (1–500,
default 50), `offset` (≥ 0, default 0).

```bash
curl -s 'http://127.0.0.1:8000/api/sources?limit=2&offset=0'
```
```json
{
  "total": 61, "count": 2, "limit": 2, "offset": 0,
  "sources": [
    {"id": "document:meeting-note:nwl-mn-001", "label": "Document", "type": "Document",
     "name": "Meeting notes: EU Launch Go/No-Go", "source_system": "meeting_note", "doc_type": "meeting_note"},
    {"id": "document:meeting-note:nwl-mn-002", "label": "Document", "type": "Document",
     "name": "Meeting notes: Frankfurt Partner Quarterly Review", "source_system": "meeting_note", "doc_type": "meeting_note"}
  ]
}
```

### `GET /api/sources/{source_id}`
One artifact plus the facts it `STATES`. Unknown/non-source id → 404.

```json
{"source": {"id": "document:meeting-note:nwl-mn-001", "label": "Document",
  "name": "Meeting notes: EU Launch Go/No-Go", "source_system": "meeting_note"},
 "states_count": 1, "states": [ /* flattened Fact views */ ]}
```

### `GET /api/decisions/{decision_id}/explanation`
Assumptions, supporting facts, evidence paths, alerts, surviving alternate
evidence and people. Unknown id → 404.

```json
{
  "found": true,
  "decision": {"id": "decision:eu-launch", "label": "Decision",
    "name": "Launch Northwind in the EU on the Frankfurt hosting partner", "status": "POTENTIALLY_STALE"},
  "status": "POTENTIALLY_STALE",
  "why_flagged": "'Launch Northwind in the EU on the Frankfurt hosting partner' assumes 'EU data residency is contractually enforceable in Frankfurt', which is supported by 'Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.' (changed). Review the decision's continued validity. Independent evidence still supports the assumption ('fact:frankfurt-partner-soc2-attestation-valid'), so this is flagged as potentially affected and requires human review before any status change.",
  "assumption_count": 1,
  "alternate_evidence": [{"assumption_id": "assumption:data-residency-eu",
    "fact_id": "fact:frankfurt-partner-soc2-attestation-valid",
    "fact_name": "Frankfurt Hosting Partner's independent SOC 2 Type II attestation is valid to 2027-03-31.",
    "value": "soc2_type_ii_valid", "status": "ACTIVE", "source_count": 3}],
  "alerts": [{"alert_id": "alert:befe6bd9fe49", "status": "NEEDS_REVIEW", "certainty": "potential"}]
}
```
*(The real body also carries `previous_status`, `stale_reason`, `stale_since`,
`review_status`, `confidence`, `dependencies`, `evidence_paths`, `people`,
`missing` and `generated_at`.)*

### `POST /api/decisions/{decision_id}/status`
Audited status change. Body: `{status, actor_id?, note?, confirm?}`.
Unknown status → 422; `STALE` without `confirm: true` → 422; unknown id → 404.

```json
# POST /api/decisions/decision:legal-signoff-eu/status
# {"status": "STALE", "confirm": true, "actor_id": "person:reviewer", "note": "no surviving support"}
{
  "decision_id": "decision:legal-signoff-eu",
  "status": "STALE",
  "previous_status": "POTENTIALLY_STALE",
  "reviewed_by": "person:reviewer",
  "at": "2026-10-15T16:53:21Z"
}
```

### `GET /api/decisions/{decision_id}/dependencies`
What a decision rested on at a transaction time. Query params: `at` (required).
Unknown id → 404.

```bash
curl -s 'http://127.0.0.1:8000/api/decisions/decision:eu-launch/dependencies?at=2026-03-01T00:00:00Z'
```
```json
{
  "decision_id": "decision:eu-launch",
  "found": true,
  "status_at_query": "POTENTIALLY_STALE",
  "assumption_count": 1,
  "assumptions": [{"assumption_id": "assumption:data-residency-eu",
    "name": "EU data residency is contractually enforceable in Frankfurt"}]
}
```

### `GET /api/facts/{fact_id}/explanation`
What a fact contradicts, its provenance and affected entities. Unknown id → 404.

```json
{
  "found": true,
  "fact": {"id": "fact:frankfurt-partner-compliance-valid", "label": "Fact",
    "name": "Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.",
    "status": "INVALIDATED"},
  "contradiction_count": 1,
  "contradictions": [{"other_fact_id": "fact:frankfurt-partner-compliance-valid",
    "kind": "contradiction", "status": "VERIFIED", "confidence": 0.936}]
}
```
*(The real body also carries `provenance`, `supporting_assumptions`,
`affected_entities`, `missing` and `generated_at`.)*

### `GET /api/experts`
Ranks people by *demonstrated contribution* (not the org chart). Query params:
`q` (required – system/project name or id), `limit` (1–50, default 5).

```bash
curl -s 'http://127.0.0.1:8000/api/experts?q=EU%20Launch&limit=2'
```
```json
{
  "query": "EU Launch",
  "target_name": "EU Launch",
  "experts": [
    {"rank": 1, "person_id": "person:jonas-berg", "person_name": "Jonas Berg",
     "role": "Senior Platform Engineer", "normalized_score": 1, "is_official_owner": false, "shadow_signal": true},
    {"rank": 2, "person_id": "person:priya-raman", "person_name": "Priya Raman",
     "role": "VP Engineering", "normalized_score": 0.402, "is_official_owner": true, "shadow_signal": false}
  ],
  "hidden_experts": ["Jonas Berg"]
}
```
*(The real body also carries `target_id`, `target_label`, `method`, `notes`,
`related_targets` and `official_owners`; each expert carries
`contribution_counts`, `evidence_refs` and `contributions`.)*

### `POST /api/experts/query`
Identical behaviour to `GET /api/experts`, for clients that prefer a body.
Body: `{query: string (min 1), limit: int 1–50 = 5}`.

### `POST /api/contradictions/find`
Classifies a claim against existing knowledge. Provide **exactly one** of
`fact_id` (an existing fact) or `candidate` (`{subject, attribute, value,
statement?, valid_from?, valid_to?, recorded_at?, confidence?, verified?}`).
Neither → 422. This endpoint **never writes**.

```bash
curl -s -X POST http://127.0.0.1:8000/api/contradictions/find \
  -H 'Content-Type: application/json' \
  -d '{"candidate": {"subject": "Frankfurt Hosting Partner", "attribute": "compliance_status", "value": "revoked"}, "use_llm": false}'
```
```json
{
  "contradiction_found": true,
  "summary": {"contradiction": 1, "unverified": 0, "ambiguous": 0, "temporal": 0, "additive": 6, "unrelated": 0},
  "new_fact_id": "fact:6ed3518f030a",
  "primary": {"kind": "contradiction", "existing_fact_id": "fact:frankfurt-partner-compliance-valid",
    "new_fact_id": "fact:6ed3518f030a", "attribute": "compliance_status", "existing_value": "valid",
    "new_value": "revoked", "severity": "high", "confidence": 0.88, "review_status": "NEEDS_REVIEW",
    "explicit_rule": "compliance_revocation", "llm_assisted": false, "temporal_overlap": true,
    "contradicts": true, "already_recorded": false}
}
```
*(The real body also carries `candidates`, `considered`, `llm_used`,
`new_claim`, `notes` and `paths`.)*

### `POST /api/staleness/propagate`
Plans which decisions/projects are affected when `fact_id` changes.
Body: `{fact_id: string (min 1), max_depth?: int 0–10, dry_run: boolean = true}`.
**`dry_run` defaults to `true`**: the plan is returned and nothing is written.
With `dry_run: false` affected decisions are flagged `POTENTIALLY_STALE` (never
`STALE`) and alerts are raised. Unknown fact id → 404.

```bash
curl -s -X POST http://127.0.0.1:8000/api/staleness/propagate \
  -H 'Content-Type: application/json' \
  -d '{"fact_id": "fact:frankfurt-partner-compliance-valid", "dry_run": true}'
```
```json
{
  "source_fact_id": "fact:frankfurt-partner-compliance-valid",
  "dry_run": true,
  "applied": false,
  "counts": {"assumptions": 2, "seed_decisions": 2, "affected_total": 8,
    "affected_decisions": 4, "affected_projects": 4, "confirmed": 2, "potential": 6},
  "affected": [
    {"entity_id": "decision:eu-launch", "certainty": "potential", "status_after": "POTENTIALLY_STALE", "has_alternate_evidence": true},
    {"entity_id": "decision:legal-signoff-eu", "certainty": "confirmed", "status_after": "POTENTIALLY_STALE", "has_alternate_evidence": false},
    {"entity_id": "decision:hiring-eu-support", "certainty": "potential", "status_after": "POTENTIALLY_STALE", "has_alternate_evidence": true},
    {"entity_id": "decision:pricing-eu", "certainty": "potential", "status_after": "POTENTIALLY_STALE", "has_alternate_evidence": true},
    {"entity_id": "project:data-governance-overhaul", "certainty": "confirmed", "status_after": "POTENTIALLY_STALE", "has_alternate_evidence": false},
    {"entity_id": "project:eu-launch", "certainty": "potential", "status_after": "POTENTIALLY_STALE", "has_alternate_evidence": true},
    {"entity_id": "project:pricing-v2", "certainty": "potential", "status_after": "POTENTIALLY_STALE", "has_alternate_evidence": true},
    {"entity_id": "project:q3-hiring-plan", "certainty": "potential", "status_after": "POTENTIALLY_STALE", "has_alternate_evidence": true}
  ]
}
```
With `dry_run: false` the same plan is returned with `"dry_run": false`,
`"applied": true`, an `applied_summary`, the resulting `impacts`, and `alert_ids`.
*(The real body also carries `source_fact_name`, `source_fact_status`,
`source_fact_verified`, `evaluated_at`, `max_depth`, `assumptions`,
`seed_decisions` and `notes`.)*

### `GET /api/alerts`
Paginated alert feed. Query params: `status` (optional), `entity_id` (optional),
`severity` (optional), `limit` (1–200, default 50), `offset` (≥ 0, default 0).

```bash
curl -s 'http://127.0.0.1:8000/api/alerts?limit=2&offset=0'
```
```json
{
  "total": 8, "count": 2, "limit": 2, "offset": 0,
  "status_counts": {"NEEDS_REVIEW": 8},
  "alerts": [
    {"id": "alert:21909486f31e", "label": "Alert", "status": "NEEDS_REVIEW", "severity": "medium",
     "certainty": "potential", "entity_id": "project:pricing-v2",
     "title": "Pricing v2: potential impact from a change to 'Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.'"},
    {"id": "alert:69b70030d292", "label": "Alert", "status": "NEEDS_REVIEW", "severity": "medium",
     "certainty": "potential", "entity_id": "project:q3-hiring-plan",
     "title": "Q3 Hiring Plan: potential impact from a change to 'Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.'"}
  ]
}
```

### `GET /api/alerts/{alert_id}`
One alert plus the entities it may affect. Unknown id → 404.

```json
{
  "id": "alert:21909486f31e", "status": "NEEDS_REVIEW", "severity": "medium",
  "certainty": "potential", "entity_id": "project:pricing-v2",
  "affected": [{"entity_id": "project:pricing-v2", "certainty": "potential",
    "reason": "'Pricing v2' depends on 'Launch Northwind in the EU on the Frankfurt hosting partner', which assumes 'EU data residency is contractually enforceable in Frankfurt' supported by 'Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.' (2 hop(s) away). Independent evidence still supports the assumption ('fact:frankfurt-partner-soc2-attestation-valid'), so this is flagged as potentially affected and requires human review before any status change."}]
}
```

### `GET /api/alerts/{alert_id}/history`
Append-only status history. Unknown id → 404.

```json
{
  "alert_id": "alert:21909486f31e", "status": "NEEDS_REVIEW",
  "history": [{"event_id": "event:alert-status-change:009cd3c46c26", "event_type": "ALERT_STATUS_CHANGE",
    "at": "2026-02-20T08:15:00Z", "from_status": "NEW", "to_status": "NEEDS_REVIEW", "actor_id": null,
    "summary": "Alert alert:21909486f31e moved from NEW to NEEDS_REVIEW: Routed to reviewers after a verified contradiction.",
    "note": "Routed to reviewers after a verified contradiction."}]
}
```

### `POST /api/alerts/{alert_id}/review`
Transition an alert. Body: `{status, actor_id?, note?}`. Enforces the table in
§5: same-status → 200 no-op; invalid transition → 409; unknown status → 422;
unknown alert → 404.

```json
# POST /api/alerts/alert:21909486f31e/review
# {"status": "DISMISSED", "actor_id": "person:reviewer", "note": "confirmed not applicable"}
{
  "alert_id": "alert:21909486f31e",
  "status": "DISMISSED",
  "previous_status": "NEEDS_REVIEW",
  "updated_at": "2026-10-15T16:53:21Z",
  "reviewed_by": "person:reviewer",
  "review_note": "confirmed not applicable",
  "affected": [{"entity_id": "project:pricing-v2", "entity_status": "ACTIVE"}]
}
```

### History endpoints

| Method + path | Query params | Returns |
|---|---|---|
| `GET /api/history/belief` | `at` (required), `label` (default `Fact`), `limit` (1–1000, default 200) | what Tripwire **believed** at a transaction time |
| `GET /api/history/valid` | `at` (required), `subject_id?`, `attribute?` | facts true in the **real world** at an instant |
| `GET /api/history/changes` | `since` (required) | facts + events recorded after `since` |
| `GET /api/history/facts/{fact_id}` | – | full timeline (intervals, contradictions, events) |
| `GET /api/history/facts/{fact_id}/source-of-change` | – | the sources that changed the understanding |

The two `facts/{id}` history endpoints return `200` with `found: false` for an
unknown id (they are queries that report absence).

```json
# GET /api/history/belief?at=2026-03-01T00:00:00Z&limit=1
{"at": "2026-03-01T00:00:00Z", "label": "Fact", "total": 13,
 "facts": [{"id": "fact:5f3054083121", "label": "Fact",
   "name": "Frankfurt Hosting Partner's EU compliance certification DE-CMP-4471 has been revoked by the issuing authority, effective immediately."}]}
```

```json
# GET /api/history/valid?at=2026-02-15T00:00:00Z
{"at": "2026-02-15T00:00:00Z", "subject_id": null, "attribute": null, "total": 13, "facts": [ /* ... */ ]}
```

```json
# GET /api/history/changes?since=2026-02-19T00:00:00Z
{"since": "2026-02-19T00:00:00Z", "fact_count": 1, "event_count": 29,
 "facts": [{"fact_id": "fact:5f3054083121",
   "name": "Frankfurt Hosting Partner's EU compliance certification DE-CMP-4471 has been revoked by the issuing authority, effective immediately.",
   "status": "ACTIVE"}],
 "events": [{"event_type": "ALERT_STATUS_CHANGE", "recorded_at": "2026-02-20T08:15:00Z"}]}
```

```json
# GET /api/history/facts/fact:frankfurt-partner-compliance-valid
{
  "fact_id": "fact:frankfurt-partner-compliance-valid", "found": true, "status": "INVALIDATED",
  "valid_to": "2026-02-20T08:15:00Z", "recorded_to": "2026-02-20T08:15:00Z", "still_believed": false,
  "entries": [
    {"at": "2025-04-01T00:00:00Z", "kind": "VALID_FROM", "description": "Claim became true in the real world.", "fact_id": "fact:frankfurt-partner-compliance-valid", "event_id": null, "actor_id": null, "source_id": null},
    {"at": "2026-01-12T10:05:00Z", "kind": "RECORDED", "description": "Tripwire first recorded 'Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.' from source slack:#data-compliance/2026-01-12.", "fact_id": "fact:frankfurt-partner-compliance-valid", "event_id": null, "actor_id": null, "source_id": null},
    {"at": "2026-02-20T08:15:00Z", "kind": "CONTRADICTION_DETECTED", "description": "'Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.' changed. 'Launch Northwind in the EU on the Frankfurt hosting partner' depends directly on assumption:data-residency-eu. Independent supporting evidence exists, so this is flagged for review rather than declared stale.", "fact_id": null, "event_id": "event:contradiction-detected:1a6e649a0600", "actor_id": null, "source_id": null}
  ]
}
```
*(The real `belief`/`valid` bodies carry full flattened Fact views; the timeline
body also carries `name`, `statement`, `valid_from`, `recorded_at`.)*

---

### Ingestion — `GET /api/ingest/adapters` and `POST /api/ingest`

**These two endpoints currently return HTTP 501.** The ingestion module
(`tripwire/ingest/base.py`) and `GraphEngine.ingest_source` are being written in
parallel by another engineer and are **not present in this build**. The HTTP
layer implements no ingestion logic: it delegates to
`engine.ingest_source(payload)` when the engine provides it, and otherwise
degrades cleanly. Both routes are guarded so a missing ingestion module can never
stop the app from starting.

```json
# GET /api/ingest/adapters  -> 501
{"error": "not_implemented",
 "message": "Ingestion adapters are not available in this build: tripwire.ingest.base does not expose an adapter catalog.",
 "details": {"module": "tripwire.ingest.base"}}
```
```json
# POST /api/ingest  {"source": "slack", "kind": "message"}  -> 501
{"error": "not_implemented",
 "message": "Ingestion is not available: GraphEngine.ingest_source is not implemented in this build. No ingestion logic is implemented in the HTTP layer.",
 "details": {"adapter": "slack"}}
```

When a future build provides `tripwire.ingest.base` with an adapter catalog, the
`GET` returns `{"available": true, "adapters": [...], "message": null}` (HTTP
200). When the engine gains `ingest_source`, the `POST` forwards the body
unchanged and returns the engine's result (HTTP 200).

---

### `GET /api/entities`

Entity-kind index with snapshot-wide counts.  No parameters.

```json
# GET /api/entities
{"total": 42,
 "counts": {"decisions": 7, "people": 12, "projects": 6, "systems": 8,
            "teams": 4, "assumptions": 4, "events": 1},
 "kinds": [{"kind": "decisions", "labels": ["Decision"], "label": "Decision",
            "summary": "Decisions the company has made, with their recorded status.",
            "count": 7, "path": "/api/decisions"}, ...]}
```

### `GET /api/{kind}` - dedicated entity lists

One route per entity kind: **`/api/decisions`, `/api/people`, `/api/projects`,
`/api/systems`, `/api/teams`, `/api/assumptions`, `/api/events`** (`events`
covers both `Event` and `Alert` nodes, because an alert *is* a recorded event
about a change - clients that need alerts specifically still use
`/api/alerts`).

| param | type | default | notes |
|---|---|---|---|
| `status` | string | – | exact, case-insensitive match on the node's recorded `status` (e.g. `ACTIVE`, `POTENTIALLY_STALE`).  No match is an empty list, not an error. |
| `q` | string | – | case-insensitive substring over `name`, `id` and the text-bearing properties (`statement`, `summary`, `blurb`, `role`, `text`, `focus`). |
| `limit` | int | 50 | 1–500.  `0`, negatives and values > 500 are 422. |
| `offset` | int | 0 | ≥ 0; windows into the sorted match set. |
| *others* | string | – | kind-specific equality filters.  Documented keys: `status`, `review_status`, `criticality`, `role`, `doc_type`, `event_type` (events only), `owner_id`, `team_id`.  **An undocumented filter name is 422**, never a silently ignored filter. |

Ordering is deterministic: most-connected first (`events` are newest first),
then `label`, then `id`.  The response echoes the applied filters and reports
`counts` for **every** kind over the whole snapshot (never over the page), so
`"showing N of M"` needs no second call.

```json
# GET /api/decisions?status=ACTIVE&limit=2
{"kind": "decisions", "label": "Decision", "labels": ["Decision"],
 "total": 7, "count": 2, "limit": 2, "offset": 0,
 "filters": {"status": "ACTIVE", "q": null},
 "counts": {"decisions": 7, "people": 12, "projects": 6, "systems": 8,
            "teams": 4, "assumptions": 4, "events": 1},
 "items": [{"id": "decision:eu-launch", "label": "Decision", "type": "Decision",
            "name": "Launch Northwind in the EU on the Frankfurt hosting partner",
            "kind": "decisions", "summary": "...", "state": "active",
            "statement": "...", "status": "ACTIVE",
            "relations": {"assumes": {"meaning": "assumptions this decision rests on",
                                       "direction": "out", "relationships": ["ASSUMES"],
                                       "ids": ["assumption:data-residency-eu"],
                                       "labels": ["Assumption"], "names": ["..."],
                                       "count": 1,
                                       "edges": [{"source": "decision:eu-launch",
                                                  "target": "assumption:data-residency-eu",
                                                  "rel": "ASSUMES", ...}]}, ...},
            "related_ids": ["assumption:data-residency-eu", "project:eu-launch", ...]}, ...]}
```

Each item is a flattened `Node.to_view()` plus derived navigation fields:
`kind`, `summary` (headline text), `state` (the node's recorded status
lowercased, `recorded` for events, `unknown` when none), `relations` (the
recorded relationships of that kind, each with `direction` `out`/`in` - `out`
when the entity is the edge source, `in` when it is the target - plus real
edge views) and `related_ids`.  A relation the graph does not record is
**absent** from `relations`; an empty list never has to be guessed at.

### `GET /api/{kind}/{entity_id}`

One entity of that kind, using the *same view* as the list, wrapped in
`{found, kind, entity_id, entity}`.  An unknown id - or an id that exists under
a different label - is **404** with the standard envelope:

```json
# GET /api/decisions/decision:nope  -> 404
{"error": "not_found",
 "message": "'decision:nope' is not present in the graph as Decision.",
 "details": {"kind": "decisions", "entity_id": "decision:nope"}}
```

Unknown kind (`/api/unknown/thing`), unknown filters and invalid pagination all
use the standard 422 envelope; a graph-store outage returns 503
`store_unavailable`.  These routes are registered last, so no earlier route
(`/api/demo/state`, `/api/sources/{id}`, `/api/decisions/{id}/explanation`, ...)
is shadowed.

---

## 8. Cross-cutting implementation notes

* **App factory** — `create_app(engine=None) -> FastAPI`; the engine is stored on
  `app.state.engine` and injected by the `get_engine(request)` dependency.
  `app = create_app()` at module level makes `uvicorn tripwire.api.app:app` work.
  When no engine is given, one is built from settings (falling back to the
  in-memory store if the configured backend is unreachable).
* **CORS** — `CORSMiddleware` with `allow_origins` driven by
  `settings.cors_origins` (`TRIPWIRE_CORS_ORIGINS`). Credentials are disabled when
  a wildcard origin is configured.
* **Logging** — one line per request (`METHOD path -> status (ms)`). Request
  bodies and query strings are never logged, so no secret can leak.
* **Models** — every endpoint declares a Pydantic v2 response model; endpoints
  that return engine-owned payloads use a permissive model
  (`extra="allow"`) so the engine's fields pass through unchanged. Request bodies
  use explicit models.
* **Scope** — the API never implements graph reasoning; if a capability is absent
  from the engine (e.g. ingestion) the endpoint returns 501 instead of
  duplicating logic.

## 9. Implemented endpoints (summary)

| Method | Path |
|---|---|
| GET | `/api/health` |
| GET | `/api/demo/state` |
| POST | `/api/demo/trigger-event` |
| POST | `/api/demo/seed` |
| POST | `/api/demo/reset` |
| GET | `/api/dataset/scenarios` |
| GET | `/api/graph` |
| GET | `/api/paths` |
| GET | `/api/search` |
| GET | `/api/sources` |
| GET | `/api/sources/{source_id}` |
| GET | `/api/decisions/{decision_id}/explanation` |
| POST | `/api/decisions/{decision_id}/status` |
| GET | `/api/decisions/{decision_id}/dependencies` |
| GET | `/api/facts/{fact_id}/explanation` |
| GET | `/api/experts` |
| POST | `/api/experts/query` |
| POST | `/api/contradictions/find` |
| POST | `/api/staleness/propagate` |
| GET | `/api/alerts` |
| GET | `/api/alerts/{alert_id}` |
| GET | `/api/alerts/{alert_id}/history` |
| POST | `/api/alerts/{alert_id}/review` |
| GET | `/api/history/belief` |
| GET | `/api/history/valid` |
| GET | `/api/history/changes` |
| GET | `/api/history/facts/{fact_id}` |
| GET | `/api/history/facts/{fact_id}/source-of-change` |
| GET | `/api/ingest/adapters` (501 in this build) |
| POST | `/api/ingest` (501 in this build) |
| GET | `/api/entities` |
| GET | `/api/decisions` · `/api/people` · `/api/projects` · `/api/systems` · `/api/teams` · `/api/assumptions` · `/api/events` |
| GET | `/api/{kind}/{entity_id}` (same seven kinds) |

## 10. Temporal, identity and trust semantics

These rules describe the implementation exactly (`tripwire/core/models.py`,
`history.py`, `index.py`, `alerts.py`); clients should rely on them rather than
re-deriving meaning from raw strings.

### 10.1 `label` vs `name`

* **`label`** is the node's **kind** - the schema type: `Decision`, `Person`,
  `Project`, `System`, `Team`, `Assumption`, `Fact`, `Event`, `Alert`,
  `Message`, `Document`.  `type` is an identical copy for renderers that key on
  `type`.  Filter, group and pick iconography by `label`/`type`.
* **`name`** is the **human-readable display name** ("Launch Northwind in the EU
  on the Frankfurt hosting partner").  Never parse it, never use it as a key.
* **`id`** is the canonical identifier (`decision:eu-launch`,
  `person:jonas-berg`); it is stable and is what every other endpoint takes.
* Entity-list items add **`kind`** (the lowercase list key, e.g. `decisions`)
  and **`state`** (the node's recorded status lowercased - `active`,
  `potentially_stale`, `contested`, ...; `recorded` for events, `unknown` when
  the node records no status).  `state` is presentation-normalised text;
  `status` remains the authoritative stored value.

### 10.2 `recorded_to` vs `valid_to` (bitemporal time)

Tripwire stores two independent time axes on facts:

* **`recorded_at` / `recorded_to` - transaction (belief) time**: the half-open
  interval `[recorded_at, recorded_to)` during which **Tripwire believed** the
  record.  `recorded_to` is the end of the record's *recorded lifetime* and is
  set when the system genuinely stops treating it as the current belief -
  most commonly when a later assertion **supersedes** it.  `recorded_to = null`
  means "still believed" (see `still_believed` in
  `/api/history/facts/{fact_id}`).  A contradiction alone does **not** close the
  interval; it sets `status = CONTESTED` and leaves `recorded_to` open.
* **`valid_from` / `valid_to` - valid (effective) time**: the period for which
  the fact is claimed to be **true in the real world**.  `valid_to` may be a
  **scheduled future expiry**.  **A future `valid_to` does not mean the record
  is already invalid** - it means "currently true, expires then".  Only
  `valid_to <= now` (or a superseding assertion/contradiction) makes a fact no
  longer current.

Reading the two together:

| situation | `recorded_to` | `valid_to` | `status` | client should show |
|---|---|---|---|---|
| current belief, true now | `null` | future/`null` | `ACTIVE` | **current** |
| superseded by a newer assertion | set (past) | may be past or future | `ACTIVE`/`INVALIDATED` | **superseded** - do not present as the current belief |
| expired in the real world | `null` or past | **past** | `INVALIDATED`/`ACTIVE` | **expired** - belief may still be recorded, truth window ended |
| contradicted, review pending | `null` | varies | `CONTESTED` | **contested / unresolved** - not confirmed false |
| decision flagged by propagation | n/a | n/a | `POTENTIALLY_STALE` | **potentially stale** - supporting evidence may still exist; this is *not* a confirmation of staleness |

Use `/api/history/belief?at=` for "what did we believe then",
`/api/history/valid?at=` for "what was true then", and
`/api/history/changes?since=` for "what did we learn since".  The Frankfurt
scenario demonstrates the last distinction:
`decision:eu-launch` is `POTENTIALLY_STALE` while independent SOC 2 evidence
still supports `assumption:data-residency-eu`, and
`project:pricing-v2` - not the decision - is the entity whose only support is
challenged.  Potential staleness is never upgraded to `STALE` without an
explicit, confirmed review.

### 10.3 Path traversal direction and `edge_direction` (`GET /api/paths`)

* Paths are **walks**: every step continues from the previous step's node
  (`step[i].dst == step[i+1].src`), found with a single mixed-direction search,
  so a chain that leaves the source backwards and rejoins forwards (e.g.
  `Fact <-SUPPORTED_BY- Assumption <-ASSUMES- Decision -IMPACTS-> Project`) is
  reported correctly.
* Edges are *stored* with their schema direction (e.g. `Decision -ASSUMES->
  Assumption`).  A walk often follows an edge **against** that storage
  direction.  Each step therefore reports both:
  * `src`/`dst` - the **walk** order (how the chain reads), and
  * `props.edge_direction` - `"forward"` when the walk follows the stored
    direction (`stored_src -> stored_dst`), `"reverse"` when it goes against it
    (`props.stored_src`/`props.stored_dst` always record the true stored
    endpoints).
* Rendering a path must honour walk order; `edge_direction` exists so the true
  storage direction is never hidden or reinterpreted.
* Validation is strict: an unknown endpoint returns `found: false` with a
  `reason`, and a chain that is not connected from the requested source is
  **truncated**, never fabricated into a plausible-looking path.  A response
  with `found: false` must never be displayed as an evidence chain.

### 10.4 Alerts: `allowed_transitions`, review notes and history

* **`allowed_transitions`** (on `GET /api/alerts/{id}` and the list items) is
  derived directly from `ALERT_STATUS_TRANSITIONS` in
  `tripwire/core/alerts.py`: `[current_status, *legal next statuses]`.  It is
  the single source of truth - clients must offer only these options; any other
  target returns **409** (`invalid_transition`), an unknown status **422**, an
  unknown alert **404** (see section 5 for the table).
* **Same-status review with a `note`** is the supported way to add review
  commentary without changing status: the alert stays in its status (200, no
  transition), and the note is **persisted** on the alert (`review_note`,
  `last_review_note`, `last_reviewed_by`) and appended to the alert history as
  an `ALERT_REVIEW_NOTE` entry whose summary quotes it.
* **Same-status review without a `note`** is an idempotent no-op: 200, no new
  history entry, no state change - repeated calls cannot inflate the history.
* **Alert history** (`GET /api/alerts/{id}/history`) is append-only and ordered:
  every real status change appears as `ALERT_STATUS_CHANGE` with actor, `from`/
  `to` and optional `note`.  History is never rewritten, and a note-less
  duplicate review adds nothing.
