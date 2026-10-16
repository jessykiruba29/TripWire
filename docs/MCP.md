# Tripwire MCP server

Tripwire exposes its knowledge graph to MCP (Model Context Protocol) clients.
The MCP tools are **thin adapters**: they validate their arguments, call the same
`tripwire.core.engine.GraphEngine` the HTTP API calls, and return a JSON object.
There is no second store, no second graph implementation and no reasoning in this
layer - so an answer from `find_experts` over MCP and from `GET /api/experts` over
HTTP is the same answer from the same engine.

| Component | Path |
| --- | --- |
| Tool callables (importable, directly testable) | `tripwire/mcp_server/tools.py` |
| `build_server()` / `run()` and transports | `tripwire/mcp_server/server.py` |
| `python -m tripwire.mcp_server` CLI | `tripwire/mcp_server/__main__.py` |
| Tests | `tests/test_mcp_tools.py` |

Implemented against **mcp 2.3.0**, where the server class is
`mcp.server.mcpserver.MCPServer` (`mcp.server.fastmcp` no longer exists in this
line). Server identity: name `tripwire`, version `1.0.0` (from
`tripwire.__version__`), 13 tools.

---

## 1. Starting the server

### stdio (primary - for local MCP clients)

```powershell
python -m tripwire.mcp_server
```

### streamable-http (for remote/HTTP clients)

```powershell
python -m tripwire.mcp_server --transport streamable-http --port 8765
# the endpoint is then  http://127.0.0.1:8765/mcp
```

### CLI flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--transport {stdio,streamable-http}` | `stdio` | Transport to serve. |
| `--host` | `127.0.0.1` | HTTP bind host. |
| `--port` | `8765` | HTTP bind port. |
| `--path` | `/mcp` | HTTP mount path. |
| `--store {memory,json,falkordb}` | `$TRIPWIRE_STORE`, then `falkordb` | Override the store backend for this process. |
| `--seed` | off | Seed the Northwind Labs demo dataset if the graph is empty. |
| `--log-level` | `INFO` | Python logging level. |

### stdout vs stderr

On the stdio transport **stdout carries the JSON-RPC protocol** and nothing else.
Every startup diagnostic (`store backend=...`, `serving stdio ...`, seeding
summary, errors) is written to **stderr** by `tripwire/mcp_server/__main__.py`. A
stray `print` on stdout would corrupt the session, so the CLI never uses it.
Server-side logging is also redirected to stderr.

Diagnostics you should expect on stderr at startup:

```
[tripwire-mcp] store backend=memory (configured=memory) nodes=0 edges=0 seeded=False
[tripwire-mcp] serving stdio (stdout is reserved for the MCP protocol)
```

### Mounting the HTTP app inside another server

```python
from tripwire.mcp_server.server import build_server, streamable_http_app, run

# blocking entry point (stdio or HTTP)
run(transport="streamable-http", host="127.0.0.1", port=8765)

# or hand the ASGI app to an existing server
app = streamable_http_app(path="/mcp")
```

`build_server(engine=None)` is the factory. When `engine` is omitted it builds the
engine with `GraphEngine.from_settings()`, exactly like the API does, honouring
`TRIPWIRE_STORE` and the JSON fallback.

---

## 2. Client configuration

A generic MCP client configuration (this is the shape Claude Desktop, most IDE
agents and the `mcp` CLI use):

```json
{
  "mcpServers": {
    "tripwire": {
      "command": "python",
      "args": ["-m", "tripwire.mcp_server"],
      "env": {
        "TRIPWIRE_STORE": "json",
        "TRIPWIRE_STATE_PATH": "data/graph.json",
        "TRIPWIRE_MAX_PROPAGATION_DEPTH": "3",
        "TRIPWIRE_LOG_LEVEL": "INFO"
      }
    }
  }
}
```

Notes that matter in practice:

* `command` must resolve **in the client's** PATH. If it does not, use the absolute
  interpreter path, e.g. `"command": "C:\\Python312\\python.exe"`.
* If `tripwire` is not installed into the interpreter (it is a repo package), either
  run the client with the repo as the working directory or add the repo root to
  `PYTHONPATH` in `env`.
