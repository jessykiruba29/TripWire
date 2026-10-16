# Tripwire — Graph Schema

`tripwire/core/schema.py` is the single source of truth for the graph vocabulary.
The store layer, ingestion pipeline, reasoning engine, HTTP API and MCP tools all
import their vocabulary from it, so the schema cannot drift between layers.
Anything below that is not in that module was extracted from `tripwire/core/models.py`,
`tripwire/core/ids.py`, the reasoning modules, and the real seeded dataset.

## 1. Node types

`NODE_TYPES` (11 entries):

```
Person, Team, System, Project, Decision, Assumption, Fact,
Message, Document, Event, Alert
```

Ten of these are the specification's node types (spec S4). `Alert` is the one
documented addition; see §1.12. Property names in the tables below are the exact
keys used in code and in the seeded dataset. "ISO" = an ISO-8601 UTC string such as
`2026-02-20T08:15:00Z`.

### 1.1 `Person`

Purpose: a human, resolved by name to a stable slug id so spelling variants
collapse to one node.

| Property | Type | Meaning |
| --- | --- | --- |
| `role` | string | Job title, e.g. `Senior Platform Engineer`. |
| `team_name` | string | Display name of the person's team. |
| `team_id` | string | Id of the `Team` node (`team:platform-engineering`). |
| `handle` | string | Short handle, e.g. `@jonas`. |
| `location` | string | City, e.g. `Berlin`. |
| `tenure_years` | number | Years at the company. |
| `display_name` | string | Set by `GraphEngine.ensure_person()` when a person is created by name. |

### 1.2 `Team`

Purpose: an organisational unit; the axis for ownership and the expert finder.

| Property | Type | Meaning |
| --- | --- | --- |
| `focus` | string | What the team is responsible for. |
| `cost_centre` | string | Accounting code, e.g. `ENG-100`. |

### 1.3 `System`

Purpose: an internal service, control or external partner that projects use and
decisions depend on.

| Property | Type | Meaning |
| --- | --- | --- |
| `system_type` | string | `external_partner` / `internal_control` / `internal_service`. |
| `region` | string | Deployment region, e.g. `eu-central`, `multi`. |
| `criticality` | string | `tier-1` / `tier-2` / `tier-3`. |

### 1.4 `Project`

Purpose: a business initiative a decision impacts.

| Property | Type | Meaning |
| --- | --- | --- |
| `status` | string | Free text (not a controlled vocabulary) — the plan state, e.g. `ACTIVE`. |
| `target_date` | string | ISO date the project targets, e.g. `2026-06-30`. |
| `owner_role` | string | The role recorded as project owner. |
| `staleness_flag` | string | Set by propagation to `POTENTIALLY_STALE` (projects are not forced into the decision status vocabulary). |
| `review_reason` | string | Human-readable reason the project was flagged. |
| `review_since` | string | First time the project was flagged (ISO). |
| `stale_cause_fact_id` | string | The fact whose change caused the flag. |
| `stale_certainty` | string | `potential` / `confirmed`. |
| `last_evaluated_at` | string | ISO instant of the most recent evaluation. |

### 1.5 `Decision`

Purpose: the primary unit of review — a recorded choice with a status the engine
can flag.

| Property | Type | Meaning |
| --- | --- | --- |
| `statement` | string | The decision in prose. |
| `status` | enum(5) | One of `DECISION_STATUSES` (§6). |
| `review_status` | enum(5) | One of `REVIEW_STATUSES` (§6). |
| `made_at` | string | ISO instant the decision was made. |
| `created_at` | string | ISO instant the node was created (immutable-once-set). |
| `recorded_at` | string | ISO transaction time (immutable-once-set). |
| `decision_key` | string | The dataset key (e.g. `eu-launch`). |
| `previous_status` | string | Status before the last transition. |
| `stale_reason` | string | Why the decision was flagged. |
| `stale_since` | string | First time it was flagged. |
| `stale_cause_fact_id` | string | The fact that caused the flag. |
| `stale_certainty` | string | `potential` / `confirmed`. |
| `last_evaluated_at` | string | ISO instant of last evaluation. |
| `stale_alert_ids` | list[string] | Alert ids raised for this decision (history). |
| `reviewed_by` | string | Person id of the reviewer after an explicit status change. |
| `review_note` | string | Reviewer's note. |
| `final_status_at` | string | ISO instant of the last explicit status change. |

### 1.6 `Assumption`

