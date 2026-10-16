"""Health probe."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ...core.engine import GraphEngine
from ..deps import get_engine
from ..schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get(
    "/api/health",
    response_model=HealthResponse,
    summary="Composite health check",
    description=(
        "Reports store liveness, the *active* backend, whether the demo dataset is "
        "seeded and whether a live LLM is configured.  Never raises: a degraded "
        "store is reported as `status: degraded`."
    ),
)
def health(engine: GraphEngine = Depends(get_engine)) -> dict:
    """Return ``engine.health()``."""
    return engine.health()
