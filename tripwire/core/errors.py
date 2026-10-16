"""Tripwire error taxonomy.

Keeping a small, explicit set of error types lets the HTTP API map failures to
sensible status codes, lets the MCP tools return structured errors instead of
stack traces, and lets the engine degrade gracefully when an *optional* service
(FalkorDB, an LLM provider) is unavailable (spec S16).
"""

from __future__ import annotations

__all__ = [
    "TripwireError",
    "ConfigurationError",
    "StoreUnavailableError",
    "StoreError",
    "NotFoundError",
    "ValidationError",
    "SchemaError",
    "LLMUnavailableError",
    "LLMResponseError",
    "TransitionError",
    "IngestionError",
]

from .schema import SchemaError  # re-exported for a single import site


class TripwireError(Exception):
    """Base class for every Tripwire error.

    Carries an optional machine-readable ``code`` and ``details`` payload so the
    API and MCP layers can return consistent structured errors.
    """

    code = "tripwire_error"
    http_status = 500

    def __init__(self, message: str, *, code: str | None = None, details: dict | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.details = details or {}

    def to_dict(self) -> dict:
        """Structured error body shared by the HTTP API and MCP tools."""
        payload = {"error": self.code, "message": self.message}
        if self.details:
            payload["details"] = self.details
        return payload


class ConfigurationError(TripwireError):
    """Invalid or missing configuration (never includes secret values)."""

    code = "configuration_error"
    http_status = 500


class StoreUnavailableError(TripwireError):
    """The graph database cannot be reached.

    Raised by the FalkorDB adapter so the API can return 503 and the demo can
    fall back to the in-process store rather than crashing.
    """

    code = "store_unavailable"
    http_status = 503


class StoreError(TripwireError):
    """A graph operation failed for a reason other than connectivity."""

    code = "store_error"
    http_status = 500


class NotFoundError(TripwireError):
    """A referenced entity does not exist in the graph."""

    code = "not_found"
    http_status = 404


class ValidationError(TripwireError):
    """Caller-supplied input failed validation."""

    code = "validation_error"
    http_status = 422


class LLMUnavailableError(TripwireError):
    """No LLM is configured or the provider could not be reached.

    Callers must fall back to the deterministic rule engine; the core demo must
    keep working without external AI credentials (spec S3).
    """

    code = "llm_unavailable"
    http_status = 503


class LLMResponseError(TripwireError):
    """The LLM replied but the payload failed validation.

    Never written to the graph as truth (spec S5).
    """

    code = "llm_response_invalid"
    http_status = 502


class TransitionError(TripwireError):
    """An invalid alert/decision status transition was requested."""

    code = "invalid_transition"
    http_status = 409


class IngestionError(TripwireError):
    """A source record could not be ingested."""

    code = "ingestion_error"
    http_status = 400
