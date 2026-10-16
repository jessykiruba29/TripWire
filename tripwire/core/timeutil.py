"""Time utilities.

Tripwire uses **ISO-8601 UTC strings** (``YYYY-MM-DDTHH:MM:SSZ``) as the single
wire and storage format for every timestamp.  Storing one canonical format keeps
FalkorDB comparisons, JSON persistence and API responses consistent and makes
bi-temporal interval arithmetic lexicographically correct.

Two distinct clocks are modelled by the graph (see :mod:`tripwire.core.schema`):

* **real-world time** - ``valid_from`` / ``valid_to``: when a claim was true.
* **transaction time** - ``recorded_at`` / ``recorded_to``: when Tripwire knew it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

ISO_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
_DATE_ONLY = "%Y-%m-%d"


def utc_now() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


def to_iso(dt: datetime) -> str:
    """Serialise a datetime to the canonical Tripwire ISO-8601 UTC string."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime(ISO_FORMAT)


def now_iso() -> str:
    """Current time in canonical ISO-8601 UTC form."""
    return to_iso(utc_now())


def parse_iso(value: Any) -> Optional[datetime]:
    """Parse an ISO-8601-ish value into an aware UTC datetime.

    Returns ``None`` for empty/None/unparseable input rather than raising, so
    ingestion of messy third-party timestamps degrades gracefully.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    candidate = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        parsed = None
        for fmt in (ISO_FORMAT, _DATE_ONLY, "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
        if parsed is None:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def iso_or_none(value: Any) -> Optional[str]:
    """Normalise any accepted timestamp representation to canonical form."""
    parsed = parse_iso(value)
    return to_iso(parsed) if parsed else None


def add_days(value: Any, days: float) -> Optional[str]:
    """Return ``value + days`` in canonical form (``None`` if unparseable)."""
    parsed = parse_iso(value)
    if parsed is None:
        return None
    return to_iso(parsed + timedelta(days=days))


def add_hours(value: Any, hours: float) -> Optional[str]:
    """Return ``value + hours`` in canonical form (``None`` if unparseable)."""
    parsed = parse_iso(value)
    if parsed is None:
        return None
    return to_iso(parsed + timedelta(hours=hours))


def within(ts: Any, start: Any, end: Any) -> bool:
    """Half-open interval test ``[start, end)`` with open-ended bounds.

    A ``None`` boundary means "unbounded on that side".  Used by bi-temporal
    queries: ``within(recorded_at, as_of_instant, None)`` asks "was it recorded
    by that instant?".
    """
    moment = parse_iso(ts)
    if moment is None:
        return False
    lo = parse_iso(start)
    hi = parse_iso(end)
    if lo is not None and moment < lo:
        return False
    if hi is not None and moment >= hi:
        return False
    return True


def max_iso(*values: Any) -> Optional[str]:
    """Latest of the supplied timestamps (``None`` ignored)."""
    parsed = [p for p in (parse_iso(v) for v in values) if p is not None]
    return to_iso(max(parsed)) if parsed else None


def min_iso(*values: Any) -> Optional[str]:
    """Earliest of the supplied timestamps (``None`` ignored)."""
    parsed = [p for p in (parse_iso(v) for v in values) if p is not None]
    return to_iso(min(parsed)) if parsed else None
