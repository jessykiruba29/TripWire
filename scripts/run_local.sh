#!/usr/bin/env bash
#
# Start the Tripwire API locally with uvicorn.
#
# Usage:
#   scripts/run_local.sh [memory|json|falkordb] [--no-reload]
#
# With the default backend (falkordb) and no reachable server, Tripwire logs a
# warning and falls back to the JSON store, so this works with zero setup.
set -euo pipefail

STORE="${TRIPWIRE_STORE:-falkordb}"
RELOAD="--reload"

for arg in "$@"; do
    case "$arg" in
        memory|json|falkordb) STORE="$arg" ;;
        --no-reload)          RELOAD="" ;;
        *) echo "unknown argument: $arg" >&2; echo "usage: $0 [memory|json|falkordb] [--no-reload]" >&2; exit 2 ;;
    esac
done

export TRIPWIRE_STORE="$STORE"
HOST="${TRIPWIRE_API_HOST:-127.0.0.1}"
PORT="${TRIPWIRE_API_PORT:-8000}"
STATE_PATH="${TRIPWIRE_STATE_PATH:-data/graph.json}"

echo "Tripwire local API"
echo "  graph backend : $TRIPWIRE_STORE"
echo "  state file    : $STATE_PATH (JSON store / fallback)"
echo "  listening on  : http://$HOST:$PORT"
if [ "$TRIPWIRE_STORE" = "falkordb" ]; then
    echo "  note: if FalkorDB is unreachable, Tripwire warns and falls back to JSON."
fi
if [ "$TRIPWIRE_STORE" = "memory" ]; then
    echo "  note: the in-memory store is ephemeral - state is lost on exit."
fi
echo "  docs          : http://$HOST:$PORT/docs"

# shellcheck disable=SC2086
exec python -m uvicorn tripwire.api.app:app --host "$HOST" --port "$PORT" $RELOAD