Purpose: an intermediate claim a decision rests on; the hinge between decisions and
facts in propagation.

| Property | Type | Meaning |
| --- | --- | --- |
| `statement` | string | The assumption in prose. |
| `status` | string | Free text (`ACTIVE` in the seed); assumptions have no controlled status vocabulary. |
| `review_status` | enum(5) | One of `REVIEW_STATUSES`. |
| `created_at` | string | ISO instant created (immutable-once-set). |
| `recorded_at` | string | ISO transaction time (immutable-once-set). |
| `assumption_key` | string | The dataset key (e.g. `data-residency-eu`). |

### 1.7 `Fact`

Purpose: a single-valued claim about a subject, with both a real-world and a
transaction interval; the leaf of the provenance chain and the unit of
contradiction.

| Property | Type | Meaning |
| --- | --- | --- |
| `subject_id` | string | Id of the entity the fact is about. |
| `subject_name` | string | Display name of that subject. |
| `attribute` | string | The claim's attribute (e.g. `compliance_status`, `hosting_region`). |
| `value` | any | The asserted value. |
| `statement` | string | Human-readable statement. |
| `valid_from` | ISO | When the claim became true in the real world. |
| `valid_to` | ISO / null | When it stopped being true (open if null). |
| `recorded_at` | ISO | When Tripwire first believed it (immutable-once-set). |
| `recorded_to` | ISO / null | When Tripwire stopped believing it (open if null). |
| `status` | enum(4) | One of `FACT_STATUSES` (§6). |
| `confidence` | number 0–1 | Extraction/verdict confidence. |
| `verified` | bool | Whether the source was verified. |
| `review_status` | enum(5) | One of `REVIEW_STATUSES`. |
| `source_id` | string | Id of the `Message`/`Document` that states it. |
| `source_ref` | string | Human-readable locator, e.g. `slack:#data-compliance/2026-01-12`. |
| `provenance_class` | string | `verified` / `unverified_claim`. |
| `value_text` | string | Fallback text value when `value` is absent (used by `claim_from_node`). |
| `invalidated_by` | string | Fact id of a verified contradiction (set by `record_contradiction`). |
| `contested_by` | string | Fact id of an unverified contradiction. |
| `contested_at` | ISO | When the unverified contradiction was recorded. |
| `extraction`, `extraction_pattern`, `source_span`, `adapter` | string | Added by ingestion for extracted facts. |

### 1.8 `Message`

Purpose: a chat-shaped source artifact (Slack message or webhook-shaped record).

| Property | Type | Meaning |
| --- | --- | --- |
| `source_system` | string | `slack`. |
| `external_id` | string | The provider's message id (dedupe key). |
| `doc_type` | null | Messages have no document type. |
| `title` | string | Short summary. |
| `text` | string | The body. |
| `channel` | string | e.g. `#eu-launch`. |
| `timestamp` | ISO | Message instant. |
| `recorded_at` | ISO | Transaction time (set to the timestamp). |
| `source_ref` | string | `slack:#data-compliance/2026-01-12`. |
| `confidence` | number | Extraction confidence. |
| `status` | string | Provider status (may be null). |
| `author_id` | string | Person id of the author. |
| `raw_payload`, `adapter`, `adapter_integration_type` | string | Added by ingestion (raw payload retained). |

### 1.9 `Document`

Purpose: a written source artifact — tickets, PRDs and meeting notes are all
`Document` nodes discriminated by `doc_type`, so one ingestion and provenance path
serves every document-shaped source while the frontend/API can still filter by
source kind.

| Property | Type | Meaning |
| --- | --- | --- |
| `doc_type` | enum(4) | One of `DOC_TYPES`: `ticket`, `prd`, `meeting_note`, `design_doc`. |
| `source_system` | string | `ticket` / `prd` / `meeting_note`. |
| `external_id` | string | e.g. `NWL-2276`, `NWL-PRD-001`. |
| `title`, `text` | string | Title and body. |
| `channel` | string / null | null for documents. |
| `timestamp`, `recorded_at` | ISO | Publication instant. |
| `source_ref` | string | e.g. `ticket:NWL-2276`. |
| `confidence` | number | Extraction confidence. |
| `status` | string | Provider status (`done`, `open`, `in_progress`), stored verbatim. |
| `author_id` | string | Person id of the author/reporter. |
| `raw_payload`, `adapter`, `adapter_integration_type` | string | Added by ingestion. |

### 1.10 `Event`

