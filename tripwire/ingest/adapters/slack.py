"""Slack message adapter.

Accepts one Slack message (or a webhook-shaped equivalent) as a JSON record.  No
live Slack credential is configured in this build, so this is a documented input
shape rather than a connected workspace - see
:attr:`SourceAdapter.integration_type`.
"""

from __future__ import annotations

from typing import Any, Mapping

from ..base import SourceAdapter, SourceRecord

__all__ = ["SlackAdapter"]


class SlackAdapter(SourceAdapter):
    """Turn a Slack message payload into a ``Message`` source record."""

    name = "slack"
    source_system = "slack"
    label = "Message"
    default_doc_type = None
    description = "A Slack message: channel conversation, alert or announcement."
    input_shape = {
        "external_id": "required - the provider message id (used for de-duplication)",
        "text": "required - the message body",
        "channel": "optional - channel name, e.g. '#eu-launch'",
        "author": "optional - display name or handle of the sender",
        "timestamp": "optional - ISO-8601 or Slack-style timestamp",
        "title": "optional - short summary; defaults to a truncation of the body",
        "mentions": "optional - list of entity names the message discusses",
        "claims": "optional - structured claims [{subject, attribute, value, ...}]",
        "thread_id": "optional - thread parent id, preserved as metadata",
        "url": "optional - permalink to the message",
        "confidence": "optional - 0..1 extraction confidence (default 0.8)",
    }

    def to_record(self, payload: Mapping[str, Any]) -> SourceRecord:
        """Validate and normalise a Slack message payload."""
        external_id = str(self.require(payload, "external_id", kind=self.name)).strip()
        text = self.first_text(payload, "text", "body", "message", "content")
        if not text:
            raise_ = self.require(payload, "text", kind=self.name)  # raises with details
            text = str(raise_)
        timestamp = self.normalise_timestamp(
            payload.get("timestamp") or payload.get("ts") or payload.get("sent_at")
        )
        author = payload.get("author") or payload.get("user") or payload.get("username")
        channel = payload.get("channel") or payload.get("channel_name")
        return SourceRecord(
            source_system=self.source_system,
            external_id=external_id,
            label=self.label,
            doc_type=None,
            text=text,
            title=str(payload.get("title") or text[:120]),
            author=str(author).strip() if author else None,
            timestamp=timestamp,
            url=payload.get("url") or payload.get("permalink"),
            channel=str(channel).strip() if channel else None,
            mentions=self.name_list(payload.get("mentions")),
            claims=self.claim_list(payload.get("claims")),
            confidence=float(payload.get("confidence") or 0.8),
            metadata={
                "thread_id": payload.get("thread_id") or payload.get("thread_ts"),
                "priority": payload.get("priority"),
                "reactions": payload.get("reactions"),
            },
            raw=dict(payload),
        )
