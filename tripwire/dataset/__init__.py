"""Deterministic demo dataset and demo scenarios.

Use :func:`tripwire.dataset.northwind.build_subgraph` to materialise the graph and
:func:`tripwire.dataset.northwind.scenario_event` to obtain a scripted incoming
event.  Both are pure functions, so seeding and triggering are reproducible.
"""

from __future__ import annotations

from .northwind import (
    COMPLIANCE_FACT_ID,
    DATASET_NAME,
    DATASET_VERSION,
    KEY_IDS,
    SCENARIOS,
    SOC2_FACT_ID,
    STORYLINE,
    build_subgraph,
    dataset_manifest,
    scenario_event,
    scenario_names,
)

__all__ = [
    "build_subgraph",
    "dataset_manifest",
    "scenario_event",
    "scenario_names",
    "SCENARIOS",
    "KEY_IDS",
    "STORYLINE",
    "DATASET_NAME",
    "DATASET_VERSION",
    "COMPLIANCE_FACT_ID",
    "SOC2_FACT_ID",
]
