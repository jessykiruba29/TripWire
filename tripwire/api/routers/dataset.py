"""Dataset scenario catalog for the demo trigger-event endpoint."""

from __future__ import annotations

from fastapi import APIRouter

from ...dataset.northwind import SCENARIOS, scenario_names
from ..schemas import ScenariosResponse

router = APIRouter(tags=["dataset"])


@router.get(
    "/api/dataset/scenarios",
    response_model=ScenariosResponse,
    summary="List available demo scenarios",
    description=(
        "Every scenario accepted by `POST /api/demo/trigger-event`, with the "
        "description of what the run demonstrates."
    ),
)
def list_scenarios() -> dict:
    """Return the scenario catalog from :mod:`tripwire.dataset.northwind`."""
    scenarios = [
        {"name": name, "description": SCENARIOS[name].get("description")}
        for name in scenario_names()
    ]
    return {"total": len(scenarios), "scenarios": scenarios}
