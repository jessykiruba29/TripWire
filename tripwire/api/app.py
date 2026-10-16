"""Application factory and module-level ASGI application.

``create_app(engine=None)`` builds the FastAPI application, wires the engine onto
``app.state.engine`` and mounts every router.  ``app = create_app()`` at the
bottom means ``uvicorn tripwire.api.app:app`` works with no extra wiring.

If no engine is supplied the app is built from :func:`tripwire.config.load_settings`
using ``GraphEngine.from_settings``.  When ``TRIPWIRE_STORE=memory`` (or the
configured backend is unreachable and the store falls back) the demo runs
end-to-end with no external service.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from ..config import Settings, load_settings
from ..core.engine import GraphEngine
from ..core.store import MemoryGraphStore
from .errors import register_exception_handlers
from .routers import (
    alerts,
    contradictions,
    dataset,
    decisions,
    demo,
    experts,
    facts,
    graph,
    health,
    history,
    ingest,
    search,
    sources,
    staleness,
)

logger = logging.getLogger("tripwire.api")

__all__ = ["create_app", "app", "API_TITLE", "API_VERSION", "API_DESCRIPTION", "OPENAPI_TAGS"]

API_TITLE = "Tripwire API"
API_VERSION = "1.0.0"
API_DESCRIPTION = (
    "Tripwire remembers what a company's decisions were based on, and tells people "
    "when the facts underneath those decisions have changed.\n\n"
    "This HTTP API is a thin adapter over `tripwire.core.engine.GraphEngine`: every "
    "route delegates to the engine, so the HTTP surface and the MCP tools share one "
    "implementation of each reasoning operation.\n\n"
    "All failures share one envelope: `{\"error\": ..., \"message\": ..., \"details\": ...}`."
)

OPENAPI_TAGS = [
    {"name": "health", "description": "Liveness and configuration probe."},
    {"name": "demo", "description": "Seed, reset, status and the trigger-event demonstration."},
    {"name": "dataset", "description": "The deterministic Northwind Labs demo dataset."},
    {"name": "graph", "description": "Graph payloads and relationship paths."},
    {"name": "decisions", "description": "Decision explanations, status changes and dependencies."},
    {"name": "facts", "description": "Fact change explanations."},
    {"name": "experts", "description": "Contribution-based expert finding."},
    {"name": "reasoning", "description": "Contradiction detection and staleness propagation."},
    {"name": "alerts", "description": "Alert feed, detail, history and review."},
    {"name": "history", "description": "Bitemporal history queries."},
    {"name": "search", "description": "Substring search across the graph."},
    {"name": "sources", "description": "Source artifacts and the facts they state."},
    {"name": "ingest", "description": "Optional ingestion adapters and record ingestion."},
]

_ROUTERS = (
    health,
    demo,
    dataset,
    graph,
    decisions,
    facts,
    experts,
    contradictions,
    staleness,
    alerts,
    history,
    search,
    sources,
    ingest,
)


def _build_engine(settings: Settings) -> GraphEngine:
    """Build an engine, falling back to the in-memory store on any failure."""
    try:
        return GraphEngine.from_settings(settings)
    except Exception:  # noqa: BLE001 - the API must always start
        logger.exception("engine initialisation failed; falling back to the in-memory store")
        return GraphEngine(MemoryGraphStore(), settings=settings)


def _install_request_logging(application: FastAPI) -> None:
    """Log one line per request without bodies or query strings (no secrets)."""

    @application.middleware("http")
    async def _log_requests(request: Request, call_next):  # type: ignore[no-untyped-def]
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:  # noqa: BLE001 - log then let the handlers deal with it
            logger.exception("request failed: %s %s", request.method, request.url.path)
            raise
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        logger.info(
            "%s %s -> %s (%.1f ms)",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
        return response


def create_app(engine: Optional[GraphEngine] = None) -> FastAPI:
    """Create the Tripwire FastAPI application.

    Parameters
    ----------
    engine:
        An engine to bind to ``app.state.engine``.  When omitted one is built from
        the current settings.
    """
    resolved_engine = engine if engine is not None else _build_engine(load_settings())

    application = FastAPI(
        title=API_TITLE,
        version=API_VERSION,
        description=API_DESCRIPTION,
        openapi_tags=OPENAPI_TAGS,
        contact=None,
    )
    application.state.engine = resolved_engine

    settings = resolved_engine.settings
    origins = list(settings.cors_origins) or ["*"]
    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=("*" not in origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(application)
    _install_request_logging(application)

    for module in _ROUTERS:
        application.include_router(module.router)

    return application


app = create_app()
