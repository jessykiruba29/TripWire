"""Tripwire's MCP (Model Context Protocol) server layer.

``tripwire.mcp_server.tools``
    The tool callables - thin, validated adapters over the shared
    :class:`~tripwire.core.engine.GraphEngine`.  Importable and directly testable.
``tripwire.mcp_server.server``
    :func:`~tripwire.mcp_server.server.build_server` (an
    :class:`~mcp.server.mcpserver.MCPServer` factory) plus a ``run`` entry point
    for the stdio and streamable-http transports.
``tripwire.mcp_server.__main__``
    ``python -m tripwire.mcp_server`` starts stdio; ``--transport streamable-http``
    starts the HTTP endpoint.

This package contains **no** graph reasoning: every tool calls the one engine the
HTTP API also uses, which is what keeps the two surfaces consistent (spec S12).
"""

from __future__ import annotations

from .server import build_server, run, streamable_http_app
from .tools import CORE_TOOLS, TOOL_DESCRIPTIONS, TOOL_NAMES, TripwireTools, bound_tools

__all__ = [
    "build_server",
    "run",
    "streamable_http_app",
    "TripwireTools",
    "bound_tools",
    "CORE_TOOLS",
    "TOOL_NAMES",
    "TOOL_DESCRIPTIONS",
]
