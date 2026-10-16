"""``python -m tripwire`` - the Tripwire command-line interface.

Delegates to :func:`tripwire.cli.main`, so ``python -m tripwire`` and
``python -m tripwire.cli`` are identical.
"""

from __future__ import annotations

from .cli import main

if __name__ == "__main__":  # pragma: no cover - module entry point
    raise SystemExit(main())
