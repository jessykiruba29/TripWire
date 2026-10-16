"""Core graph intelligence: schema, storage and reasoning.

Public surface is re-exported here so callers (HTTP API, MCP server, tests,
scripts) import from one place.
"""

from __future__ import annotations

from .contradictions import (
    ContradictionCandidate,
    ContradictionResult,
    FactClaim,
    claim_from_node,
    find_contradictions,
)
from .errors import (
    ConfigurationError,
    IngestionError,
    LLMResponseError,
    LLMUnavailableError,
    NotFoundError,
    SchemaError,
    StoreError,
    StoreUnavailableError,
    TransitionError,
    TripwireError,
    ValidationError,
)
from .explain import (
    decision_dependencies,
    explain_alert,
    explain_decision,
    explain_fact_change,
    explain_path,
    provenance_chain,
)
from .experts import ExpertRank, ExpertReport, find_experts
from .history import (
    belief_at,
    changes_since,
    dependencies_at,
    fact_timeline,
    history_report,
    source_of_change,
    valid_at,
)
from .ids import alert_id, event_id, fact_id, message_id, person_id, slug
from .index import GraphIndex
from .models import Edge, EvidencePath, Node, PathStep, Subgraph
from .schema import (
    ADDED_RELATIONSHIPS,
    ALERT_STATUS_TRANSITIONS,
    ALERT_STATUSES,
    DECISION_STATUSES,
    DOC_TYPES,
    EVENT_TYPES,
    FACT_STATUSES,
    NODE_TYPES,
    REL_TYPES,
    REVIEW_STATUSES,
)
from .staleness import AffectedEntity, AlternateEvidence, PropagationPlan, plan_propagation
from .store import GraphStore, JsonGraphStore, MemoryGraphStore, create_store
from .timeutil import now_iso, parse_iso, to_iso

__all__ = [
    # schema
    "NODE_TYPES", "REL_TYPES", "ADDED_RELATIONSHIPS", "ALERT_STATUSES",
    "ALERT_STATUS_TRANSITIONS", "DECISION_STATUSES", "FACT_STATUSES",
    "REVIEW_STATUSES", "DOC_TYPES", "EVENT_TYPES",
    # models
    "Node", "Edge", "Subgraph", "PathStep", "EvidencePath",
    # ids / time
    "alert_id", "event_id", "fact_id", "message_id", "person_id", "slug",
    "now_iso", "parse_iso", "to_iso",
    # store
    "GraphStore", "MemoryGraphStore", "JsonGraphStore", "create_store",
    # index
    "GraphIndex",
    # reasoning
    "find_contradictions", "ContradictionCandidate", "ContradictionResult", "FactClaim",
    "claim_from_node", "plan_propagation", "PropagationPlan", "AffectedEntity",
    "AlternateEvidence", "find_experts", "ExpertRank", "ExpertReport",
    "explain_decision", "explain_path", "explain_alert", "explain_fact_change",
    "provenance_chain", "decision_dependencies",
    "belief_at", "valid_at", "dependencies_at", "changes_since", "fact_timeline",
    "source_of_change", "history_report",
    # errors
    "TripwireError", "ConfigurationError", "StoreUnavailableError", "StoreError",
    "NotFoundError", "ValidationError", "SchemaError", "LLMUnavailableError",
    "LLMResponseError", "TransitionError", "IngestionError",
]