Purpose: an append-only audit record; also the mechanism for reconstructing status
history. Event ids deliberately exclude the wall clock so replay does not append
duplicates.

| Property | Type | Meaning |
| --- | --- | --- |
| `event_type` | enum(12) | One of `EVENT_TYPES` (§6). |
| `summary` | string | Human-readable description. |
| `recorded_at`, `at` | ISO | Instant the event was recorded. |
| `actor_id` | string / null | Who caused it. |
| `subject_id` | string / null | The entity it concerns. |
| plus extras | varies | e.g. `fact_id`, `old_fact_id`, `new_fact_id`, `entity_id`, `alert_id`, `from_status`, `to_status`, `cause_fact_id`, `certainty`, `kind`, `verified`, `confidence`, `explicit_rule`, `adapter`, `extractor`, `llm_used`, `llm_failed`, `duplicate_source`, `counts`, `warnings`, `dataset_version`, `expected_counts`, `generated_counts`. |

### 1.11 `Alert` — the added node type

Purpose: a first-class, persistent, reviewable warning with its own status machine
and history.

**Why it was added.** Spec S11 requires deduplicated alerts, a review status,
preserved alert history and API availability. Modelling alerts as `Event` nodes
would have conflated "something happened" with "someone must review this"
(`tripwire/core/schema.py`). `Alert` is therefore a distinct type linked back to its
trigger.

| Property | Type | Meaning |
| --- | --- | --- |
| `status` | enum(5) | One of `ALERT_STATUSES` (§6). |
| `severity` | string | `high` / `medium`. |
| `certainty` | string | `potential` / `confirmed`. |
| `confidence` | number 0–1 | Alert confidence (derived from the contradiction and the evidence). |
| `title`, `summary`, `reason` | string | Human-readable text. |
| `dedupe_key` | string | `old_fact_id \| new_fact_id \| entity_id`. |
| `old_fact_id`, `new_fact_id` | string | The contradicted and contradicting facts. |
| `entity_id`, `entity_label`, `entity_name` | string | The affected decision/project. |
| `attribute` | string | The contradicted attribute. |
| `trigger_assumption_id` | string | The first contributing assumption. |
| `path_nodes`, `path_rels` | list[string] | The cached evidence path. |
| `source_refs` | list[string] | Human-readable source references. |
| `evidence_fact_ids` | list[string] | Facts backing the alert. |
| `certainty_sources` | list[string] | Fact ids that are surviving alternate evidence. |
| `created_at`, `recorded_at`, `updated_at`, `last_seen_at` | ISO | Lifecycle timestamps. |
| `occurrences` | integer | Number of times this alert was seen (replays increment it). |
| `review_status` | enum(5) | One of `REVIEW_STATUSES`. |
| `notified_externally` | bool | Whether an external notification was sent (`false`; no external channel is wired here). |
| `reviewers` | list[string] | Assigned reviewer person ids. |
| `reviewers_assigned_at` | ISO | When reviewers were assigned. |
| `previous_status` | string | Status before the last transition. |
| `reviewed_by`, `review_note` | string | Reviewer attribution. |

## 2. Relationship types

Direction is stated as `Source -REL-> Target`, which is how the edge is stored and
how it is written by the seeder, ingestion and engine.

### 2.1 The 13 specification relationships

| Rel | Direction | Endpoints | Meaning |
| --- | --- | --- | --- |
| `ON_TEAM` | Person → Team | Person, Team | Team membership. |
| `MADE` | Person → Decision | Person, Decision | Who made the decision. |
| `ASSUMES` | Decision → Assumption | Decision, Assumption | A decision rests on an assumption. |
| `SUPPORTED_BY` | Assumption → Fact | Assumption, Fact | The facts that support an assumption. |
| `DEPENDS_ON` | Decision → Decision | Decision, Decision | A decision depends on another decision. |
| `IMPACTS` | Decision → Project | Decision, Project | The project a decision affects. |
| `USES` | Project → System | Project, System | A project uses a system. |
| `STATES` | Message/Document → Fact | Message/Document, Fact | A source record asserts a fact. |
| `CONTRADICTS` | Fact → Fact | Fact, Fact | A new fact contradicts an older one (engine writes `new → old`). |
| `AUTHORED` | Person → Message/Document | Person, Message/Document | Who wrote the artifact. |
| `ABOUT` | Event → entity; Fact → subject | Event/Fact, any entity | What a record is about. |
| `TRIGGERED_BY` | Alert → Fact | Alert, Fact | The fact that triggered the alert. |
| `STALED` | Fact → Decision/Project | Fact, Decision/Project | The fact whose change flagged the entity. |