* **`TRIPWIRE_STORE`** chooses the backend:
  * `json` (with `TRIPWIRE_STATE_PATH`, default `data/graph.json`) - a JSON-backed
    graph file. This is what lets an MCP session and a locally running API process
    **share one graph**: both read and write the same file, so a fact asserted
    through the API is immediately visible to the tools and vice versa.
  * `memory` - an ephemeral in-process graph; ideal for throwaway sessions and
    tests, and it never touches disk. A fresh MCP session starts empty (use
    `trigger_demo_event`/`--seed` if you want content).
  * `falkordb` - the **production** backend. It needs a reachable FalkorDB
    (default `localhost:6379`, graph `tripwire`); if it is unreachable and
    `TRIPWIRE_STORE_FALLBACK` is true (default) Tripwire logs a warning and falls
    back to the JSON store, and the active backend is always reported by
    `graph_summary` and `health`.
* For the streamable-http transport, point the client at the URL instead:
  `http://127.0.0.1:8765/mcp`.

---

## 3. Tools

All 13 tools return a JSON object. `find_contradictions`, `propagate_staleness`,
`find_experts` and `explain_path` are the four core tools; the rest are additive
and use the same engine.

| Tool | Purpose | Parameters (type / default / bounds) | Returns |
| --- | --- | --- | --- |
| **`find_contradictions`** | Compare an existing fact id or a hypothetical claim against the graph. Read-only. | `fact_id` str? `null`; `candidate` object? `null` (`{subject, attribute, value[, statement, valid_from, valid_to, confidence, verified]}`); `use_llm` bool `true` | `detected`, `contradiction_found`, `new_fact_id`, `new_claim`, `considered`, `llm_used`, `summary` (counts per kind), `candidates[]`, `primary`, `paths[]`, `notes[]` |
| **`propagate_staleness`** | Plan (and optionally apply) propagation from a changed/contradicted fact. | `fact_id` str (**required**); `max_depth` int `3` (0-8); `dry_run` bool `true`; `create_alerts` bool `true` | `fact_id`, `dry_run`, `applied`, `plan` (`counts`, `affected[]` with `certainty`/`paths`/`alternate_evidence`/`reason`, `assumptions[]`, `seed_decisions[]`, `notes[]`), `written` (engine impact report, or `null` on dry run) |
| **`find_experts`** | Rank contributors for a system/project from contribution evidence. | `query` str (**required**); `limit` int `5` (1-50) | `query`, `target_id`, `target_name`, `method`, `experts[]` (`rank`, `person_name`, `score`, `normalized_score`, `contribution_counts`, `evidence_refs[]`, `is_official_owner`, `shadow_signal`, `reason`, `contributions[]`), `ranked_people`, `official_owners[]`, `hidden_experts[]`, `shadow_org_signal`, `related_targets[]`, `notes[]` |
| **`explain_path`** | Relationship path(s) between two entities; honest when none exists. | `source` str (**required**); `target` str (**required**); `rels` list[str]? `null`; `max_depth` int `6` (0-8) | `found`, `source`, `target`, `path_count`, `paths[]` (`nodes`, `rels`, `length`, `steps[]`, `narrative`), `reason`, `generated_at` |
| `explain_decision` | Why a decision was made and what supports it. | `decision_id` str (**required**) | `found`, `decision`, `dependencies[]`, `evidence[]`, `contributors[]`, `alerts[]`, `alternate_evidence[]` (or `found: false` + `reason`) |
| `explain_alert` | An alert end to end from its own evidence. | `alert_id` str (**required**) | `found`, `alert`, `evidence` (new/old fact provenance), `affected[]`, `reviewers[]`, `history[]` (or `found: false` + `reason`) |
| `explain_fact` | Provenance and contradictions of one fact. | `fact_id` str (**required**) | `found`, `fact`, `provenance`, `contradictions[]`, `supporting_assumptions[]`, `affected_entities[]` (or `found: false` + `reason`) |
| `list_alerts` | Review queue with a status histogram. | `status` str? `null` (one of `NEW`, `NEEDS_REVIEW`, `CONFIRMED_STALE`, `DISMISSED`, `RESOLVED`); `limit` int `50` (1-200); `offset` int `0`; `severity` str?; `entity_id` str? | `total`, `count`, `limit`, `offset`, `status_counts`, `alerts[]` |
| `review_alert` | Move an alert through the status machine. | `alert_id` str (**required**); `status` str (**required**, enum above); `actor_id` str?; `note` str `""` | `alert_id`, `status`, `previous_status`, `updated_at`, `reviewed_by`, `review_note`, `affected[]` |
| `graph_summary` | Counts, dataset state, backend and health. | none | `seeded`, `health`, `counts` (`nodes`, `edges`, `by_label`, `by_rel`), `dataset` (incl. `matches_expected`), `store`, `llm`, `alerts`, `key_entities`, `config` |
| `search_knowledge` | Substring search over names, statements and source text. | `query` str (**required**); `limit` int `25` (1-200) | `query`, `total`, `results[]` |
| `history_query` | Bitemporal history, selected by mode. | `mode` str (**required**: `belief`, `valid`, `changes`, `fact`, `source_of_change`, `dependencies`); `at` str?; `since` str?; `fact_id` str?; `decision_id` str?; `subject_id` str?; `attribute` str?; `limit` int `200` (1-200) | per mode: `belief` -> `at`, `label`, `total`, `facts[]`; `valid` -> `at`, `subject_id`, `attribute`, `total`, `facts[]`; `changes` -> `since`, `facts[]`, `fact_count`, `events[]`, `event_count`; `fact` -> `fact_id`, `name`, `status`, `valid_from/to`, `recorded_at/to`, `still_believed`, `entries[]`; `source_of_change`/`dependencies` -> see engine payloads |
| `trigger_demo_event` | Run a named demo scenario (or an explicit fact) through the whole pipeline. | `scenario` str?; `new_fact` object?; `source` object?; `actor_id` str?; `apply` bool `true` | `event`, `assertion`, `contradiction`, `contradiction_edges[]`, `propagation`, `impacts[]`, `alert_ids[]` |

