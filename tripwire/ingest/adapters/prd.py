"""Product requirements document (PRD) adapter.

PRDs are the richest source of explicit dependencies: they state which systems a
project uses, which assumptions a decision rests on, and which facts support those
assumptions.  Structured ``claims`` on a PRD are therefore recorded as claims from
the document itself (``Document -STATES-> Fact``), which is exactly the provenance
chain an explanation walks back through.
"""

from __future__ import annotations

from typing import Any, Mapping

from ..base import SourceAdapter, SourceRecord

__all__ = ["PrdAdapter"]


class PrdAdapter(SourceAdapter):
    """Turn a PRD payload into a ``Document`` (``doc_type='prd'``) record."""

    name = "prd"
    source_system = "prd"
    label = "Document"
    default_doc_type = "prd"
    description = "A product requirements document describing scope, decisions and dependencies."
    input_shape = {
        "external_id": "required - document id, e.g. 'NWL-PRD-001'",
        "title": "required - the document title",
        "summary": "optional - short abstract",
        "body": "optional - full document body (fallback: 'text')",
        "sections": "optional - list of {heading, body} objects, preserved as metadata",
        "author": "optional - document owner",
        "version": "optional - document version string",
        "timestamp": "optional - publication instant",
        "mentions": "optional - systems/projects/people the PRD concerns",
        "claims": "optional - structured claims [{subject, attribute, value, ...}]",
        "confidence": "optional - 0..1 extraction confidence (default 0.9)",
    }

    def to_record(self, payload: Mapping[str, Any]) -> SourceRecord:
        """Validate and normalise a PRD payload."""
        external_id = str(self.require(payload, "external_id", kind=self.name)).strip()
        title = self.first_text(payload, "title", "name")
        if not title:
            raise_ = self.require(payload, "title", kind=self.name)
            title = str(raise_)

        summary = self.first_text(payload, "summary", "abstract")
        body = self.first_text(payload, "body", "text", "content")
        sections = payload.get("sections")
        if isinstance(sections, (list, tuple)):
            rendered = "\n\n".join(
                f"{item.get('heading', '')}\n{item.get('body', '')}".strip()
                for item in sections
                if isinstance(item, Mapping)
            )
            body = (body + "\n\n" + rendered).strip() if body else rendered
        text = body or summary or title

        author = payload.get("author") or payload.get("owner")
        return SourceRecord(
            source_system=self.source_system,
            external_id=external_id,
            label=self.label,
            doc_type=self.default_doc_type,
            text=text,
            title=title,
            author=str(author).strip() if author else None,
            timestamp=self.normalise_timestamp(
                payload.get("timestamp") or payload.get("published_at") or payload.get("created_at")
            ),
            url=payload.get("url"),
            status=str(payload["status"]).strip() if payload.get("status") else None,
            mentions=self.name_list(payload.get("mentions")),
            claims=self.claim_list(payload.get("claims")),
            confidence=float(payload.get("confidence") or 0.9),
            metadata={
                "version": payload.get("version"),
                "summary": summary or None,
                "section_count": len(sections) if isinstance(sections, (list, tuple)) else 0,
                "approvers": payload.get("approvers"),
            },
            raw=dict(payload),
        )