### 2.2 The 6 documented additions

`ADDED_RELATIONSHIPS` in `schema.py`, with the stated reason for each:

| Rel | Direction | Endpoints | Stated reason |
| --- | --- | --- | --- |
| `MENTIONS` | Message/Document → any entity; also Person → Message/Document | provenance | Provenance/first-class evidence that a source artifact discusses a person, system, project or decision. `AUTHORED` only records who wrote the artifact; `MENTIONS` records what it is evidence *about*, which the contribution-based expert finder needs. (People are also attached to documents they resolved or attended, with `role=resolver` / `role=participant`.) |
| `RESOLVED` | Person → Document(ticket) | contribution | Records who actually fixed a ticket. Distinguishes hands-on troubleshooting from merely being copied in. |
| `OWNS` | Person → System/Project | ownership | The *official* ownership claim from the org records. Kept deliberately separate from contribution evidence so the shadow-organisational chart can show where official ownership and actual contribution diverge (spec S10). |
| `REVIEWS` | Person → Alert | review | Assigned reviewer, with a reason and a rank so the API can present the review queue and its history. |
| `AFFECTS` | Alert → Decision/Project | alert | Potentially affected entity. Carries `certainty` (`potential`/`confirmed`) so an alert never silently upgrades a suspicion into a verdict (spec S7/S11). |
| `EVIDENCE_FOR` | Alert → Fact | provenance | The contradicting (new) fact and the contradicted (old) fact that justify the alert, so explanations are traceable to records. |

`PROVENANCE_REL_TYPES = {STATES, AUTHORED, MENTIONS, ABOUT, RESOLVED, TRIGGERED_BY, EVIDENCE_FOR}`.

### 2.3 Edge properties

Edges are keyed by the identity triple `(src, rel, dst)`, so upserts are idempotent.
Documented edge properties:

* `at` — ISO instant the relationship was asserted (on almost every seeded edge).
* `recorded_at` — transaction time on dependency edges (`ASSUMES`, `SUPPORTED_BY`,
  `DEPENDS_ON`) so `dependencies_at()` can reconstruct history.
* `role` — on `ON_TEAM` (the person's role) and `USES` (the system's role in the
  project).
* `ownership_type` (`official`), `target_label` — on `OWNS`.
* `note`, `reason` — on `SUPPORTED_BY` / `DEPENDS_ON` / `STALED`.
* `certainty`, `reason`, `confidence` — on `AFFECTS`.
* `status` (`VERIFIED`/`UNVERIFIED`), `kind`, `confidence`, `rule`, `rationale`,
  `review_status`, `detected_by`, `verified` — on `CONTRADICTS`.
* `rank`, `reason`, `score` — on `REVIEWS`.
* `reason`, `certainty`, `depth`, `alert_id` — on `STALED`.
* `status` — on `RESOLVED`.

## 3. Stable identifiers and de-duplication

All id generators live in `tripwire/core/ids.py` and are pure functions (the same
inputs always produce the same id). `slug()` lowercases, ASCII-folds and
hyphen-separates; `short_hash()` is a truncated SHA-1 over its parts joined by an
ASCII unit separator.

### 3.1 Id formats (with real examples)

| Generator | Format | Real example |
| --- | --- | --- |
| `person_id(name)` | `person:<slug>` | `person:priya-raman`, `person:jonas-berg` |
| `team_id(name)` | `team:<slug>` | `team:platform-engineering` |
| `system_id(name)` | `system:<slug>` | `system:frankfurt-hosting-partner` |
| `project_id(name)` | `project:<slug>` | `project:eu-launch` |
| `decision_id(key)` | `decision:<slug>` | `decision:eu-launch`, `decision:legal-signoff-eu` |
| `assumption_id(key)` | `assumption:<slug>` | `assumption:data-residency-eu` |
| `message_id(source, external_id)` | `message:<source>:<external_id>` | `message:slack:nw-slack-001` |
| `document_id(source, external_id)` | `document:<source>:<external_id>` | `document:ticket:nwl-2276`, `document:prd:nwl-prd-001`, `document:meeting-note:nwl-mn-001` |
| `event_id(kind, *disc)` | `event:<kind>:<hash>` | `event:seed:<12-hex>` |
| `alert_id(dedupe_key)` | `alert:<hash>` | `alert:befe6bd9fe49` |
| `fact_id(subject, predicate, object, valid_from, discriminator=)` | `fact:<hash>` | computed: `fact:5f3054083121`; curated: `fact:frankfurt-partner-compliance-valid` |

