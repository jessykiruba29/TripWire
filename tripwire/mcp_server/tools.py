"""The Tripwire MCP tool surface, bound to one shared :class:`GraphEngine`.

Every tool is a thin adapter: it validates and bounds its arguments, calls the
*same* :class:`~tripwire.core.engine.GraphEngine` the HTTP API uses, and returns a
JSON-serialisable dictionary.  No graph reasoning lives here - if a tool needed a
capability the engine lacks, that would be a bug to report, not to reimplement.

Why a class?
------------
The tools must be *plain importable callables* so tests can invoke them directly
(fast, no transport) while the server registers the very same objects on its
``MCPServer``.  :class:`TripwireTools` holds the engine once and exposes each tool
as a bound method, so there is exactly one implementation per tool and a second
implementation can never drift into existence.

Output contract
---------------
* Success: a stable, keyed, JSON-serialisable ``dict``.
* Failure: ``{"error": {"code": ..., "message": ..., "details": {...}}}`` where
  ``code`` comes from the :class:`~tripwire.core.errors.TripwireError` subclass
  (``not_found``, ``validation_error``, ``invalid_transition``, ...).  MCP tools
  never leak a Python traceback to the client.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Callable, Optional, TYPE_CHECKING

from pydantic import Field

from ..core.errors import TripwireError, ValidationError
from ..core.schema import ALERT_STATUSES, REL_TYPES

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids a heavy import cycle
    from ..core.engine import GraphEngine

logger = logging.getLogger("tripwire.mcp.tools")

__all__ = [
    "TripwireTools",
    "CORE_TOOLS",
    "TOOL_NAMES",
    "TOOL_DESCRIPTIONS",
    "HISTORY_MODES",
    "bound_tools",
]

# --------------------------------------------------------------------------- #
# Bounds (documented and enforced on the tool itself, not only in the schema)
# --------------------------------------------------------------------------- #
MAX_DEPTH_MIN, MAX_DEPTH_MAX = 0, 8
LIMIT_MIN, LIMIT_MAX = 1, 50
HISTORY_LIMIT_MAX = 200

#: The four tools the specification calls out as core.
CORE_TOOLS: tuple[str, ...] = (
    "find_contradictions",
    "propagate_staleness",
    "find_experts",
    "explain_path",
)

#: Every tool this server exposes.  Order is stable so ``list_tools`` output is
#: deterministic for clients and for the documentation table.
TOOL_NAMES: tuple[str, ...] = (
    "find_contradictions",
    "propagate_staleness",
    "find_experts",
    "explain_path",
    "explain_decision",
    "explain_alert",
    "explain_fact",
    "list_alerts",
    "review_alert",
    "graph_summary",
    "search_knowledge",
    "history_query",
    "trigger_demo_event",
)

#: History sub-queries reachable through :meth:`TripwireTools.history_query`.
HISTORY_MODES: tuple[str, ...] = (
    "belief",
    "valid",
    "changes",
    "fact",
    "source_of_change",
    "dependencies",
)

TOOL_DESCRIPTIONS: dict[str, str] = {
    "find_contradictions": (
        "Compare a claim against the stored graph and report conflicts. Use it to check "
        "an existing fact id (fact_id) or a hypothetical claim (candidate with subject/"
        "attribute/value) BEFORE recording new information. Returns whether a conflict was "
        "detected, the contradiction kind/confidence/rationale/review status, every "
        "candidate considered, and a rendered evidence path per conflict. Read-only: a "
        "hypothetical candidate is never written to the graph."
    ),
    "propagate_staleness": (
        "Plan what a changed or contradicted fact invalidates. Walks "
        "Fact<-SUPPORTED_BY-Assumption<-ASSUMES-Decision then DEPENDS_ON/IMPACTS to find "
        "affected decisions and projects, with certainty (potential/confirmed), the evidence "
        "path for each, any surviving independent evidence, and whether a status change was "
        "written. Defaults to dry_run=true, which plans without writing anything; set "
        "dry_run=false to apply POTENTIALLY_STALE flags and raise alerts (a decision is never "
        "auto-marked STALE)."
    ),
    "find_experts": (
        "Rank the people who actually know a system or project, based on recorded "
        "contribution evidence (authored/resolved/mentioned artefacts) rather than job "
        "titles. Use it to find a reviewer or to see where official ownership diverges from "
        "real contribution (the shadow org chart). Returns ranked people with reasons, "
        "contribution counts and evidence refs, the official owners, and a shadow-org signal."
    ),
    "explain_path": (
        "Show the relationship path(s) connecting two graph entities (facts, assumptions, "
        "decisions, projects, people). Use it to justify a link you are about to rely on. "
        "Reports found=false with a reason when no path exists - it never invents one."
    ),
    "explain_decision": (
        "Explain a decision end to end: what it assumes, which facts support it, who made "
        "it, which project it affects, its current status and any alerts against it. Use it "
        "when someone asks 'why did we decide this and does it still hold?'."
    ),
    "explain_alert": (
        "Explain one alert end to end: the contradicting and contradicted facts, their "
        "provenance, the evidence path to the affected entity, certainty and severity, "
        "assigned reviewers and the status history. Use it to review an alert honestly."
    ),
    "explain_fact": (
        "Explain a fact: which sources state it, what it supports, what contradicts (or is "
        "contradicted by) it, and its bitemporal validity window. Use it to trace a claim "
        "back to the records that justify it."
    ),
    "list_alerts": (
        "List reviewable alerts with a status histogram. Filter by status (NEW, "
        "NEEDS_REVIEW, CONFIRMED_STALE, DISMISSED, RESOLVED), severity or affected entity. "
        "Use it to build a review queue; pair it with explain_alert for the detail."
    ),
    "review_alert": (
        "Move an alert through the documented status machine (NEW -> NEEDS_REVIEW -> "
        "CONFIRMED_STALE/DISMISSED/RESOLVED) with an actor and a note. Invalid statuses and "
        "forbidden transitions are rejected as structured errors, so the review trail stays "
        "truthful."
    ),
    "graph_summary": (
        "Summarise the whole knowledge graph: node/edge counts by type, whether the demo "
        "dataset is seeded and matches expectations, the active store backend, LLM "
        "availability and the alert histogram. Use it first to orient yourself or to check a "
        "deployment's health."
    ),
    "search_knowledge": (
        "Substring search across node names, statements and source text. Use it to turn a "
        "loose phrase ('Frankfurt compliance') into concrete node ids you can pass to the "
        "other tools."
    ),
    "history_query": (
        "Bitemporal history in one tool, selected by mode: 'belief' (what Tripwire believed "
        "at a transaction time), 'valid' (which facts were true in the real world at a time), "
        "'changes' (what it learned since a point in time), 'fact' (one fact's full timeline), "
        "'source_of_change' (which source changed its understanding) and 'dependencies' "
        "(what a decision depended on at a transaction time)."
    ),
    "trigger_demo_event": (
        "Run a named deterministic demo scenario through the full pipeline (assert fact -> "
        "detect contradiction -> propagate staleness -> raise alerts), or supply an explicit "
        "new_fact/source payload. Writes to the graph unless apply=false. Use it to "
        "reproduce the Northwind Labs storyline or to inject a test event."
    ),
}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _error(exc: TripwireError) -> dict[str, Any]:
    """Turn a Tripwire error into the shared structured error payload."""
    return {
        "error": {
            "code": getattr(exc, "code", "tripwire_error"),
            "message": getattr(exc, "message", str(exc)),
            "details": dict(getattr(exc, "details", {}) or {}),
        }
    }


def _internal_error(exc: Exception) -> dict[str, Any]:
    """Last-resort structured error for an unexpected, non-Tripwire failure.

    A tool call must never surface a Python traceback to a client: if a core
    helper raises something outside the ``TripwireError`` hierarchy (for example
    a plain ``ValueError`` from schema validation), it is reported as a
    structured ``internal_error`` and logged server-side for diagnosis.
    """
    logger.exception("unexpected tool failure")
    return {
        "error": {
            "code": "internal_error",
            "message": f"{type(exc).__name__}: {exc}",
            "details": {"exception": type(exc).__name__},
        }
    }


def _check_bounds(name: str, value: int, low: int, high: int) -> None:
    """Reject an out-of-range integer with a structured validation error."""
    if value < low or value > high:
        raise ValidationError(
            f"{name} must be between {low} and {high}, got {value!r}",
            details={"parameter": name, "min": low, "max": high, "value": value},
        )


def _check_depth(max_depth: int) -> None:
    _check_bounds("max_depth", max_depth, MAX_DEPTH_MIN, MAX_DEPTH_MAX)


def _check_limit(limit: int, *, high: int = LIMIT_MAX) -> None:
    _check_bounds("limit", limit, LIMIT_MIN, high)


def _check_alert_status(status: str) -> str:
    """Normalise and validate an alert status against the schema vocabulary."""
    target = str(status or "").strip().upper()
    if target not in ALERT_STATUSES:
        raise ValidationError(
            f"unknown alert status {status!r}; expected one of {list(ALERT_STATUSES)}",
            details={"parameter": "status", "allowed": list(ALERT_STATUSES)},
        )
    return target


class TripwireTools:
    """All Tripwire MCP tools, bound to one shared engine instance."""

    def __init__(self, engine: "GraphEngine") -> None:
        self.engine = engine

    # ------------------------------------------------------------------ 1
    def find_contradictions(
        self,
        fact_id: Optional[str] = None,
        candidate: Optional[dict[str, Any]] = None,
        use_llm: bool = True,
    ) -> dict[str, Any]:
        """Compare an existing fact id or a hypothetical claim against the graph."""
        try:
            if not fact_id and not candidate:
                raise ValidationError(
                    "provide either fact_id (an existing fact) or candidate "
                    "({subject, attribute, value})"
                )
            if fact_id and candidate:
                raise ValidationError("provide either fact_id or candidate, not both")
            result = self.engine.find_contradictions(
                fact_id=fact_id, candidate=candidate, use_llm=use_llm
            )
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)
        # The engine names the boolean `contradiction_found`; expose the spec's
        # `detected` name alongside it so both readers agree on one payload.
        result["detected"] = bool(result.get("contradiction_found"))
        return result

    # ------------------------------------------------------------------ 2
    def propagate_staleness(
        self,
        fact_id: str,
        max_depth: Annotated[
            int, Field(ge=MAX_DEPTH_MIN, le=MAX_DEPTH_MAX, description="Dependency hops to walk (0-8).")
        ] = 3,
        dry_run: bool = True,
        create_alerts: bool = True,
    ) -> dict[str, Any]:
        """Plan (and optionally apply) staleness propagation from a fact.

        ``dry_run`` defaults to ``True`` so a tool call is non-destructive unless
        the caller explicitly asks for writes.
        """
        try:
            _check_depth(max_depth)
            plan = self.engine.plan_staleness(fact_id, max_depth=max_depth)
            payload: dict[str, Any] = {
                "fact_id": fact_id,
                "dry_run": bool(dry_run),
                "applied": False,
                "plan": plan.as_dict(),
                "written": None,
            }
            if not dry_run:
                written = self.engine.apply_staleness(plan, create_alerts=create_alerts)
                payload["applied"] = bool(written.get("impact_count", 0) > 0)
                payload["written"] = written
            return payload
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)

    # ------------------------------------------------------------------ 3
    def find_experts(
        self,
        query: str,
        limit: Annotated[
            int, Field(ge=LIMIT_MIN, le=LIMIT_MAX, description="Maximum ranked people to return.")
        ] = 5,
    ) -> dict[str, Any]:
        """Rank contributors for a system/project query, with the shadow-org signal."""
        try:
            _check_limit(limit)
            if not str(query or "").strip():
                raise ValidationError("query must be a non-empty system or project reference")
            report = self.engine.find_experts(query, limit=limit)
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)
        experts = list(report.get("experts") or [])
        hidden = list(report.get("hidden_experts") or [])
        report["ranked_people"] = experts
        report["shadow_org_signal"] = {
            "hidden_expert_count": len(hidden),
            "hidden_experts": [
                {
                    "person_id": person.get("person_id"),
                    "person_name": person.get("person_name"),
                    "normalized_score": person.get("normalized_score"),
                    "is_official_owner": person.get("is_official_owner"),
                }
                for person in hidden
            ],
        }
        return report

    # ------------------------------------------------------------------ 4
    def explain_path(
        self,
        source: str,
        target: str,
        rels: Optional[list[str]] = None,
        max_depth: Annotated[
            int, Field(ge=MAX_DEPTH_MIN, le=MAX_DEPTH_MAX, description="Maximum path length (0-8).")
        ] = 6,
    ) -> dict[str, Any]:
        """Relationship path(s) between two entities; honest when none exists."""
        try:
            _check_depth(max_depth)
            unknown = [rel for rel in (rels or []) if rel not in REL_TYPES]
            if unknown:
                raise ValidationError(
                    f"unknown relationship type(s): {sorted(unknown)}",
                    details={"allowed": list(REL_TYPES)},
                )
            return self.engine.explain_path(source, target, rels=rels, max_depth=max_depth)
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)

    # ------------------------------------------------------------------ 5
    def explain_decision(self, decision_id: str) -> dict[str, Any]:
        """Structured explanation of a decision and its evidence."""
        try:
            return self.engine.explain_decision(decision_id)
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)

    # ------------------------------------------------------------------ 6
    def explain_alert(self, alert_id: str) -> dict[str, Any]:
        """Structured explanation of an alert."""
        try:
            return self.engine.explain_alert_payload(alert_id)
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)

    # ------------------------------------------------------------------ 7
    def explain_fact(self, fact_id: str) -> dict[str, Any]:
        """Structured explanation of a fact and its provenance."""
        try:
            return self.engine.explain_fact(fact_id)
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)

    # ------------------------------------------------------------------ 8
    def list_alerts(
        self,
        status: Optional[str] = None,
        limit: Annotated[
            int, Field(ge=LIMIT_MIN, le=HISTORY_LIMIT_MAX, description="Page size (1-200).")
        ] = 50,
        offset: Annotated[int, Field(ge=0, description="Pagination offset.")] = 0,
        severity: Optional[str] = None,
        entity_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Paginated alert feed with a status histogram and optional filters."""
        try:
            _check_limit(limit, high=HISTORY_LIMIT_MAX)
            _check_bounds("offset", offset, 0, 10_000)
            where_status = _check_alert_status(status) if status else None
            return self.engine.alerts(
                status=where_status,
                severity=severity,
                entity_id=entity_id,
                limit=limit,
                offset=offset,
            )
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)

    # ------------------------------------------------------------------ 9
    def review_alert(
        self,
        alert_id: str,
        status: str,
        actor_id: Optional[str] = None,
        note: str = "",
    ) -> dict[str, Any]:
        """Transition an alert through the documented status machine."""
        try:
            target = _check_alert_status(status)
            return self.engine.review_alert(
                alert_id, target, actor_id=actor_id, note=note
            )
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)

    # ----------------------------------------------------------------- 10
    def graph_summary(self) -> dict[str, Any]:
        """Counts, dataset state, store backend and alert histogram in one call."""
        try:
            state = self.engine.demo_state()
            summary = {
                "seeded": state.get("seeded"),
                "health": self.engine.health(),
                "counts": state.get("counts"),
                "dataset": state.get("dataset"),
                "store": state.get("store"),
                "llm": state.get("llm"),
                "alerts": state.get("alerts"),
                "key_entities": state.get("key_entities"),
                "config": state.get("config"),
            }
            return summary
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)

    # ----------------------------------------------------------------- 11
    def search_knowledge(
        self,
        query: str,
        limit: Annotated[
            int, Field(ge=LIMIT_MIN, le=HISTORY_LIMIT_MAX, description="Maximum hits (1-200).")
        ] = 25,
    ) -> dict[str, Any]:
        """Substring search across node names, statements and source text."""
        try:
            _check_limit(limit, high=HISTORY_LIMIT_MAX)
            return self.engine.search(query, limit=limit)
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)

    # ----------------------------------------------------------------- 12
    def history_query(
        self,
        mode: Annotated[
            str,
            Field(
                description=(
                    "One of: belief (needs at), valid (needs at), changes (needs since), "
                    "fact (needs fact_id), source_of_change (needs fact_id), "
                    "dependencies (needs decision_id and at)."
                )
            ),
        ],
        at: Optional[str] = None,
        since: Optional[str] = None,
        fact_id: Optional[str] = None,
        decision_id: Optional[str] = None,
        subject_id: Optional[str] = None,
        attribute: Optional[str] = None,
        limit: Annotated[
            int, Field(ge=LIMIT_MIN, le=HISTORY_LIMIT_MAX, description="Maximum rows (1-200).")
        ] = 200,
    ) -> dict[str, Any]:
        """Bitemporal history: belief/valid/changes/fact/source_of_change/dependencies."""
        try:
            _check_limit(limit, high=HISTORY_LIMIT_MAX)
            selected = str(mode or "").strip().lower()
            if selected not in HISTORY_MODES:
                raise ValidationError(
                    f"unknown history mode {mode!r}; expected one of {list(HISTORY_MODES)}",
                    details={"parameter": "mode", "allowed": list(HISTORY_MODES)},
                )
            if selected in ("belief", "valid", "dependencies") and not at:
                raise ValidationError(f"history mode {selected!r} requires 'at'")
            if selected == "changes" and not since:
                raise ValidationError("history mode 'changes' requires 'since'")
            if selected in ("fact", "source_of_change") and not fact_id:
                raise ValidationError(f"history mode {selected!r} requires 'fact_id'")
            if selected == "dependencies" and not decision_id:
                raise ValidationError("history mode 'dependencies' requires 'decision_id'")

            if selected == "belief":
                return self.engine.history_belief(at, limit=limit)
            if selected == "valid":
                return self.engine.history_valid(at, subject_id=subject_id, attribute=attribute)
            if selected == "changes":
                return self.engine.history_changes(since)
            if selected == "fact":
                return self.engine.history_fact(fact_id)
            if selected == "source_of_change":
                return self.engine.history_source_of_change(fact_id)
            return self.engine.history_dependencies(decision_id, at)
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)

    # ----------------------------------------------------------------- 13
    def trigger_demo_event(
        self,
        scenario: Optional[str] = None,
        new_fact: Optional[dict[str, Any]] = None,
        source: Optional[dict[str, Any]] = None,
        actor_id: Optional[str] = None,
        apply: bool = True,
    ) -> dict[str, Any]:
        """Run a named demo scenario (or an explicit fact payload) end to end."""
        try:
            if scenario:
                payload: dict[str, Any] = {"scenario": scenario}
            elif new_fact:
                payload = {"new_fact": new_fact}
                if source:
                    payload["source"] = source
                if actor_id:
                    payload["actor_id"] = actor_id
            else:
                raise ValidationError(
                    "provide 'scenario' (a named demo event) or 'new_fact' "
                    "({subject, attribute, value})"
                )
            return self.engine.trigger_event(payload, apply=apply)
        except TripwireError as exc:
            return _error(exc)
        except Exception as exc:  # noqa: BLE001 - a tool never leaks a traceback
            return _internal_error(exc)


def bound_tools(engine: "GraphEngine") -> dict[str, Callable[..., dict[str, Any]]]:
    """Return ``{tool name: bound callable}`` for every declared tool."""
    tools = TripwireTools(engine)
    return {name: getattr(tools, name) for name in TOOL_NAMES}
