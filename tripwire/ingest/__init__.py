"""Knowledge ingestion: adapters, extractors and the ingestion pipeline.

Typical use::

    from tripwire.core.engine import GraphEngine

    engine = GraphEngine.from_settings()
    report = engine.ingest_source({
        "source": "slack",
        "record": {
            "external_id": "msg-1",
            "channel": "#eu-launch",
            "author": "Priya Raman",
            "timestamp": "2026-02-20T08:15:00Z",
            "text": "Frankfurt Hosting Partner's EU compliance certification was revoked.",
        },
    })

The pipeline works offline via the deterministic extractor and uses an LLM only
when ``LLM_PROVIDER``/``LLM_API_KEY`` are configured; extracted claims are always
recorded as unverified candidates pending review.
"""

from __future__ import annotations

from .base import (
    ADAPTER_CATALOG,
    ExtractionResult,
    ExtractedClaim,
    ExtractedEntity,
    KnowledgeExtractor,
    SourceAdapter,
    SourceRecord,
    adapter_catalog,
    adapter_names,
    get_adapter,
    validate_extraction,
)
from .deterministic import PATTERNS, DeterministicExtractor
from .pipeline import IngestionPipeline, normalise_payload

__all__ = [
    "SourceAdapter",
    "SourceRecord",
    "ExtractionResult",
    "ExtractedClaim",
    "ExtractedEntity",
    "KnowledgeExtractor",
    "validate_extraction",
    "adapter_catalog",
    "adapter_names",
    "get_adapter",
    "ADAPTER_CATALOG",
    "DeterministicExtractor",
    "PATTERNS",
    "IngestionPipeline",
    "normalise_payload",
]
