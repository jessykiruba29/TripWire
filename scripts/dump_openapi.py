"""Write ``docs/openapi.json`` from the Tripwire FastAPI application.

Usage::

    python scripts/dump_openapi.py

Keeps the checked-in OpenAPI document in sync with the code.  The app is built
with the configured settings (defaulting to the offline JSON/memory store), so
the script needs no external service.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tripwire.api.app import create_app  # noqa: E402  (path set up above)


def main() -> int:
    """Build the app, dump its OpenAPI schema to ``docs/openapi.json``."""
    application = create_app()
    schema = application.openapi()
    output = ROOT / "docs" / "openapi.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(schema, indent=2), encoding="utf-8")
    print(f"wrote {output} ({len(schema.get('paths', {}))} paths)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
