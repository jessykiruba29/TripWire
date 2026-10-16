"""FastAPI HTTP surface for Tripwire.

Every route here is a *thin adapter* over
:class:`tripwire.core.engine.GraphEngine`: no route re-implements graph
reasoning.  The engine is the single implementation that both this HTTP API and
the MCP tools call, which is what keeps the two surfaces consistent (spec S12).

Public surface
--------------
``create_app``
    Application factory: ``create_app(engine=None) -> FastAPI``.
``app``
    Module-level ASGI application, so ``uvicorn tripwire.api.app:app`` works.
"""

from __future__ import annotations

from .app import app, create_app

__all__ = ["app", "create_app"]