`fact_id` hashes `statement_key(subject, predicate, object)` (the three slugs joined
with `\x1f`), then `valid_from`, then `discriminator`, joined by the same separator
and truncated to 12 hex chars.

### 3.2 How facts get distinct ids for contradicting claims while identical claims collapse

* **Identical claims collapse.** The id is a content hash over
  `(statement_key, valid_from, discriminator)`. Re-stating the *same* claim resolves
  to the same node and is a no-op merge; `assert_fact()` reports it as
  `FACT_RESTATED` with `created=False`.
* **Contradicting claims diverge.** A claim with a *different value* (different
  object in the triple) or a corrected validity window produces a **different**
  hash, so both facts are preserved side by side rather than one overwriting the
  other. In the headline scenario, the valid certification keeps its curated id
  `fact:frankfurt-partner-compliance-valid` and the revocation gets
  `fact:5f3054083121` — distinct ids, distinct intervals, one `CONTRADICTS` edge
  between them.
* **Time-scoped updates are distinct.** Because `valid_from` participates in the
  hash, the same attribute asserted for a different real-world period (a genuine
  succession) is a new fact, not an overwrite.

### 3.3 Alert and event de-duplication

* Alert: `dedupe_key = old_fact_id | new_fact_id | entity_id`, and
  `alert_id = alert:<sha1(dedupe_key)[:12]>`. Replaying an event resolves to the
  same alert id (`create_alert` then just bumps `occurrences` and `last_seen_at`).
* Event: the id excludes the wall-clock `moment`, so replaying an identical logical
  event re-merges into the same `Event` node rather than appending a duplicate
  history entry.

## 4. Bi-temporal semantics

Two independent clocks are tracked on every `Fact`:

* **Validity (`valid_from` / `valid_to`)** — when the claim was true **in the real
  world**. Answers *"was this true in March?"* (`history.valid_at`).
* **Transaction / belief (`recorded_at` / `recorded_to`)** — when **Tripwire
  believed** it. Answers *"what did we know on the 4th?"* (`history.belief_at`).

Conflating the two is the classic bi-temporal bug: a claim can become true long
before Tripwire hears about it (late-arriving information), and Tripwire can learn a
backdated correction that changes the real-world interval without changing when the
knowledge arrived.

**Half-open intervals.** Both are half-open. A node is believed at instant `t` when
`recorded_at <= t` and (`recorded_to` is null or `recorded_to > t`); it is valid at
`t` when `valid_from <= t` and (`valid_to` is null or `valid_to > t`). `_believed_at`
and `_valid_at` in `history.py` implement exactly this.

### 4.1 Update policy for a contradiction

`GraphEngine.record_contradiction()` sets an edge property `verified` and applies one
of two mutually exclusive policies. The original fact is **always preserved**.

**Verified contradiction** (`new_fact.verified` is true *and* the kind is
`contradiction`):

```
status        = "INVALIDATED"
valid_to      = new_fact.valid_from      # closes the real-world interval
recorded_to   = <moment>                 # closes the belief interval
invalidated_by = new_fact_id
review_status = "AUTO_ACCEPTED"
```

The `CONTRADICTS` edge is written with `status="VERIFIED"`.

**Unverified contradiction** (`unverified` kind, or the new source is untrusted):

```
status        = "CONTESTED"              # original fact, both intervals left OPEN
contested_by  = new_fact_id
contested_at  = <moment>
review_status = "NEEDS_REVIEW"
# and the NEW fact is marked:
status        = "UNCERTAIN"
review_status = "NEEDS_REVIEW"
```

The `CONTRADICTS` edge is written with `status="UNVERIFIED"`. Tripwire still
provisionally believes the original claim, so its history must **not** be rewritten —
hence `valid_to` and `recorded_to` stay open.

### 4.2 Worked example timeline (verified contradiction, headline scenario)

Starting state (seeded):

| Fact | `valid_from` | `valid_to` | `recorded_at` | `recorded_to` | `status` |
| --- | --- | --- | --- | --- | --- |
| `fact:frankfurt-partner-compliance-valid` | `2025-04-01T00:00:00Z` | null | `2026-01-12T10:05:00Z` | null | `ACTIVE` |

