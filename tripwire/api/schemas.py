"""Pydantic v2 request/response models for the Tripwire HTTP API.

The engine returns rich, plain dictionaries.  Rather than duplicate those shapes
(and let them drift) the API declares a *permissive* response model for the
engine-owned endpoints: it validates that the payload is a JSON object and
preserves every field verbatim (``extra="allow"``).  Endpoints whose shape the
API owns - pagination envelopes, error bodies, the scenario catalog - get fully
typed models.

Request (body) models are always explicit and required.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "ErrorEnvelope",
    "EnginePayload",
    "HealthResponse",
    "GraphResponse",
    "TriggerEventRequest",
    "TriggerEventResponse",
    "NewFact",
    "SourcePayload",
    "SeedRequest",
    "ResetRequest",
    "ExpertQueryRequest",
    "ExpertReportResponse",
    "ContradictionCandidate",
    "ContradictionsRequest",
    "ContradictionsResponse",
    "StalenessRequest",
    "PropagationResponse",
    "AlertListResponse",
    "AlertDetail",
    "AlertReviewRequest",
    "AlertReviewResponse",
    "AlertHistoryResponse",
    "DecisionStatusRequest",
    "DecisionStatusResponse",
    "DecisionExplanationResponse",
    "FactExplanationResponse",
    "PathResponse",
    "SearchResponse",
    "HistoryBeliefResponse",
    "HistoryValidResponse",
    "HistoryChangesResponse",
    "FactTimelineResponse",
    "SourceOfChangeResponse",
    "DependenciesResponse",
    "ScenarioInfo",
    "ScenariosResponse",
    "AdapterInfo",
    "AdaptersResponse",
    "IngestRequest",
    "SourceListResponse",
    "SourceDetailResponse",
    "DemoStateResponse",
    "SeedResponse",
]


# --------------------------------------------------------------------------- #
# Shared bases
# --------------------------------------------------------------------------- #
class ErrorEnvelope(BaseModel):
    """Consistent error body returned by every failing endpoint."""

    error: str = Field(description="Stable, machine-readable error code.")
    message: str = Field(description="Human-readable explanation (never a stack trace).")
    details: dict[str, Any] = Field(
        default_factory=dict, description="Structured, non-secret context for the error."
    )


class EnginePayload(BaseModel):
    """Permissive response model for engine-owned payloads.

    ``extra="allow"`` keeps the engine's fields intact while still giving every
    route a declared response model (and therefore an OpenAPI schema).
    """

    model_config = ConfigDict(extra="allow")


class StrictRequest(BaseModel):
    """Base for request bodies: reject unknown fields is *not* enforced, to stay tolerant."""

    model_config = ConfigDict(extra="allow")


# --------------------------------------------------------------------------- #
# Health / demo
# --------------------------------------------------------------------------- #
class HealthResponse(EnginePayload):
    """Composite health summary."""

    status: Optional[str] = Field(default=None, description="'ok' or 'degraded'.")
    store: Optional[dict[str, Any]] = None
    configured_backend: Optional[str] = None
    active_backend: Optional[str] = None
    seeded: Optional[bool] = None
    llm_enabled: Optional[bool] = None
    checked_at: Optional[str] = None


class DemoStateResponse(EnginePayload):
    """Full demonstration status."""

    seeded: Optional[bool] = None


class SeedRequest(StrictRequest):
    """Request body for ``POST /api/demo/seed``."""

    force: bool = Field(default=False, description="Re-seed even when already seeded.")


class SeedResponse(EnginePayload):
    """Result of a seed/reset."""

    seeded: Optional[bool] = None
    reset: Optional[bool] = None


class ResetRequest(StrictRequest):
    """Optional request body for ``POST /api/demo/reset`` (currently ignored)."""

    force: bool = Field(default=True, description="Reset is always a forced re-seed.")


# --------------------------------------------------------------------------- #
# Graph
# --------------------------------------------------------------------------- #
class GraphResponse(EnginePayload):
    """Serialisable graph payload for the frontend."""

    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Trigger event
# --------------------------------------------------------------------------- #
class NewFact(StrictRequest):
    """An explicitly supplied fact for the trigger-event flow."""

    subject: str
    attribute: str
    value: Any
    statement: Optional[str] = None
    subject_label: Optional[str] = None
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    recorded_at: Optional[str] = None
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    verified: Optional[bool] = None
    status: Optional[str] = None
    extra: Optional[dict[str, Any]] = None


class SourcePayload(StrictRequest):
    """The source artifact that carries a newly asserted fact."""

    kind: Optional[str] = Field(default=None, description="e.g. 'slack', 'ticket', 'doc'.")
    external_id: Optional[str] = None
    name: Optional[str] = None
    author: Optional[str] = None
    timestamp: Optional[str] = None
    source_ref: Optional[str] = None
    text: Optional[str] = None
    url: Optional[str] = None
    channel: Optional[str] = None
    doc_type: Optional[str] = None
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)


class TriggerEventRequest(StrictRequest):
    """Body for ``POST /api/demo/trigger-event``.

    Supply either ``scenario`` (a deterministic demo event) **or** ``new_fact``.
    """

    scenario: Optional[str] = None
    new_fact: Optional[NewFact] = None
    fact: Optional[NewFact] = None
    source: Optional[SourcePayload] = None
    actor_id: Optional[str] = None
    recorded_at: Optional[str] = None
    use_llm: Optional[bool] = None


class TriggerEventResponse(EnginePayload):
    """Full contradiction -> propagation -> alert outcome; shape owned by the engine."""


# --------------------------------------------------------------------------- #
# Experts
# --------------------------------------------------------------------------- #
class ExpertQueryRequest(StrictRequest):
    """Body for ``POST /api/experts/query``."""

    query: str = Field(min_length=1)
    limit: int = Field(default=5, ge=1, le=50)


class ExpertReportResponse(EnginePayload):
    """Ranked expert report; shape owned by the engine."""

    query: Optional[str] = None
    experts: Optional[list[dict[str, Any]]] = None


# --------------------------------------------------------------------------- #
# Contradictions
# --------------------------------------------------------------------------- #
class ContradictionCandidate(StrictRequest):
    """A hypothetical fact compared against the graph without writing."""

    subject: str
    attribute: str
    value: Any
    statement: Optional[str] = None
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    recorded_at: Optional[str] = None
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    verified: Optional[bool] = None


class ContradictionsRequest(StrictRequest):
    """Body for ``POST /api/contradictions/find``.

    Provide exactly one of ``fact_id`` (an existing fact) or ``candidate`` (a
    hypothetical claim).
    """

    fact_id: Optional[str] = None
    candidate: Optional[ContradictionCandidate] = None
    use_llm: bool = True


class ContradictionsResponse(EnginePayload):
    """Classified contradiction report; shape owned by the engine."""


# --------------------------------------------------------------------------- #
# Staleness
# --------------------------------------------------------------------------- #
class StalenessRequest(StrictRequest):
    """Body for ``POST /api/staleness/propagate``."""

    fact_id: str = Field(min_length=1)
    max_depth: Optional[int] = Field(default=None, ge=0, le=10)
    dry_run: bool = Field(
        default=True,
        description="When true (default) the plan is returned without writing anything.",
    )


class PropagationResponse(EnginePayload):
    """A propagation plan, optionally with the summary of what was applied."""

    source_fact_id: Optional[str] = None
    dry_run: Optional[bool] = None
    applied: Optional[bool] = None


# --------------------------------------------------------------------------- #
# Alerts
# --------------------------------------------------------------------------- #
class AlertListResponse(EnginePayload):
    """Paginated alert feed with a status histogram."""

    total: int = 0
    count: int = 0
    limit: int = 50
    offset: int = 0
    status_counts: dict[str, int] = Field(default_factory=dict)
    alerts: list[dict[str, Any]] = Field(default_factory=list)


class AlertDetail(EnginePayload):
    """A single alert enriched with its affected entities."""


class AlertHistoryResponse(EnginePayload):
    """Append-only alert history."""

    alert_id: Optional[str] = None
    status: Optional[str] = None
    history: list[dict[str, Any]] = Field(default_factory=list)


class AlertReviewRequest(StrictRequest):
    """Body for ``POST /api/alerts/{alert_id}/review``."""

    status: str = Field(description="Target alert status.")
    actor_id: Optional[str] = None
    note: str = ""


class AlertReviewResponse(EnginePayload):
    """Result of an alert status transition."""

    alert_id: Optional[str] = None
    status: Optional[str] = None
    previous_status: Optional[str] = None


# --------------------------------------------------------------------------- #
# Decisions
# --------------------------------------------------------------------------- #
class DecisionStatusRequest(StrictRequest):
    """Body for ``POST /api/decisions/{decision_id}/status``."""

    status: str
    actor_id: Optional[str] = None
    note: str = ""
    confirm: bool = Field(
        default=False,
        description="Required when moving a decision to STALE; never automatic.",
    )


class DecisionStatusResponse(EnginePayload):
    """Result of a decision status change."""

    decision_id: Optional[str] = None
    status: Optional[str] = None
    previous_status: Optional[str] = None


class DecisionExplanationResponse(EnginePayload):
    """Structured decision explanation; shape owned by the engine."""

    found: Optional[bool] = None
    decision_id: Optional[str] = None


class FactExplanationResponse(EnginePayload):
    """Structured fact explanation; shape owned by the engine."""

    found: Optional[bool] = None
    fact_id: Optional[str] = None


class DependenciesResponse(EnginePayload):
    """Decision dependencies at a transaction time."""

    decision_id: Optional[str] = None
    found: Optional[bool] = None


class PathResponse(EnginePayload):
    """Relationship paths between two entities."""

    found: Optional[bool] = None


# --------------------------------------------------------------------------- #
# Search
# --------------------------------------------------------------------------- #
class SearchResponse(EnginePayload):
    """Substring search over node names and statements."""

    query: Optional[str] = None
    total: int = 0
    results: list[dict[str, Any]] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# History
# --------------------------------------------------------------------------- #
class HistoryBeliefResponse(EnginePayload):
    """What Tripwire believed at a transaction time."""

    at: Optional[str] = None
    label: Optional[Any] = None
    total: int = 0
    facts: list[dict[str, Any]] = Field(default_factory=list)


class HistoryValidResponse(EnginePayload):
    """Which facts were true in the real world at an instant."""

    at: Optional[str] = None
    total: int = 0
    facts: list[dict[str, Any]] = Field(default_factory=list)


class HistoryChangesResponse(EnginePayload):
    """What the system learned after a point in time."""

    since: Optional[str] = None


class FactTimelineResponse(EnginePayload):
    """Full timeline for a fact."""

    fact_id: Optional[str] = None
    found: Optional[bool] = None
    entries: list[dict[str, Any]] = Field(default_factory=list)


class SourceOfChangeResponse(EnginePayload):
    """Which source changed the understanding of a fact."""

    fact_id: Optional[str] = None
    found: Optional[bool] = None
    sources: list[dict[str, Any]] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Dataset / ingest
# --------------------------------------------------------------------------- #
class ScenarioInfo(BaseModel):
    """One available demo scenario."""

    name: str
    description: Optional[str] = None


class ScenariosResponse(BaseModel):
    """Available demo scenarios."""

    total: int = 0
    scenarios: list[ScenarioInfo] = Field(default_factory=list)


class AdapterInfo(EnginePayload):
    """One documented ingestion source adapter."""


class AdaptersResponse(EnginePayload):
    """Documented ingestion adapters and their input shapes."""

    available: bool = True
    adapters: list[dict[str, Any]] = Field(default_factory=list)
    message: Optional[str] = None


class IngestRequest(StrictRequest):
    """Body for ``POST /api/ingest`` - one source record.

    Forwarded verbatim to ``engine.ingest_source`` when the engine provides it.
    """

    source: Optional[str] = Field(default=None, description="Adapter/source system name.")
    kind: Optional[str] = None
    record: Optional[dict[str, Any]] = None


# --------------------------------------------------------------------------- #
# Sources
# --------------------------------------------------------------------------- #
class SourceListResponse(EnginePayload):
    """Paginated list of source artifacts (Message/Document nodes)."""

    total: int = 0
    count: int = 0
    limit: int = 50
    offset: int = 0
    sources: list[dict[str, Any]] = Field(default_factory=list)


class SourceDetailResponse(EnginePayload):
    """One source artifact with the facts it states."""

    source: Optional[dict[str, Any]] = None
    states: list[dict[str, Any]] = Field(default_factory=list)
    states_count: int = 0