Bounds are enforced twice: the generated JSON Schema carries `minimum`/`maximum`
for `max_depth` and `limit`, and the tool re-checks them so a direct (in-process)
call gets the same structured rejection as a protocol call. Enums such as alert
statuses are validated against `tripwire.core.schema` vocabulary.

Mode requirements for `history_query`: `belief`/`valid` need `at`, `changes` needs
`since`, `fact`/`source_of_change` need `fact_id`, `dependencies` needs
`decision_id` and `at`. A missing one is a `validation_error`.

---

## 4. Example requests and real responses

Every response below was produced by calling the tool against the seeded
Northwind Labs dataset (`GraphEngine(MemoryGraphStore(), settings=Settings(store_backend="memory"))`
+ `seed_demo()`). Where a block is abridged, it says so; nothing was invented.
Timestamps and hash-derived ids vary per run.

### 4.1 `find_contradictions` - hypothetical claim (read-only)

Request arguments:

```json
{
  "candidate": {
    "subject": "Frankfurt Hosting Partner",
    "attribute": "compliance_status",
    "value": "revoked"
  }
}
```

Real response (abridged: only the first of 6 `candidates` is shown; `primary` and
`paths` are complete):

```json
{
  "new_fact_id": "fact:6ed3518f030a",
  "new_claim": {
    "fact_id": "fact:6ed3518f030a",
    "subject_id": "system:frankfurt-hosting-partner",
    "subject_name": "Frankfurt Hosting Partner",
    "attribute": "compliance_status",
    "value": "revoked",
    "polarity": -1,
    "valid_from": null,
    "valid_to": null,
    "recorded_at": "2026-10-15T16:48:55Z",
    "recorded_to": null,
    "confidence": 0.9,
    "verified": true,
    "status": "ACTIVE",
    "source_id": null,
    "statement": "Frankfurt Hosting Partner: compliance_status = revoked"
  },
  "contradiction_found": true,
  "considered": 6,
  "llm_used": false,
  "summary": {
    "contradiction": 1,
    "unverified": 0,
    "ambiguous": 0,
    "temporal": 0,
    "additive": 5,
    "unrelated": 0
  },
  "notes": [],
  "candidates": [
    {
      "kind": "contradiction",
      "existing_fact_id": "fact:frankfurt-partner-compliance-valid",
      "new_fact_id": "fact:6ed3518f030a",
      "attribute": "compliance_status",
      "existing_value": "valid",
      "new_value": "revoked",
      "severity": "high",
      "confidence": 0.93,
      "rationale": "Both facts describe 'compliance_status' for Frankfurt Hosting Partner: the earlier record states 'valid' while the new record states 'revoked', with overlapping validity, so they cannot both hold. Rule 'compliance_revocation': A compliance or certification status asserted as revoked contradicts an earlier affirmation for the same subject: downstream commitments that depend on it may no longer be lawful or deliverable.",
      "review_status": "NEEDS_REVIEW",
      "explicit_rule": "compliance_revocation",
      "llm_assisted": false,
      "temporal_overlap": true,
      "contradicts": true,
      "already_recorded": false
    }
  ],
  "primary": {
    "kind": "contradiction",
    "existing_fact_id": "fact:frankfurt-partner-compliance-valid",
    "new_fact_id": "fact:6ed3518f030a",
    "attribute": "compliance_status",
    "existing_value": "valid",
    "new_value": "revoked",
    "severity": "high",
    "confidence": 0.93,
    "rationale": "Both facts describe 'compliance_status' for Frankfurt Hosting Partner: the earlier record states 'valid' while the new record states 'revoked', with overlapping validity, so they cannot both hold. Rule 'compliance_revocation': A compliance or certification status asserted as revoked contradicts an earlier affirmation for the same subject: downstream commitments that depend on it may no longer be lawful or deliverable.",
    "review_status": "NEEDS_REVIEW",
    "explicit_rule": "compliance_revocation",
    "llm_assisted": false,
    "temporal_overlap": true,
    "contradicts": true,
    "already_recorded": false
  },
  "paths": [
    {
      "nodes": ["fact:6ed3518f030a", "fact:frankfurt-partner-compliance-valid"],
      "rels": ["CONTRADICTS"],
      "length": 1,
      "steps": [
        {
          "src": "fact:6ed3518f030a",
          "rel": "CONTRADICTS",
          "dst": "fact:frankfurt-partner-compliance-valid",
          "src_name": "fact:6ed3518f030a",
          "dst_name": "Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.",
          "src_label": null,
          "dst_label": "Fact",
          "props": {
            "edge_direction": "forward",
            "stored_src": "fact:6ed3518f030a",
            "stored_dst": "fact:frankfurt-partner-compliance-valid"
          }
        }
      ],
      "narrative": "fact:6ed3518f030a -> -[CONTRADICTS]-> Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12."
    }
  ],
  "detected": true
}
```