Trigger `frankfurt_compliance_revoked`:
* new fact id `fact:5f3054083121`, `valid_from = 2026-02-20T08:15:00Z`,
  `recorded_at = 2026-02-20T08:15:00Z`, verified.
* `find_contradictions` → `contradiction` (confidence `0.936`, rule
  `compliance_revocation`).
* `record_contradiction` writes `fact:5f3054083121 -CONTRADICTS-> fact:frankfurt-partner-compliance-valid`.

After:

| Fact | `valid_from` | `valid_to` | `recorded_at` | `recorded_to` | `status` | `invalidated_by` |
| --- | --- | --- | --- | --- | --- | --- |
| `fact:frankfurt-partner-compliance-valid` | `2025-04-01T00:00:00Z` | `2026-02-20T08:15:00Z` | `2026-01-12T10:05:00Z` | `2026-02-20T08:15:00Z` | `INVALIDATED` | `fact:5f3054083121` |
| `fact:5f3054083121` | `2026-02-20T08:15:00Z` | null | `2026-02-20T08:15:00Z` | null | `ACTIVE` | — |

Consequences a reader can check with the API:

* `GET /api/history/valid?at=2026-02-01T00:00:00Z` still lists the certification as
  true in the real world (it was true then), even though Tripwire no longer believes
  it now.
* `GET /api/history/belief?at=2026-02-01T00:00:00Z` lists it (Tripwire believed it
  then) but `…?at=2026-02-21T00:00:00Z` does not (the belief interval is closed).
* `GET /api/history/facts/fact:frankfurt-partner-compliance-valid` renders a
  timeline whose `RECORDED`, `VALID_FROM` and `CONTRADICTS` entries explain the two
  clocks, and reports `still_believed = false`.

For the unverified variant (`frankfurt_compliance_revoked_unverified`), the original
fact's `valid_to` and `recorded_to` remain null and its status becomes `CONTESTED`;
the new fact (`fact:9824a03eade0`) becomes `UNCERTAIN`. Because the source fact is
`CONTESTED`, all propagation certainties are forced to `potential`.

## 5. The corrected-Cypher analysis

The proposal included an illustrative propagation query, reproduced verbatim in
`tripwire/core/falkor_store.py` as `PROPOSED_PROPAGATION_CYPHER` (documentation and
comparison only; **it is not executed as-is**):

```cypher
MATCH p = (f:Fact {id:$oldFactId})<-[:SUPPORTED_BY]-(:Assumption)
        <-[:ASSUMES]-(d:Decision)<-[:DEPENDS_ON*0..3]-(d2:Decision)
SET d2.status='STALE', d2.stale_reason=$oldFactId
RETURN p
```

Validating this against the real schema (`schema.NODE_TYPES` / `REL_TYPES`) and the
engine's restraint requirements surfaced five defects. Each is listed with its fix.

1. **Unconditional `SET d2.status='STALE'`.** The query hard-writes `STALE` to every
   matched decision. That violates spec S7/S8: a single changed fact must not
   invalidate a decision, and one might still be supported by *other* facts. **Fix:**
   the `SET` is removed entirely. The query becomes read-only candidate discovery;
   the engine writes `POTENTIALLY_STALE` only, after evaluating alternate supporting
   evidence. (`STALE` is written solely by `alerts.promote_decision()` after an
   explicit confirmed review.)

2. **Multi-assumption cartesian product.** `DEPENDS_ON*0..3` is applied to a pattern
   that already matches *every* assumption of *every* seed decision. With more than
   one assumption, the variable-length expansion multiplies out into a cartesian
   product of paths (each dependent decision repeated once per upstream assumption).
   **Fix:** expansion is executed **per seed decision**. `CORRECTED_PROPAGATION_CYPHER`
   resolves the seed decisions and their assumptions; `NATIVE_DEPENDENTS_CYPHER` is
   then run once per seed decision, so each affected entity carries one complete,
   explainable chain back to the changed fact rather than a product of chains.

3. **Seed decision dropped when it has no dependents.** The dependent hop
   `<-[:DEPENDS_ON*0..3]-` is required in the original pattern, so a decision whose
   assumption was hit — but which nothing depends on — vanishes from the result.
   **Fix:** the dependent hop is not made the required continuation. A decision with
   no dependents still surfaces as **directly affected**; the seed decision is always
   included (in the Python walk, the traversal root is always in `reach.order`, and
   `_chain_for` returns an empty chain for a root, so the seed appears with the
   `Fact <-SUPPORTED_BY- Assumption <-ASSUMES- Decision` head path).

