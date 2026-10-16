"""Tripwire - decision provenance and stale-knowledge detection.

Tripwire remembers what a company's decisions were based on, and tells people when
the facts underneath those decisions have changed.

Package layout
--------------
``tripwire.core``
    Graph schema, store abstraction (FalkorDB / JSON / memory), and the reasoning
    engine: contradiction detection, staleness propagation, bitemporal history,
    explanations, contribution-based expert ranking and alerts.
``tripwire.ingest``
    Source adapters (Slack, tickets, PRDs, meeting notes) and the ingestion
    pipeline, including the optional LLM extraction path.
``tripwire.dataset``
    The deterministic Northwind Labs demo dataset, seed and reset commands.
``tripwire.api``
    FastAPI HTTP surface.
``tripwire.mcp_server``
    MCP server exposing the same engine as tools.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "1.0.0"