`detected` is Tripwire's spec name for `contradiction_found`; both are always
present and always equal. Nothing was written: the hypothetical fact id is
ephemeral.

### 4.2 `propagate_staleness` - dry run (the default)

Request arguments:

```json
{ "fact_id": "fact:frankfurt-partner-compliance-valid", "max_depth": 3 }
```

Real response (abridged: `plan.affected[0]` is shown in full, the other 7 affected
entities and 2 further paths are omitted):

```json
{
  "fact_id": "fact:frankfurt-partner-compliance-valid",
  "dry_run": true,
  "applied": false,
  "plan": {
    "source_fact_id": "fact:frankfurt-partner-compliance-valid",
    "source_fact_name": "Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.",
    "source_fact_status": "ACTIVE",
    "source_fact_verified": true,
    "evaluated_at": "2026-10-15T16:48:55Z",
    "max_depth": 3,
    "assumptions": ["assumption:data-residency-eu", "assumption:eu-regulatory-eligibility"],
    "seed_decisions": ["decision:eu-launch", "decision:legal-signoff-eu"],
    "counts": {
      "assumptions": 2,
      "seed_decisions": 2,
      "affected_total": 8,
      "affected_decisions": 4,
      "affected_projects": 4,
      "confirmed": 2,
      "potential": 6
    },
    "affected": [
      {
        "entity_id": "decision:eu-launch",
        "entity_name": "Launch Northwind in the EU on the Frankfurt hosting partner",
        "entity_label": "Decision",
        "seed_decision_id": "decision:eu-launch",
        "depth": 0,
        "certainty": "potential",
        "status_before": "ACTIVE",
        "status_after": "POTENTIALLY_STALE",
        "contributing_assumptions": ["assumption:data-residency-eu"],
        "contributing_facts": [
          "fact:frankfurt-partner-compliance-valid",
          "fact:frankfurt-partner-soc2-attestation-valid"
        ],
        "alternate_evidence": [
          {
            "assumption_id": "assumption:data-residency-eu",
            "assumption_name": "EU data residency is contractually enforceable in Frankfurt",
            "fact_id": "fact:frankfurt-partner-soc2-attestation-valid",
            "fact_value": "soc2_type_ii_valid",
            "fact_status": "ACTIVE",
            "fact_confidence": 0.9,
            "source_id": null,
            "why_survives": "'EU data residency is contractually enforceable in Frankfurt' is still supported by 'Frankfurt Hosting Partner's independent SOC 2 Type II attestation is valid to 2027-03-31.' (status ACTIVE), so the decision does not rest on the changed fact alone."
          }
        ],
        "has_alternate_evidence": true,
        "reason": "'Launch Northwind in the EU on the Frankfurt hosting partner' assumes 'EU data residency is contractually enforceable in Frankfurt', which is supported by 'Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.' (changed). Review the decision's continued validity. Independent evidence still supports the assumption ('fact:frankfurt-partner-soc2-attestation-valid'), so this is flagged as potentially affected and requires human review before any status change.",
        "hops": 0,
        "paths": [
          {
            "nodes": [
              "fact:frankfurt-partner-compliance-valid",
              "assumption:data-residency-eu",
              "decision:eu-launch"
            ],
            "rels": ["SUPPORTED_BY", "ASSUMES"],
            "length": 2,
            "narrative": "Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12. -> -[SUPPORTED_BY]-> EU data residency is contractually enforceable in Frankfurt -> -[ASSUMES]-> Launch Northwind in the EU on the Frankfurt hosting partner"
          }
        ]
      }
    ],
    "notes": [
      "At least one affected decision retains independent supporting evidence; it is reported as potentially affected and is not marked stale."
    ]
  },
  "written": null
}
```

