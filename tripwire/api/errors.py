"""Consistent error handling for the HTTP API.

Every failure - whether raised by the engine, by Pydantic validation, or by an
unexpected bug - is returned as the same envelope::

    {"error": "<code>", "message": "...", "details": {...}}

``TripwireError`` subclasses carry their own ``code`` and ``http_status``
(:mod:`tripwire.core.errors`), which this module maps straight onto the HTTP
response.  The catch-all handler logs the traceback server-side and returns a
generic message, so no stack trace ever leaks to a client.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from ..core.errors import TripwireError
from ..core.schema import SchemaError

logger = logging.getLogger("tripwire.api")

__all__ = ["FeatureNotAvailable", "envelope", "register_exception_handlers"]


# HTTP status -> machine-readable code for the generic Starlette HTTP exceptions.
_HTTP_CODES: dict[int, str] = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    415: "unsupported_media_type",
    422: "validation_error",
    501: "not_implemented",
    503: "service_unavailable",
}


class FeatureNotAvailable(TripwireError):
    """A documented capability is not present in this build (HTTP 501)."""

    code = "not_implemented"
    http_status = 501


def envelope(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build the canonical error body."""
    return {"error": code, "message": message, "details": details or {}}


def register_exception_handlers(app: FastAPI) -> None:
    """Attach every exception handler the API needs."""

    @app.exception_handler(TripwireError)
    async def _handle_tripwire(request: Request, exc: TripwireError) -> JSONResponse:
        status = int(getattr(exc, "http_status", 500) or 500)
        return JSONResponse(status_code=status, content=envelope(exc.code, exc.message, exc.details))

    @app.exception_handler(SchemaError)
    async def _handle_schema(request: Request, exc: SchemaError) -> JSONResponse:
        # SchemaError derives from ValueError, not TripwireError, but it is still a
        # caller-facing validation failure.
        return JSONResponse(status_code=422, content=envelope("schema_error", str(exc)))

    @app.exception_handler(RequestValidationError)
    async def _handle_request_validation(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=envelope(
                "validation_error",
                "Request validation failed.",
                {"errors": jsonable_encoder(exc.errors())},
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_CODES.get(int(exc.status_code), "http_error")
        return JSONResponse(status_code=int(exc.status_code), content=envelope(code, str(exc.detail)))

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:  # noqa: BLE001
        logger.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content=envelope("internal_error", "An unexpected internal error occurred."),
        )