4. **Duplicate paths from variable-length patterns.** A variable-length pattern
   returns **one row per path**, so the same decision appears many times, which would
   produce duplicate alerts. **Fix:** `DISTINCT` is applied in the native query, and
   the Python engine de-duplicates by node using a shortest-path tree
   (`GraphIndex.traverse` enters each node once via a visited map; `plan_propagation`
   keeps one `AffectedEntity` per id). A note "`Duplicate dependency paths were
   collapsed to one entry per entity.`" is emitted when this happens.

5. **`IMPACTS`/`Project` coverage ignored.** `<-[:DEPENDS_ON*0..3]-` only follows the
   decision-to-decision dependents; it ignores `IMPACTS` and `Project` entities, so
   projects a decision affects never surface. **Fix:** `DEPENDENCY_RELATIONSHIPS =
   (DEPENDS_ON, IMPACTS)` and `AFFECTED_LABELS = (Decision, Project)`. The walk
   direction is `BOTH`, because the two relationships run in opposite directions: a
   dependent decision points *at* the decision it depends on
   (`dependent -DEPENDS_ON-> seed`, walked inward), while a decision points *at* the
   project it affects (`seed -IMPACTS-> project`, walked outward). A one-directional
   walk silently drops either the dependent decisions or the projects.

The corrected forms actually used:

```cypher
// CORRECTED_PROPAGATION_CYPHER — read-only candidate discovery, seed decisions + assumptions
MATCH (f:Fact {id: $fact_id})<-[:SUPPORTED_BY]-(a:Assumption)<-[:ASSUMES]-(d:Decision)
RETURN DISTINCT a.id AS assumption_id, d.id AS decision_id
ORDER BY decision_id, assumption_id
```

```cypher
// NATIVE_DEPENDENTS_CYPHER — native expansion, executed once per seed decision.
// {depth} is validated as a small integer (0..8) before substitution because
// Cypher bounds must be literals; the value is never caller-controlled raw text.
MATCH (seed:Decision {id: $decision_id})<-[:DEPENDS_ON*0..{depth}]-(dependent:Decision)
RETURN DISTINCT dependent.id AS decision_id,
       length(shortestPath((seed)<-[:DEPENDS_ON*0..{depth}]-(dependent))) AS hops
```

The native traversal is exposed as
`FalkorGraphStore.native_candidate_decisions(fact_id, depth=3)` and is used only as an
**optimisation**: the Python implementation in `tripwire/core/staleness.py` remains
authoritative. (See `docs/ARCHITECTURE.md` §10: the module docstrings reference a
parity test file that is not present in this checkout, so treat native-vs-Python
equivalence as an unverified design intention.)

## 6. Status vocabularies and the alert transition table

Copied from `tripwire/core/schema.py`:

```text
FACT_STATUSES      = ACTIVE, CONTESTED, INVALIDATED, UNCERTAIN
DECISION_STATUSES  = ACTIVE, POTENTIALLY_STALE, STALE, SUPERSEDED, ARCHIVED
REVIEW_STATUSES    = UNREVIEWED, NEEDS_REVIEW, REVIEWED_ACCEPTED, REVIEWED_REJECTED, AUTO_ACCEPTED
ALERT_STATUSES     = NEW, NEEDS_REVIEW, CONFIRMED_STALE, DISMISSED, RESOLVED
DOC_TYPES          = ticket, prd, meeting_note, design_doc
EVENT_TYPES        = SEED, RESET, INGESTION, FACT_ASSERTED, FACT_RESTATED, FACT_CHANGE,
                     CONTRADICTION_DETECTED, STALENESS_PROPAGATED, STATUS_CHANGE,
                     ALERT_STATUS_CHANGE, REVIEW_DECISION, ERROR