With `"dry_run": false` the same call additionally writes `POTENTIALLY_STALE`
flags, `STALED` edges, events and alerts, and returns them under `written`
(`impact_count`, `decision_count`, `project_count`, `impacts[]` with `status_before`
/ `status_after` / `flagged` / `alert` / `reviewers`). `applied` is then `true`.
The node/edge counts are unchanged by the default dry run - asserted by
`test_propagate_staleness_dry_run_is_non_destructive` and
`test_protocol_dry_run_leaves_the_graph_untouched`.

### 4.3 `find_experts`

Request arguments:

```json
{ "query": "Frankfurt Hosting Partner", "limit": 3 }
```

Real response (abridged: `official_owners` complete; each expert's long
`contributions[]` list and full `evidence_refs[]` trimmed, with counts kept as
returned):

```json
{
  "query": "Frankfurt Hosting Partner",
  "target_id": "system:frankfurt-hosting-partner",
  "target_label": "System",
  "target_name": "Frankfurt Hosting Partner",
  "method": "score = weight(contribution_type) x relevance(distance) x recency(0.5 ^ (age_days/180)) x quality(artefact confidence), summed per person and normalised to the top scorer.",
  "notes": [
    "At least one high-ranking contributor is not the official owner of the target: this is the shadow-organisational-chart signal."
  ],
  "related_targets": [],
  "official_owners": [
    {
      "person_id": "person:lena-fischer",
      "person_name": "Lena Fischer",
      "official_role": "Vendor Manager",
      "team_name": "team:customer-operations",
      "owns": "system:frankfurt-hosting-partner",
      "owns_name": "Frankfurt Hosting Partner"
    }
  ],
  "experts": [
    {
      "rank": 1,
      "person_id": "person:jonas-berg",
      "person_name": "Jonas Berg",
      "role": "Senior Platform Engineer",
      "team_name": "Platform Engineering",
      "score": 11.194,
      "normalized_score": 1,
      "contribution_counts": {
        "resolved_ticket": 5,
        "authored_meeting_note": 1,
        "authored_message": 9,
        "contributed_to_meeting": 1,
        "authored_document": 1
      },
      "contribution_total": 17,
      "systems": [],
      "projects": [],
      "is_official_owner": false,
      "official_owner_of": [],
      "shadow_signal": true,
      "reason": "Jonas Berg (Senior Platform Engineer): discussed the target in 9 message(s), resolved 5 ticket(s) about the target, authored 1 meeting note(s) on the target, participated in 1 meeting(s), authored 1 document(s). Strongest single contribution: 'EU launch readiness checklist' (resolved_ticket, score 1.05).",
      "uncertainty": null,
      "evidence_refs": [
        "document:ticket:nwl-2328",
        "document:ticket:nwl-2343",
        "document:ticket:nwl-2296",
        "document:meeting-note:nwl-mn-002",
        "document:ticket:nwl-2284",
        "document:ticket:nwl-2276",
        "message:slack:nw-slack-019",
        "message:slack:nw-slack-008",
        "... 9 more"
      ],
      "contributions": ["... 8 contribution records, each with weight/relevance/recency/quality/score and source_ref"]
    },
    {
      "rank": 2,
      "person_id": "person:priya-raman",
      "person_name": "Priya Raman",
      "role": "VP Engineering",
      "team_name": "Platform Engineering",
      "score": 4.711,
      "normalized_score": 0.421,
      "contribution_counts": {
        "authored_prd": 1,
        "authored_meeting_note": 1,
        "authored_document": 1,
        "made_decision": 1,
        "authored_message": 3
      },
      "contribution_total": 7,
      "systems": ["system:northwind-ingest-pipeline"],
      "projects": ["project:eu-launch"],
      "is_official_owner": false,
      "official_owner_of": ["project:eu-launch", "system:northwind-ingest-pipeline"],
      "shadow_signal": false,
      "reason": "Priya Raman (VP Engineering): discussed the target in 3 message(s), authored the requirements document, authored 1 meeting note(s) on the target, authored 1 document(s), made 1 decision(s) affecting the target. Strongest single contribution: 'PRD: EU Launch on Frankfurt Hosting Partner' (authored_prd, score 0.86).",
      "uncertainty": null,
      "evidence_refs": ["document:prd:nwl-prd-001", "... 6 more"],
      "contributions": ["... 7 contribution records"]
    }
  ],
  "ranked_people": ["<the same 3 expert objects as `experts`>"],
  "hidden_experts": [
    {
      "rank": 1,
      "person_id": "person:jonas-berg",
      "person_name": "Jonas Berg",
      "role": "Senior Platform Engineer",
      "team_name": "Platform Engineering",
      "score": 11.194,
      "normalized_score": 1,
      "contribution_counts": {
        "resolved_ticket": 5,
        "authored_meeting_note": 1,
        "authored_message": 9,
        "contributed_to_meeting": 1,
        "authored_document": 1
      },
      "contribution_total": 17,
      "systems": [],
      "projects": [],
      "is_official_owner": false,
      "official_owner_of": [],
      "shadow_signal": true,
      "reason": "Jonas Berg (Senior Platform Engineer): discussed the target in 9 message(s), resolved 5 ticket(s) about the target, authored 1 meeting note(s) on the target, participated in 1 meeting(s), authored 1 document(s). Strongest single contribution: 'EU launch readiness checklist' (resolved_ticket, score 1.05).",
      "uncertainty": null,
      "evidence_refs": ["document:ticket:nwl-2328", "... 16 more"],
      "contributions": ["... 8 contribution records"]
    }
  ],
  "shadow_org_signal": {
    "hidden_expert_count": 1,
    "hidden_experts": [
      {
        "person_id": "person:jonas-berg",
        "person_name": "Jonas Berg",
        "normalized_score": 1,
        "is_official_owner": false
      }
    ]
  }
}
```

