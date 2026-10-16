"""Ticket adapter (Jira-style issue records).

Accepts a ticket as a JSON record: id, summary, description, reporter, assignee,
resolution and status.  Tickets become ``Document`` nodes with ``doc_type='ticket'``
so they share the one provenance path with PRDs and meeting notes while remaining
filterable.  The resolver is recorded with a ``RESOLVED`` edge, which is the
strongest contribution signal the expert finder uses.
"""

from __future__ import annotations

from typing import Any, Mapping

from ..base import SourceAdapter, SourceRecord

__all__ = ["TicketAdapter"]


class TicketAdapter(SourceAdapter):
    """Turn a ticket payload into a ``Document`` (``doc_type='ticket'``) record."""

    name = "ticket"
    source_system = "ticket"
    label = "Document"
    default_doc_type = "ticket"
    description = "A support, incident or engineering ticket with a resolver."
    input_shape = {
        "external_id": "required - the ticket key/id, e.g. 'NWL-2312'",
        "summary": "required - the ticket summary (fallback: 'title', 'text')",
        "description": "optional - the full description body",
        "reporter": "optional - who raised it",
        "assignee": "optional - who worked on it",
        "resolved_by": "optional - who closed it (recorded as the RESOLVED edge)",
        "status": "optional - provider status, e.g. 'done', 'open', 'in_progress'",
        "timestamp": "optional - created or updated instant",
        "mentions": "optional - list of entity names the ticket concerns",
        "claims": "optional - structured claims [{subject, attribute, value, ...}]",
        "url": "optional - link to the ticket",
        "confidence": "optional - 0..1 extraction confidence (default 0.85)",
    }

    def to_record(self, payload: Mapping[str, Any]) -> SourceRecord:
        """Validate and normalise a ticket payload."""
        external_id = str(
            payload.get("external_id") or payload.get("key") or payload.get("ticket_id") or ""
        ).strip()
        if not external_id:
            raise_ = self.require(payload, "external_id", kind=self.name)
            external_id = str(raise_).strip()

        summary = self.first_text(payload, "summary", "title", "name")
        description = self.first_text(payload, "description", "body", "text")
        if not summary and not description:
            raise_ = self.require(payload, "summary", kind=self.name)
            summary = str(raise_)
        text = description or summary

        resolver = payload.get("resolved_by") or payload.get("assignee") or payload.get("resolver")
        reporter = payload.get("reporter") or payload.get("created_by") or payload.get("author")
        return SourceRecord(
            source_system=self.source_system,
            external_id=external_id,
            label=self.label,
            doc_type=self.default_doc_type,
            text=text,
            title=summary or f"Ticket {external_id}",
            author=str(reporter).strip() if reporter else None,
            timestamp=self.normalise_timestamp(
                payload.get("timestamp") or payload.get("created_at") or payload.get("updated_at")
            ),
            url=payload.get("url"),
            status=str(payload["status"]).strip() if payload.get("status") else None,
            resolved=str(resolver).strip() if resolver else None,
            mentions=self.name_list(payload.get("mentions")),
            claims=self.claim_list(payload.get("claims")),
            confidence=float(payload.get("confidence") or 0.85),
            metadata={
                "priority": payload.get("priority"),
                "labels": payload.get("labels"),
                "component": payload.get("component"),
                "sprint": payload.get("sprint"),
                "resolution": payload.get("resolution"),
            },
            raw=dict(payload),
        )
