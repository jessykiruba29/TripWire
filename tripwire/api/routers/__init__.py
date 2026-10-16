"""Route modules, grouped by domain.

Each module exposes a single ``router`` (:class:`fastapi.APIRouter`).  Routes are
plain synchronous functions that delegate to :class:`GraphEngine`, so FastAPI
runs them in its worker threadpool and the event loop is never blocked by the
synchronous engine.
"""

from __future__ import annotations

__all__ = [
    "health",
    "demo",
    "dataset",
    "graph",
    "decisions",
    "facts",
    "experts",
    "contradictions",
    "staleness",
    "alerts",
    "history",
    "search",
    "sources",
    "ingest",
]
