"""Deterministic identifier generation and deduplication keys.

Requirement (spec S4): *"Every entity must have a stable identifier ... Avoid
creating duplicate entities when the same fact, person or source is ingested
repeatedly. Use deterministic identifiers or reliable deduplication rules."*

Strategy
--------
* **Human-curated entities** (people, teams, systems, projects, decisions,
  assumptions) get readable slug ids, e.g. ``person:priya-raman``.  Two records
  referring to "Priya Raman" and "priya raman" collapse to one node.
* **Source artifacts** (messages, documents) are keyed by
  ``(source_system, external_id)`` - the provider's own primary key - so
  re-ingesting the same Slack message or ticket is a no-op.
* **Facts** are keyed by a content hash over
  ``(subject, predicate, object, valid_from)``.  Re-stating *the same claim*
  resolves to the same node, while a *contradicting* claim (different object or
  a corrected validity window) deterministically yields a **different** id - so
  both records are preserved side by side, as required by spec S8.

Every generator is pure: the same inputs always produce the same id.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any, Iterable

__all__ = [
    "slug",
    "short_hash",
    "person_id",
    "team_id",
    "system_id",
    "project_id",
    "decision_id",
    "assumption_id",
    "message_id",
    "document_id",
    "event_id",
    "alert_id",
    "fact_id",
    "statement_key",
    "parse_id",
    "id_kind",
]

_SLUG_STRIP = re.compile(r"[^a-z0-9]+")
_SEPARATOR = "\x1f"


def slug(text: Any) -> str:
    """Lowercase, ASCII-folded, hyphen-separated slug for stable ids."""
    if text is None:
        return "unknown"
    normalised = unicodedata.normalize("NFKD", str(text))
    ascii_only = normalised.encode("ascii", "ignore").decode("ascii")
    cleaned = _SLUG_STRIP.sub("-", ascii_only.lower()).strip("-")
    return cleaned or "unknown"


def short_hash(*parts: Any, length: int = 12) -> str:
    """Stable truncated SHA-1 over the given parts.

    Parts are joined with an ASCII unit-separator so ``("ab","c")`` and
    ``("a","bc")`` cannot collide.
    """
    payload = _SEPARATOR.join("" if part is None else str(part) for part in parts)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:length]


# --------------------------------------------------------------------------- #
# Curated entity ids
# --------------------------------------------------------------------------- #
def person_id(name: str) -> str:
    """``person:<slug>`` - deduplicates by name spelling."""
    return f"person:{slug(name)}"


def team_id(name: str) -> str:
    """``team:<slug>``."""
    return f"team:{slug(name)}"


def system_id(name: str) -> str:
    """``system:<slug>``."""
    return f"system:{slug(name)}"


def project_id(name: str) -> str:
    """``project:<slug>``."""
    return f"project:{slug(name)}"


def decision_id(key: str) -> str:
    """``decision:<slug>``."""
    return f"decision:{slug(key)}"


def assumption_id(key: str) -> str:
    """``assumption:<slug>``."""
    return f"assumption:{slug(key)}"


# --------------------------------------------------------------------------- #
# Source artifacts
# --------------------------------------------------------------------------- #
def message_id(source: str, external_id: str) -> str:
    """``message:<source>:<external_id>`` - provider primary key based."""
    return f"message:{slug(source)}:{slug(external_id)}"


def document_id(source: str, external_id: str) -> str:
    """``document:<source>:<external_id>`` - provider primary key based."""
    return f"document:{slug(source)}:{slug(external_id)}"


def event_id(kind: str, *discriminators: Any) -> str:
    """``event:<kind>:<hash>`` - one node per logically distinct event."""
    return f"event:{slug(kind)}:{short_hash(kind, *discriminators)}"


def alert_id(dedupe_key: str) -> str:
    """``alert:<hash>`` derived from the alert deduplication key.

    Because the dedupe key is derived from the *contradiction* rather than the
    triggering request, replaying the same event produces the same alert id and
    therefore does not create a duplicate alert (spec S7/S11).
    """
    return f"alert:{short_hash(dedupe_key)}"


# --------------------------------------------------------------------------- #
# Facts
# --------------------------------------------------------------------------- #
def statement_key(subject: Any, predicate: Any, obj: Any) -> str:
    """Normalised ``subject|predicate|object`` triple, case/space insensitive."""
    return _SEPARATOR.join(
        slug(part) if part is not None else "" for part in (subject, predicate, obj)
    )


def fact_id(
    subject: Any,
    predicate: Any,
    obj: Any,
    valid_from: Any = None,
    *,
    discriminator: Any = None,
) -> str:
    """``fact:<hash>`` for a claim.

    ``valid_from`` participates in the hash: the same attribute asserted for a
    *different* real-world period is a distinct fact (a time-scoped update), not
    an overwrite.  ``discriminator`` lets callers force separation when two
    genuinely independent claims would otherwise hash identically.
    """
    return "fact:" + short_hash(
        statement_key(subject, predicate, obj), valid_from or "", discriminator or ""
    )


# --------------------------------------------------------------------------- #
# Introspection helpers
# --------------------------------------------------------------------------- #
def id_kind(node_id: str) -> str:
    """Return the ``<kind>`` prefix of an id, or ``""`` if it has none."""
    return node_id.split(":", 1)[0] if ":" in str(node_id) else ""


def parse_id(node_id: str) -> tuple[str, str]:
    """Split ``kind:rest`` into ``(kind, rest)``; missing colon yields ``("", id)``."""
    kind, _, rest = str(node_id).partition(":")
    return (kind, rest) if rest else ("", kind)


def merge_ids(*groups: Iterable[str]) -> list[str]:
    """Order-preserving de-duplication across several id iterables."""
    seen: set[str] = set()
    out: list[str] = []
    for group in groups:
        for item in group:
            if item and item not in seen:
                seen.add(item)
                out.append(item)
    return out
