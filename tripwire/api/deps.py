"""Shared FastAPI dependencies.

The engine is created once by :func:`tripwire.api.app.create_app` and stored on
``app.state.engine``.  Routes receive it through :func:`get_engine` rather than
importing a global, so tests can inject an isolated engine.
"""

from __future__ import annotations

from fastapi import Request

from ..core.engine import GraphEngine

__all__ = ["get_engine"]


def get_engine(request: Request) -> GraphEngine:
    """Return the :class:`GraphEngine` bound to the running application."""
    engine = getattr(request.app.state, "engine", None)
    if engine is None:  # pragma: no cover - configuration guard
        raise RuntimeError(
            "GraphEngine is not available on app.state; "
            "build the application with create_app(engine)."
        )
    return engine
