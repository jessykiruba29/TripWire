"""MCP server for Tripwire.

Two transports are supported:

``stdio`` (primary)
    For local MCP clients (Claude Desktop, IDE agents, ``mcp`` CLI).  Nothing is
    ever printed to stdout except the protocol itself - diagnostics go to stderr.
``streamable-http``
    For remote/HTTP clients, served at ``/mcp`` by default.

The server is deliberately thin: :func:`build_server` registers the callables from
:mod:`tripwire.mcp_server.tools` on an :class:`~mcp.server.mcpserver.MCPServer`,
and those callables call the *same* :class:`~tripwire.core.engine.GraphEngine` the
HTTP API uses.  There is exactly one implementation of every reasoning operation.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from mcp.server.mcpserver import MCPServer

from ..core.engine import GraphEngine
from .tools import CORE_TOOLS, TOOL_DESCRIPTIONS, TOOL_NAMES, TripwireTools

__all__ = ["SERVER_NAME", "INSTRUCTIONS", "build_server", "run", "streamable_http_app"]

SERVER_NAME = "tripwire"
DEFAULT_HTTP_HOST = "127.0.0.1"
DEFAULT_HTTP_PORT = 8765
DEFAULT_HTTP_PATH = "/mcp"

INSTRUCTIONS = (
    "Tripwire remembers what a company's decisions were based on and tells you when the "
    "facts underneath them change. Every tool reads the same knowledge graph the Tripwire "
    "HTTP API reads, so results are consistent across surfaces.\n"
    "\n"
    "Four core tools cover the main workflows:\n"
    "  * find_contradictions - check a fact id or a hypothetical claim against the graph "
    "before you record it. Read-only.\n"
    "  * propagate_staleness - from a changed fact, find the decisions/projects whose "
    "reasoning rests on it, with certainty (potential/confirmed) and evidence paths. "
    "Default is dry_run=true (nothing is written).\n"
    "  * find_experts - rank the people who actually know a system or project from "
    "contribution evidence, and show where that diverges from official ownership.\n"
    "  * explain_path - the relationship path(s) between two entities; reports honestly "
    "when no path exists.\n"
    "\n"
    "Supporting tools: explain_decision, explain_alert, explain_fact, list_alerts, "
    "review_alert, graph_summary, search_knowledge, history_query, trigger_demo_event. "
    "Start with graph_summary to see the dataset state, and search_knowledge to turn a "
    "phrase into node ids. Tripwire never auto-invalidates a decision: it flags entities "
    "as POTENTIALLY_STALE and requires an explicit review to mark them STALE. Failures "
    "come back as {\"error\": {\"code\", \"message\", \"details\"}} rather than as raw "
    "exceptions."
)


def _version() -> str:
    """Tripwire's version, when importable (never fatal)."""
    try:
        from .. import __version__

        return str(__version__)
    except Exception:  # noqa: BLE001 - the server must start regardless
        return "0.0.0"


def build_server(engine: Optional[GraphEngine] = None) -> MCPServer:
    """Build an MCP server exposing the Tripwire tools.

    Parameters
    ----------
    engine:
        The shared graph engine.  When omitted, an engine is created with
        :meth:`GraphEngine.from_settings` (honouring ``TRIPWIRE_STORE`` and its
        automatic JSON fallback), so the same construction path as the HTTP API
        is used - never a second store.
    """
    resolved = engine if engine is not None else GraphEngine.from_settings()
    server: MCPServer = MCPServer(
        name=SERVER_NAME,
        version=_version(),
        instructions=INSTRUCTIONS,
    )
    tools = TripwireTools(resolved)
    for name in TOOL_NAMES:
        # Register the very same bound callable tests can invoke directly: there
        # is no second implementation to drift.
        server.add_tool(getattr(tools, name), name=name, description=TOOL_DESCRIPTIONS[name])
    logging.getLogger("tripwire.mcp").info(
        "MCP server '%s' v%s ready with %d tools (core: %s)",
        SERVER_NAME,
        _version(),
        len(TOOL_NAMES),
        ", ".join(CORE_TOOLS),
    )
    return server


def run(
    transport: str = "stdio",
    *,
    host: str = DEFAULT_HTTP_HOST,
    port: int = DEFAULT_HTTP_PORT,
    path: str = DEFAULT_HTTP_PATH,
    engine: Optional[GraphEngine] = None,
    **kwargs: Any,
) -> None:
    """Run the server, blocking until it stops.

    ``transport`` is ``"stdio"`` (default) or ``"streamable-http"``.
    """
    normalised = str(transport or "stdio").strip().lower()
    server = build_server(engine)
    if normalised == "stdio":
        server.run(transport="stdio")
        return
    if normalised in ("streamable-http", "streamable_http", "http"):
        server.run(
            transport="streamable-http",
            host=host,
            port=port,
            streamable_http_path=path,
            **kwargs,
        )
        return
    raise ValueError(
        f"unknown transport {transport!r}; expected 'stdio' or 'streamable-http'"
    )


def streamable_http_app(
    engine: Optional[GraphEngine] = None,
    *,
    path: str = DEFAULT_HTTP_PATH,
    host: str = DEFAULT_HTTP_HOST,
    **kwargs: Any,
):
    """Return the ASGI (Starlette) app for mounting under an existing web server."""
    server = build_server(engine)
    return server.streamable_http_app(
        streamable_http_path=path, host=host, **kwargs
    )