The story reads off the payload: `person:jonas-berg` is the top-ranked contributor
(17 recorded contributions, mostly hands-on ticket resolution and Slack
discussion) yet is **not** the official owner - `person:lena-fischer` is, and she
does not appear in the ranking at all.

### 4.4 `explain_path`

Request arguments:

```json
{
  "source": "decision:eu-launch",
  "target": "system:frankfurt-hosting-partner"
}
```

Real response (abridged: `source`/`target` node detail and paths 2-3 omitted; path
1 is complete):

```json
{
  "found": true,
  "source": {
    "id": "decision:eu-launch",
    "label": "Decision",
    "type": "Decision",
    "name": "Launch Northwind in the EU on the Frankfurt hosting partner",
    "statement": "Proceed with the EU launch using the Frankfurt hosting partner as the primary hosting provider for EU customer data.",
    "status": "ACTIVE",
    "review_status": "UNREVIEWED",
    "made_at": "2026-02-02T08:30:00Z",
    "created_at": "2026-02-02T08:30:00Z",
    "recorded_at": "2026-02-02T08:30:00Z",
    "decision_key": "eu-launch",
    "found": true
  },
  "target": { "id": "system:frankfurt-hosting-partner", "label": "System", "found": true, "...": "name/statement/status/..." },
  "path_count": 3,
  "paths": [
    {
      "nodes": [
        "decision:eu-launch",
        "project:eu-launch",
        "system:frankfurt-hosting-partner"
      ],
      "rels": ["IMPACTS", "USES"],
      "length": 2,
      "steps": [
        {
          "src": "decision:eu-launch",
          "rel": "IMPACTS",
          "dst": "project:eu-launch",
          "src_name": "Launch Northwind in the EU on the Frankfurt hosting partner",
          "dst_name": "EU Launch",
          "src_label": "Decision",
          "dst_label": "Project",
          "props": { "at": "2026-02-02T08:30:00Z" }
        },
        {
          "src": "project:eu-launch",
          "rel": "USES",
          "dst": "system:frankfurt-hosting-partner",
          "src_name": "EU Launch",
          "dst_name": "Frankfurt Hosting Partner",
          "src_label": "Project",
          "dst_label": "System",
          "props": { "at": "2026-01-05T00:00:00Z", "role": "primary hosting" }
        }
      ],
      "narrative": "Launch Northwind in the EU on the Frankfurt hosting partner -> -[IMPACTS]-> EU Launch -> -[USES]-> Frankfurt Hosting Partner"
    }
  ],
  "reason": "3 simple relationship path(s) found."
}
```

