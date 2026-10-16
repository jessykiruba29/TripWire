"""``python -m tripwire.mcp_server`` - start the Tripwire MCP server.

Examples
--------
Stdio (for a local MCP client)::

    python -m tripwire.mcp_server

Streamable HTTP (for a remote/HTTP client)::

    python -m tripwire.mcp_server --transport streamable-http --port 8765

All startup diagnostics are written to **stderr**: on the stdio transport stdout
carries the JSON-RPC protocol, and a stray ``print`` there would corrupt it.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Optional, Sequence

from .server import DEFAULT_HTTP_HOST, DEFAULT_HTTP_PATH, DEFAULT_HTTP_PORT
from .server import build_server


def _log(message: str) -> None:
    """Write a startup diagnostic to stderr (never stdout)."""
    print(f"[tripwire-mcp] {message}", file=sys.stderr, flush=True)


def build_parser() -> argparse.ArgumentParser:
    """Command-line interface for the MCP server."""
    parser = argparse.ArgumentParser(
        prog="python -m tripwire.mcp_server",
        description=(
            "Start the Tripwire MCP server. Tools expose the same graph engine as the "
            "Tripwire HTTP API."
        ),
    )
    parser.add_argument(
        "--transport",
        choices=("stdio", "streamable-http"),
        default="stdio",
        help="Transport to serve (default: stdio).",
    )
    parser.add_argument("--host", default=DEFAULT_HTTP_HOST, help="HTTP bind host.")
    parser.add_argument("--port", type=int, default=DEFAULT_HTTP_PORT, help="HTTP bind port.")
    parser.add_argument("--path", default=DEFAULT_HTTP_PATH, help="HTTP mount path (default /mcp).")
    parser.add_argument(
        "--store",
        default=None,
        help=(
            "Override the store backend: memory, json or falkordb. "
            "Defaults to $TRIPWIRE_STORE (then falkordb with JSON fallback)."
        ),
    )
    parser.add_argument(
        "--seed",
        action="store_true",
        help="Seed the Northwind Labs demo dataset when the graph is empty.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"),
        help="Logging level (logs go to stderr).",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Entry point: parse arguments, build the engine, serve."""
    args = build_parser().parse_args(argv)

    logging.basicConfig(
        stream=sys.stderr,
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.store:
        os.environ["TRIPWIRE_STORE"] = args.store

    from ..core.engine import GraphEngine

    try:
        engine = GraphEngine.from_settings()
    except Exception as exc:  # noqa: BLE001 - report, never traceback-dump to stdout
        _log(f"failed to open the graph store: {exc}")
        return 2

    _log(
        f"store backend={engine.store.backend} "
        f"(configured={engine.settings.store_backend}) "
        f"nodes={engine.store.node_count()} edges={engine.store.edge_count()} "
        f"seeded={engine.is_seeded()}"
    )

    if args.seed and not engine.is_seeded():
        result = engine.seed_demo()
        _log(
            f"seeded dataset v{result['manifest']['version']}: "
            f"{result['nodes_after']} nodes, {result['edges_after']} edges"
        )

    server = build_server(engine)

    if args.transport == "streamable-http":
        _log(f"serving streamable-http on http://{args.host}:{args.port}{args.path}")
    else:
        _log("serving stdio (stdout is reserved for the MCP protocol)")

    try:
        if args.transport == "streamable-http":
            server.run(
                transport="streamable-http",
                host=args.host,
                port=args.port,
                streamable_http_path=args.path,
            )
        else:
            server.run(transport="stdio")
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        _log("interrupted; shutting down")
        return 130
    return 0


if __name__ == "__main__":  # pragma: no cover - module entry point
    raise SystemExit(main())
