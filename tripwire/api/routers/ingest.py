"""Ingestion adapters and record ingestion.

Both endpoints are deliberately *guarded*: the ingestion module may not exist in
every build of Tripwire.  When it is absent they return HTTP 501 with a clear,
structured message rather than preventing the application from starting, and no
ingestion logic is ever re-implemented here - that belongs to the engine.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends

from ...core.engine import GraphEngine
from ..deps import get_engine
from ..errors import FeatureNotAvailable
from ..schemas import AdaptersResponse, EnginePayload, IngestRequest

router = APIRouter(tags=["ingest"])

logger = logging.getLogger("tripwire.api")

#: Attribute names an ingestion module may expose its adapter catalog under.
_CATALOG_ATTRS = ("ADAPTERS", "ADAPTER_CATALOG", "adapter_catalog", "adapters", "ADAPTER_SPECS")


def _load_adapter_catalog() -> Optional[list[dict[str, Any]]]:
    """Return the ingestion adapter catalog, or ``None`` when unavailable.

    Never raises: a missing or broken ingestion module must not stop the API from
    serving every other endpoint.
    """
    try:
        from ...ingest import base as ingest_base  # type: ignore
    except Exception:  # noqa: BLE001 - optional module
        logger.debug("tripwire.ingest.base is not importable", exc_info=True)
        return None

    catalog: Any = None
    for attribute in _CATALOG_ATTRS:
        candidate = getattr(ingest_base, attribute, None)
        if candidate:
            catalog = candidate
            break
    if catalog is None:
        return None
    if callable(catalog):
        try:
            catalog = catalog()
        except Exception:  # noqa: BLE001 - defensive
            return None
    if isinstance(catalog, dict):
        return [
            {"name": key, **(value if isinstance(value, dict) else {"description": str(value)})}
            for key, value in catalog.items()
        ]
    if isinstance(catalog, (list, tuple)):
        return [item if isinstance(item, dict) else {"name": str(item)} for item in catalog]
    return None


@router.get(
    "/api/ingest/adapters",
    response_model=AdaptersResponse,
    summary="Documented ingestion source adapters",
    description=(
        "The adapter catalog and the input shape each adapter accepts.  Returns 501 "
        "when the ingestion module is not present in this build."
    ),
)
def ingest_adapters() -> dict:
    """Return the adapter catalog, or 501 when it is unavailable."""
    catalog = _load_adapter_catalog()
    if catalog is None:
        raise FeatureNotAvailable(
            "Ingestion adapters are not available in this build: "
            "tripwire.ingest.base does not expose an adapter catalog.",
            details={"module": "tripwire.ingest.base"},
        )
    return {"available": True, "adapters": catalog, "message": None}


@router.post(
    "/api/ingest",
    response_model=EnginePayload,
    summary="Ingest one source record",
    description=(
        "Delegates to `GraphEngine.ingest_source`.  Returns 501 when the engine does "
        "not implement ingestion in this build; no ingestion logic lives in the API."
    ),
)
def ingest(body: IngestRequest, engine: GraphEngine = Depends(get_engine)) -> dict:
    """Delegate to ``engine.ingest_source`` when available."""
    ingest_source = getattr(engine, "ingest_source", None)
    if not callable(ingest_source):
        raise FeatureNotAvailable(
            "Ingestion is not available: GraphEngine.ingest_source is not implemented in "
            "this build. No ingestion logic is implemented in the HTTP layer.",
            details={"adapter": body.source},
        )
    return ingest_source(body.model_dump(exclude_none=True))