When no path exists, `explain_path` says so instead of inventing one:

```json
{
  "found": false,
  "source": { "id": "decision:eu-launch", "found": true, "...": "..." },
  "target": { "id": "person:no-such-person", "found": false },
  "paths": [],
  "reason": "Target 'person:no-such-person' is not present in the graph."
}
```

### 4.5 `history_query` - `dependencies` mode

Request arguments:

```json
{
  "mode": "dependencies",
  "decision_id": "decision:eu-launch",
  "at": "2035-01-01T00:00:00Z"
}
```

Real response (complete):

```json
{
  "decision_id": "decision:eu-launch",
  "found": true,
  "name": "Launch Northwind in the EU on the Frankfurt hosting partner",
  "status_at_query": "ACTIVE",
  "recorded_at_query": "2035-01-01T00:00:00Z",
  "assumptions": [
    {
      "assumption_id": "assumption:data-residency-eu",
      "name": "EU data residency is contractually enforceable in Frankfurt",
      "recorded_at": "2026-02-02T08:30:00Z",
      "statement": "EU customer data can be stored and processed exclusively in Frankfurt because the partner's EU compliance certification is valid in the launch window.",
      "supporting_facts": [
        {
          "fact_id": "fact:frankfurt-partner-compliance-valid",
          "name": "Frankfurt Hosting Partner holds a current EU compliance certification (DE-CMP-4471), verified on 2026-01-12.",
          "value": "valid",
          "status": "ACTIVE",
          "recorded_at": "2026-01-12T10:05:00Z",
          "valid_from": "2025-04-01T00:00:00Z",
          "valid_to": null
        },
        {
          "fact_id": "fact:frankfurt-partner-soc2-attestation-valid",
          "name": "Frankfurt Hosting Partner's independent SOC 2 Type II attestation is valid to 2027-03-31.",
          "value": "soc2_type_ii_valid",
          "status": "ACTIVE",
          "recorded_at": "2026-01-20T14:30:00Z",
          "valid_from": "2026-01-20T00:00:00Z",
          "valid_to": "2027-03-31T00:00:00Z"
        }
      ]
    }
  ],
  "assumption_count": 1,
  "fact_count": 2
}
```

Asked at a transaction time **before** the decision existed, the same tool
reconstructs the earlier state rather than describing today:

```json
{
  "decision_id": "decision:eu-launch",
  "found": true,
  "status_at_query": null,
  "recorded_at_query": "2020-01-01T00:00:00Z",
  "assumptions": [],
  "assumption_count": 0,
  "fact_count": 0
}
```

Other real results from the same seeded dataset: `belief` at
`2020-01-01T00:00:00Z` -> `total: 0`; `belief` at `2035-01-01T00:00:00Z` ->
`total: 13` (every seeded fact); `valid` at `2026-01-01T00:00:00Z` -> `total: 2`;
`changes` since `2020-01-01T00:00:00Z` -> `fact_count: 13` with the `SEED` event
present.

### 4.6 `list_alerts` (fresh seed)

```json
{
  "total": 0,
  "count": 0,
  "limit": 2,
  "offset": 0,
  "status_counts": {},
  "alerts": []
}
```

After `trigger_demo_event` (or a real event) the histogram fills in and each entry
in `alerts[]` carries `id`, `name`, `status`, `severity`, `certainty`,
`confidence`, `summary`, `evidence_fact_ids`, `certainty_sources`, `reviewers`,
`path_nodes`/`path_rels` and `affected[]`.

