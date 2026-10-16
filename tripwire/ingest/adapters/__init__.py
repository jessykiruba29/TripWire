"""Bundled source adapters.

Four adapters cover the required sources (spec S5): Slack messages, tickets, PRDs
and meeting notes.  Each one is a thin, validated mapper from a **documented JSON
input shape** to a :class:`tripwire.ingest.base.SourceRecord`; all provenance,
resolution, de-duplication and review-status handling is shared by the pipeline, so
adding a fifth source means writing one small class and registering it.
"""

from __future__ import annotations

from .meeting_notes import MeetingNotesAdapter
from .prd import PrdAdapter
from .slack import SlackAdapter
from .tickets import TicketAdapter

__all__ = ["SlackAdapter", "TicketAdapter", "PrdAdapter", "MeetingNotesAdapter"]