```

Only `Fact`, `Decision` and `Alert` have engine-enforced status vocabularies
(`_status_vocabulary()`). Other node types carry provider- or domain-specific values
(a ticket's `done`, a project's plan state) preserved verbatim.

`ALERT_STATUS_TRANSITIONS` (a same-status update is always an accepted idempotent
no-op; any other transition not listed raises `TransitionError`):

| Current | Allowed next |
| --- | --- |
| `NEW` | `NEEDS_REVIEW`, `CONFIRMED_STALE`, `DISMISSED`, `RESOLVED` |
| `NEEDS_REVIEW` | `CONFIRMED_STALE`, `DISMISSED`, `RESOLVED` |
| `CONFIRMED_STALE` | `RESOLVED`, `DISMISSED`, `NEEDS_REVIEW` |
| `DISMISSED` | `NEEDS_REVIEW`, `RESOLVED` |
| `RESOLVED` | `NEEDS_REVIEW` |

Cascades on transition (`alerts.transition_alert`):

* `CONFIRMED_STALE` → `promote_decision()` marks the affected decision `STALE`
  (the **only** code path that writes `STALE`), writes the `STALED` edge, and records
  a `STATUS_CHANGE` event.
* `DISMISSED` → `_revert_decision()` returns a flagged decision to `ACTIVE` (only if
  it was `POTENTIALLY_STALE`/`STALE`).

## 7. Index strategy and the Cypher-injection defence

**Indexing.** `FalkorGraphStore.ensure_indices()` creates a **range index on `id`
for every label** in `NODE_TYPES` (idempotent: FalkorDB raises if an index already
exists, and those failures are swallowed — the goal is "index present"). This is
what makes the `MATCH (n {id: $id})` lookups used throughout the read and merge paths
fast.

**Injection defence** (`falkor_store.py` module docstring). Labels and relationship
types cannot be parameterised in Cypher, so they are *never* interpolated from caller
input:

* every label is checked against `schema.NODE_TYPES` before it is placed in Cypher
  (`_validate_label`);
* every relationship type is checked against `schema.REL_TYPES` (`_validate_rel`);
* property *names* must match `^[A-Za-z_][A-Za-z0-9_]*$` (`_validate_prop_name`);
* property *values* are always passed through the driver's parameter map
  (`{"p0": value, ...}`), never string-interpolated;
* the only literal that is ever substituted into a query is the variable-length
  bound `{depth}`, and it is validated as an `int` in `[0, 8]` first (`StoreError`
  otherwise) because Cypher bounds must be literals;
* **no endpoint accepts raw Cypher.** `run_explain()` exists for internal
  diagnostics only and is not reachable from the HTTP API or MCP tools (spec S16).

`normalize_where` / `_where_clause` implement the same discipline for the
`__type__` → label translation and for list-valued predicates (`IN $param`).

## 8. Provenance model

**How a fact points at its sources.** Every fact asserted with a source gets a
`STATES` edge from the source artifact to the fact
(`Message|Document -STATES-> Fact`), plus a `source_id` / `source_ref` property. The
source artifact itself is linked to its author with `AUTHORED`, and to the entities
it discusses with `MENTIONS`. So a fact's provenance is a short, real chain:
`Fact <-STATES- Document <-AUTHORED- Person`. Example: the certification fact is
stated by `document:prd:nwl-prd-001`, `document:prd:nwl-prd-003`,
`document:meeting-note:nwl-mn-001`, `message:slack:nw-slack-004` and
`message:slack:nw-slack-009`.

**How an explanation walks back to real records.**
`explain.provenance_chain(index, fact_id)` returns the claim plus
`source_artifacts()` — each stating artifact with its label, `source_ref`,
timestamp, author and an excerpt. `explain_decision()` walks
`Decision -ASSUMES-> Assumption -SUPPORTED_BY-> Fact`, and for each fact resolves its
`STATES` sources; `explain_alert()` starts from the alert's `old_fact_id` /
`new_fact_id` (the `EVIDENCE_FOR` facts) and re-reconstructs the
`new_fact → entity` path through `explain_path()` rather than trusting the alert's
cached path. `history.source_of_change()` walks `STATES` for the fact and for any
fact it contradicts.

**The honesty rule.** An explanation must never claim evidence that the graph does
not contain. Concretely:

* `explain_path()` returns `found: false` with a `reason` and the missing endpoint
  when no path connects two entities — it does not synthesise one.
* `explain_decision()` / `explain_alert()` / `explain_fact_change()` return
  `found: false` with a `missing` list when a node is absent.
* `GraphIndex.provenance_for()` only reports artifacts it actually reached through
  provenance relationships, each with the concrete path that links it.
* `explain_alert()` re-derives the path through the graph ("a stale cache cannot
  produce an explanation the graph no longer supports") and reports
  `reconstruction_found` honestly.
* `staleness.plan_propagation()` reports no affected entities with a note rather
  than forcing a chain when a fact has no assumptions or no decisions.
