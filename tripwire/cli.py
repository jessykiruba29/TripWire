"""Tripwire command-line interface.

Dispatchable both ways::

    python -m tripwire <command> [options]
    python -m tripwire.cli <command> [options]

The CLI is a thin adapter over :class:`tripwire.core.engine.GraphEngine`, exactly
like the HTTP API and the MCP server.  It creates the engine with
:meth:`GraphEngine.from_settings`, so it honours ``TRIPWIRE_STORE`` and the JSON
fallback; nothing about the store or the reasoning is re-implemented here.

Every command prints a clear message (never a traceback) on bad input and exits
non-zero on failure.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from typing import Any, Optional, Sequence

__all__ = ["main", "build_parser"]

PROG = "tripwire"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _message(exc: BaseException) -> str:
    """Human-readable text for an exception, preferring a TripwireError message."""
    message = getattr(exc, "message", None)
    if message:
        return str(message)
    text = str(exc).strip()
    return text or exc.__class__.__name__


def _apply_store_override(args: argparse.Namespace) -> None:
    """Honour a global ``--store`` before any engine is constructed."""
    store = getattr(args, "store", None)
    if store:
        os.environ["TRIPWIRE_STORE"] = store


def _engine(args: argparse.Namespace) -> Any:
    """Build the configured engine (``GraphEngine.from_settings``)."""
    from .core.engine import GraphEngine

    return GraphEngine.from_settings()


def _dump(payload: Any) -> str:
    """Stable, indented JSON for any engine payload."""
    return json.dumps(payload, indent=2, default=str)


def _read_json_file(path: str) -> Any:
    """Read and parse a JSON file, raising a friendly error on failure."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise SystemExit(f"record file not found: {path}") from exc
    except OSError as exc:
        raise SystemExit(f"could not read record file {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"record file {path} is not valid JSON: {exc}") from exc


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def cmd_seed(args: argparse.Namespace) -> int:
    """Seed the deterministic Northwind Labs dataset."""
    engine = _engine(args)
    result = engine.seed_demo(force=args.force)

    manifest = result["manifest"]
    actual = result["actual_counts"]
    expected = manifest["expected_counts"]
    by_label = actual["by_label"]
    matches = {label: by_label.get(label, 0) == count for label, count in expected.items()}
    mismatched = [label for label, ok in matches.items() if not ok]

    print(
        f"Seeded dataset '{manifest['name']}' v{manifest['version']} "
        f"(force={result['forced']})"
    )
    print(
        f"  nodes: {result['nodes_after']}  edges: {result['edges_after']}  "
        f"(before: {result['nodes_before']}/{result['edges_before']})"
    )
    print("  counts by label:")
    for label in sorted(expected):
        got = by_label.get(label, 0)
        want = expected[label]
        flag = "" if got == want else f"  <-- expected {want}"
        print(f"    {label:<11} {got}{flag}")
    if mismatched:
        print(
            f"  MISMATCH: {', '.join(mismatched)} do not match the dataset manifest",
            file=sys.stderr,
        )
        return 1
    print("  matches manifest expected counts: yes (all labels)")
    return 0


def cmd_reset(args: argparse.Namespace) -> int:
    """Clear the graph and re-seed the pristine demo state."""
    engine = _engine(args)
    result = engine.reset()
    by_label = result["actual_counts"]["by_label"]
    print(
        f"Reset complete: {by_label.get('Decision', 0)} decisions, "
        f"{by_label.get('Fact', 0)} facts, "
        f"{result['nodes_after']} nodes / {result['edges_after']} edges restored"
    )
    print(f"  seeded: {result['state']['seeded']}")
    return 0


def cmd_state(args: argparse.Namespace) -> int:
    """Print ``engine.demo_state()`` as indented JSON."""
    engine = _engine(args)
    state = engine.demo_state()
    payload = _dump(state)
    if args.json:
        print(payload)
    else:
        store = state.get("store", {})
        counts = state.get("counts", {})
        print(
            f"# store={store.get('active_backend')} "
            f"(configured={store.get('configured_backend')}) "
            f"seeded={state.get('seeded')} "
            f"nodes={counts.get('nodes')} edges={counts.get('edges')}"
        )
        print(payload)
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    """Run the FastAPI application with uvicorn."""
    from .config import load_settings

    settings = load_settings()
    host = args.host or settings.api_host
    port = args.port or settings.api_port
    print(
        f"serving Tripwire API on http://{host}:{port} "
        f"(store={settings.store_backend})",
        file=sys.stderr,
    )
    import uvicorn

    uvicorn.run(
        "tripwire.api.app:app",
        host=host,
        port=port,
        reload=bool(args.reload),
        log_level=settings.log_level.lower(),
    )
    return 0


def cmd_mcp(args: argparse.Namespace) -> int:
    """Delegate to ``python -m tripwire.mcp_server`` (its real flags are reused)."""
    from .mcp_server.__main__ import main as mcp_main

    argv: list[str] = ["--transport", args.transport]
    if args.host:
        argv += ["--host", args.host]
    if args.port is not None:
        argv += ["--port", str(args.port)]
    if args.path:
        argv += ["--path", args.path]
    if args.store:
        argv += ["--store", args.store]
    if args.seed:
        argv += ["--seed"]
    if args.log_level:
        argv += ["--log-level", args.log_level]
    return int(mcp_main(argv))


def _print_scenarios() -> None:
    """List the deterministic demo scenarios."""
    from .dataset.northwind import SCENARIOS

    print(f"Available scenarios ({len(SCENARIOS)}):")
    for name in sorted(SCENARIOS):
        description = SCENARIOS[name].get("description", "")
        print(f"  - {name}")
        print(f"      {description}")


def cmd_trigger_event(args: argparse.Namespace) -> int:
    """Run a demo scenario through the contradiction -> propagation pipeline."""
    if args.list:
        _print_scenarios()
        return 0
    if not args.scenario:
        print(
            "error: --scenario NAME is required (run with --list to see the options)",
            file=sys.stderr,
        )
        return 2

    engine = _engine(args)
    response = engine.trigger_event({"scenario": args.scenario}, apply=not args.dry_run)

    event = response.get("event", {})
    contradiction = response.get("contradiction", {})
    print(
        f"Scenario: {event.get('scenario')}  applied={event.get('applied')}  "
        f"llm_enabled={event.get('llm_enabled')}"
    )
    if args.dry_run:
        print("(dry run: the claim is asserted, but no conflict/propagation state is written)")

    if not contradiction.get("detected"):
        print(f"Contradiction: none detected - {contradiction.get('reason')}")
        return 0

    primary = contradiction.get("primary") or {}
    print(
        f"Contradiction detected: kind={primary.get('kind')} "
        f"severity={primary.get('severity')} confidence={primary.get('confidence')} "
        f"rule={primary.get('explicit_rule')}"
    )
    rationale = primary.get("rationale")
    if rationale:
        print(f"  rationale: {rationale}")
    summary = contradiction.get("summary")
    if isinstance(summary, dict):
        kinds = ", ".join(f"{k}={v}" for k, v in summary.items() if v)
        print(f"  classification: {kinds or 'none'}")

    impacts = response.get("impacts") or []
    print(f"\nAffected entities ({len(impacts)}):")
    for impact in impacts:
        alert = impact.get("alert") or {}
        alternative = "  (has independent alternative evidence)" if impact.get(
            "has_alternate_evidence"
        ) else ""
        print(
            f"  - [{impact.get('entity_label')}] {impact.get('entity_id')}  "
            f"{impact.get('status_before')} -> {impact.get('status_after')}  "
            f"certainty={impact.get('certainty')}{alternative}"
        )
        if alert.get("alert_id"):
            print(
                f"      alert {alert['alert_id']} status={alert.get('status')} "
                f"severity={alert.get('severity')}"
            )

    notes = (response.get("propagation") or {}).get("notes") or []
    print("\nPropagation notes:")
    for note in notes:
        print(f"  - {note}")
    if not notes:
        print("  (none)")

    alert_ids = response.get("alert_ids") or []
    print(f"\nAlert ids: {', '.join(alert_ids) if alert_ids else '(none)'}")
    return 0


def cmd_experts(args: argparse.Namespace) -> int:
    """Rank contributors for a system/project, showing official ownership."""
    engine = _engine(args)
    report = engine.find_experts(args.query, limit=args.limit)

    target = report.get("target_name") or report.get("target_id") or "(unresolved)"
    print(f"Expert ranking for: {target}")
    experts = report.get("experts") or []
    if not experts:
        for note in report.get("notes") or []:
            print(f"  note: {note}")
        return 0

    print(f"  {'#':<3}{'person':<20}{'role':<24}{'score':>7}  {'norm':>5}  owner  shadow")
    for expert in experts:
        print(
            f"  {expert.get('rank', ''):<3}"
            f"{(expert.get('person_name') or '')[:19]:<20}"
            f"{(expert.get('role') or '-')[:23]:<24}"
            f"{expert.get('score', 0):>7}"
            f"  {expert.get('normalized_score', 0):>5}"
            f"  {'yes' if expert.get('is_official_owner') else 'no ':<5}"
            f"  {'yes' if expert.get('shadow_signal') else '-'}"
        )

    owners = report.get("official_owners") or []
    if owners:
        print("\nOfficial owners (org chart, for contrast):")
        for owner in owners:
            print(f"  - {owner.get('person_name')} ({owner.get('official_role') or 'role?'}) "
                  f"owns {owner.get('owns_name')}")
    for note in report.get("notes") or []:
        print(f"  note: {note}")
    return 0


def cmd_explain_decision(args: argparse.Namespace) -> int:
    """Print the structured explanation for a decision."""
    engine = _engine(args)
    payload = engine.explain_decision(args.id)
    print(_dump(payload))
    return 0 if payload.get("found") else 1


def cmd_explain_alert(args: argparse.Namespace) -> int:
    """Print the structured explanation for an alert."""
    engine = _engine(args)
    payload = engine.explain_alert_payload(args.id)
    print(_dump(payload))
    return 0 if payload.get("found") else 1


def _explain_usage(args: argparse.Namespace) -> int:
    """``explain`` without a target."""
    print(
        "error: specify 'decision' or 'alert' "
        "(e.g. tripwire explain decision --id decision:eu-launch)",
        file=sys.stderr,
    )
    return 2


def cmd_adapters(args: argparse.Namespace) -> int:
    """Print the ingestion adapter catalogue (name + accepted input fields)."""
    engine = _engine(args)
    catalog = engine.ingestion_adapters()
    print(f"Ingestion adapters ({len(catalog)}):")
    for adapter in catalog:
        print(
            f"\n- {adapter.get('name')}  ({adapter.get('source_system')} -> "
            f"{adapter.get('produces_label')})"
        )
        description = adapter.get("description")
        if description:
            print(f"    {description}")
        shape = adapter.get("input_shape") or {}
        if shape:
            print("    input fields:")
            for field, detail in shape.items():
                print(f"      {field}: {detail}")
    return 0


def cmd_ingest(args: argparse.Namespace) -> int:
    """Ingest one source record from a JSON file."""
    record = _read_json_file(args.record)
    if not isinstance(record, dict):
        print(
            f"error: record file {args.record} must contain a JSON object",
            file=sys.stderr,
        )
        return 2

    engine = _engine(args)
    report = engine.ingest_source({"source": args.source, "record": record})

    source = report.get("source", {})
    extractor = report.get("extractor", {})
    counts = report.get("counts", {})
    print(f"Ingested {args.source} record {source.get('external_id')} -> {source.get('id')}")
    print(
        f"  extractor: {extractor.get('name')} "
        f"(llm_used={extractor.get('llm_used')}, "
        f"deterministic_fallback={extractor.get('deterministic_fallback')})"
    )
    print(f"  duplicate_source: {source.get('duplicate_source')}")
    print("  counts:")
    for key in sorted(counts):
        print(f"    {key}: {counts[key]}")
    warnings = extractor.get("warnings") or []
    if warnings:
        print("  warnings:")
        for warning in warnings:
            print(f"    - {warning}")
    return 0


# --------------------------------------------------------------------------- #
# Argument parser
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    """Construct the Tripwire CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog=PROG,
        description=(
            "Tripwire: decision provenance and stale-knowledge detection. "
            "A CLI over the same GraphEngine the HTTP API and MCP server use."
        ),
    )
    parser.add_argument(
        "--store",
        choices=("memory", "json", "falkordb"),
        default=None,
        help=(
            "Override the store backend for this process "
            "(default: $TRIPWIRE_STORE, then falkordb with JSON fallback)."
        ),
    )
    sub = parser.add_subparsers(dest="command")

    # seed ------------------------------------------------------------------ #
    p_seed = sub.add_parser("seed", help="Seed the Northwind Labs demo dataset.")
    p_seed.add_argument("--force", action="store_true", help="Re-seed even if already seeded.")
    p_seed.set_defaults(func=cmd_seed)

    # reset ----------------------------------------------------------------- #
    p_reset = sub.add_parser("reset", help="Clear the graph and re-seed it.")
    p_reset.set_defaults(func=cmd_reset)

    # state ----------------------------------------------------------------- #
    p_state = sub.add_parser("state", help="Print the full demo/dataset state as JSON.")
    p_state.add_argument(
        "--json", action="store_true", help="Print only the JSON (no summary banner)."
    )
    p_state.set_defaults(func=cmd_state)

    # serve ----------------------------------------------------------------- #
    p_serve = sub.add_parser("serve", help="Run the HTTP API with uvicorn.")
    p_serve.add_argument("--host", default=None, help="Bind host (default: TRIPWIRE_API_HOST).")
    p_serve.add_argument(
        "--port", type=int, default=None, help="Bind port (default: TRIPWIRE_API_PORT)."
    )
    p_serve.add_argument("--reload", action="store_true", help="Auto-reload on code changes.")
    p_serve.set_defaults(func=cmd_serve)

    # mcp ------------------------------------------------------------------- #
    p_mcp = sub.add_parser("mcp", help="Run the MCP server (delegates to tripwire.mcp_server).")
    p_mcp.add_argument(
        "--transport",
        choices=("stdio", "streamable-http"),
        default="stdio",
        help="Transport to serve (default: stdio).",
    )
    p_mcp.add_argument("--host", default=None, help="HTTP bind host (streamable-http only).")
    p_mcp.add_argument("--port", type=int, default=None, help="HTTP bind port (streamable-http only).")
    p_mcp.add_argument("--path", default=None, help="HTTP mount path (default: /mcp).")
    p_mcp.add_argument(
        "--store",
        choices=("memory", "json", "falkordb"),
        default=None,
        help="Store backend override passed to the MCP server.",
    )
    p_mcp.add_argument("--seed", action="store_true", help="Seed the demo dataset when empty.")
    p_mcp.add_argument(
        "--log-level",
        default=None,
        choices=("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"),
        help="Logging level for the MCP server.",
    )
    p_mcp.set_defaults(func=cmd_mcp)

    # trigger-event --------------------------------------------------------- #
    p_trigger = sub.add_parser(
        "trigger-event", help="Run a demo event through the contradiction pipeline."
    )
    p_trigger.add_argument("--scenario", default=None, help="Scenario name to trigger.")
    p_trigger.add_argument(
        "--list", action="store_true", help="List the available scenarios and exit."
    )
    p_trigger.add_argument(
        "--dry-run", action="store_true", help="Plan the impacts without writing them."
    )
    p_trigger.set_defaults(func=cmd_trigger_event)

    # experts --------------------------------------------------------------- #
    p_experts = sub.add_parser("experts", help="Rank contributors for a system/project.")
    p_experts.add_argument("--query", required=True, help="System or project to query.")
    p_experts.add_argument("--limit", type=int, default=5, help="Maximum people (default: 5).")
    p_experts.set_defaults(func=cmd_experts)

    # explain --------------------------------------------------------------- #
    p_explain = sub.add_parser("explain", help="Explain a decision or an alert.")
    p_explain.set_defaults(func=_explain_usage)
    explain_sub = p_explain.add_subparsers(dest="what")
    p_dec = explain_sub.add_parser("decision", help="Explain a decision by id.")
    p_dec.add_argument("--id", required=True, dest="id", help="Decision id.")
    p_dec.set_defaults(func=cmd_explain_decision)
    p_alert = explain_sub.add_parser("alert", help="Explain an alert by id.")
    p_alert.add_argument("--id", required=True, dest="id", help="Alert id.")
    p_alert.set_defaults(func=cmd_explain_alert)

    # adapters -------------------------------------------------------------- #
    p_adapters = sub.add_parser("adapters", help="Print the ingestion adapter catalogue.")
    p_adapters.set_defaults(func=cmd_adapters)

    # ingest ---------------------------------------------------------------- #
    p_ingest = sub.add_parser("ingest", help="Ingest one source record from a JSON file.")
    p_ingest.add_argument("--source", required=True, help="Adapter name (e.g. slack, ticket).")
    p_ingest.add_argument("--record", required=True, help="Path to a JSON record file.")
    p_ingest.set_defaults(func=cmd_ingest)

    return parser


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse arguments, dispatch to a command, never leak a traceback."""
    parser = build_parser()
    args = parser.parse_args(argv)

    handler = getattr(args, "func", None)
    if handler is None:
        parser.print_help()
        return 0

    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    _apply_store_override(args)

    try:
        return int(handler(args))
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        print("interrupted", file=sys.stderr)
        return 130
    except SystemExit as exc:
        # Raised by helpers such as _read_json_file with a friendly message.
        code = exc.code
        if isinstance(code, str):
            print(f"error: {code}", file=sys.stderr)
            return 2
        return int(code or 0)
    except Exception as exc:  # noqa: BLE001 - report, never traceback-dump
        print(f"error: {_message(exc)}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover - module entry point
    raise SystemExit(main())
