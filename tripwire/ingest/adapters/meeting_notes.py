"""Meeting notes adapter.

Meeting notes carry two distinct kinds of evidence: the author (a strong
contribution signal) and the participants (a weaker one, since being listed does
not prove engagement).  The adapter keeps them separate so the expert finder can
weight them differently rather than treating attendance as authorship.
"""

from __future__ import annotations

from typing import Any, Mapping

from ..base import SourceAdapter, SourceRecord

__all__ = ["MeetingNotesAdapter"]


class MeetingNotesAdapter(SourceAdapter):
    """Turn a meeting-notes payload into a ``Document`` (``doc_type='meeting_note'``)."""

    name = "meeting_note"
    source_system = "meeting_note"
    label = "Document"
    default_doc_type = "meeting_note"
    description = "Meeting minutes: decisions taken, risks raised and attendees."
    input_shape = {
        "external_id": "required - note id, e.g. 'NWL-MN-001'",
        "title": "required - meeting title",
        "notes": "required - the note body (fallback: 'body', 'text')",
        "author": "optional - who wrote the notes (recorded as the author)",
        "participants": "optional - attendees; recorded as weaker evidence than authorship",
        "timestamp": "optional - meeting instant",
        "mentions": "optional - systems/projects/people discussed",
        "claims": "optional - structured claims [{subject, attribute, value, ...}]",
        "actions": "optional - action items, preserved as metadata",
        "confidence": "optional - 0..1 extraction confidence (default 0.85)",
    }

    def to_record(self, payload: Mapping[str, Any]) -> SourceRecord:
        """Validate and normalise a meeting-notes payload."""
        external_id = str(self.require(payload, "external_id", kind=self.name)).strip()
        title = self.first_text(payload, "title", "name", "subject")
        notes = self.first_text(payload, "notes", "body", "text", "content", "summary")
        if not notes:
            raise_ = self.require(payload, "notes", kind=self.name)
            notes = str(raise_)

        author = payload.get("author") or payload.get("scribe") or payload.get("organiser")
        return SourceRecord(
            source_system=self.source_system,
            external_id=external_id,
            label=self.label,
            doc_type=self.default_doc_type,
            text=notes,
            title=title or f"Meeting notes {external_id}",
            author=str(author).strip() if author else None,
            timestamp=self.normalise_timestamp(
                payload.get("timestamp") or payload.get("held_at") or payload.get("created_at")
            ),
            url=payload.get("url"),
            mentions=self.name_list(payload.get("mentions")),
            participants=self.name_list(payload.get("participants") or payload.get("attendees")),
            claims=self.claim_list(payload.get("claims")),
            confidence=float(payload.get("confidence") or 0.85),
            metadata={
                "actions": payload.get("actions"),
                "duration_minutes": payload.get("duration_minutes"),
                "series": payload.get("series"),
            },
            raw=dict(payload),
        )