---

## 5. Error payloads

A failing tool returns the structured error shape - never a raised exception, never
a traceback. Over the wire this arrives as a normal (non-error) tool result whose
content is this object:

```json
{
  "error": {
    "code": "not_found",
    "message": "fact 'fact:does-not-exist' is not present in the graph",
    "details": {}
  }
}
```

`details` is an object (empty when there is nothing to add). For validation
failures it carries the offending parameter and the allowed range:

```json
{
  "error": {
    "code": "validation_error",
    "message": "max_depth must be between 0 and 8, got 9",
    "details": { "parameter": "max_depth", "min": 0, "max": 8, "value": 9 }
  }
}
```

| `code` | `http_status` | Raised when |
| --- | --- | --- |
| `validation_error` | 422 | Bad or missing input: an out-of-range `max_depth`/`limit`, an unknown alert `status`, both `fact_id` and `candidate` supplied, neither supplied, a `history_query` mode missing its required argument, an unknown `rels` type, an empty search query. |
| `not_found` | 404 | An id does not exist in the graph: unknown fact for `find_contradictions`/`propagate_staleness`, unknown alert for `review_alert`, unknown alert for `explain_alert`. |
| `invalid_transition` | 409 | A forbidden alert status transition (e.g. back to `NEW` from any state). |
| `store_unavailable` | 503 | The graph store cannot be reached. |
| `store_error` | 500 | A graph operation failed for a non-connectivity reason. |
| `llm_unavailable` | 503 | An LLM path was requested but no provider is configured/reachable (the deterministic engine still works). |
| `llm_response_invalid` | 502 | The LLM replied with a payload that failed validation (never written as truth). |
| `ingestion_error` | 400 | A source record could not be ingested. |
| `configuration_error` | 500 | Invalid configuration (never includes secret values). |
| `engine_error` | 500 | An engine-level failure that is not more specific. |
| `internal_error` | - | An unexpected non-Tripwire failure (for example a plain `ValueError` from a core helper). It is logged server-side **and** returned as a structured payload so a client still gets valid JSON. |

Some "not found" cases are deliberately **not** errors, because a structured
answer is more useful than a failure: `explain_decision`, `explain_alert` and
`explain_fact` return `{"found": false, "reason": "...", "missing": [...]}`, and
`propagate_staleness` for an unknown fact returns an empty plan whose `notes`
explain that nothing propagated.

---

## 6. Behaviour worth knowing

* **`propagate_staleness` defaults to `dry_run: true`.** A plain tool call plans
  the propagation and writes **nothing** - no status flags, no `STALED` edges, no
  alerts, no node/edge count change. Writes happen only when the caller passes
  `"dry_run": false` (and `create_alerts` controls whether alerts are raised).
* **Tripwire never auto-invalidates a decision.** Propagation only ever proposes
  `POTENTIALLY_STALE`; promotion to `STALE` requires an explicit, confirmed review
  (`set_decision_status(..., confirm=true)` on the engine/API side).
* **Read-only tools.** `find_contradictions` with a `candidate`, `explain_path`,
  `explain_decision`, `explain_alert`, `explain_fact`, `graph_summary`,
  `search_knowledge`, `history_query` and `list_alerts` do not write to the graph.
  `trigger_demo_event` writes unless `apply: false`, and `review_alert` writes a
  review transition.
* **One engine.** The tools call `GraphEngine` directly; there is no duplicated
  business logic in this package, so the MCP surface and the HTTP API cannot
  disagree about a contradiction, a propagation path or an expert ranking.

---

## 7. Tests

`tests/test_mcp_tools.py` covers the surface at three levels:

1. **Direct unit tests** against a seeded memory-store engine - tool names, return
   shapes, bounds, structured errors, `dry_run` non-destructiveness, real history
   data.
2. **In-memory protocol tests** using the SDK's `InMemoryTransport`
   (`mcp.client._memory`) with a real `ClientSession`: `list_tools` over the wire,
   `find_experts` and `find_contradictions` called through the protocol, and
   structured errors travelling back as tool results.
3. **stdio subprocess test**: spawns `python -m tripwire.mcp_server` via
   `mcp.client.stdio.stdio_client`, initialises a session, asserts the server name
   is `tripwire`, that every tool is listed, and calls `graph_summary`.

```powershell
python -m pytest tests/test_mcp_tools.py -q
```
