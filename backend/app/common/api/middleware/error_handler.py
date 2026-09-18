"""Error handlers, delegating to the shared `webbpulse` envelope.

Every error response in this API is the org standard envelope, including the
unmatched route 404 and any other raw Starlette or FastAPI error::

    {"success": false, "status": 404, "message": "...", "request_id": "...",
     "error_code": "NOT_FOUND"}

A 422 carries the same fields plus a flat `details` list of
`{field, message, type}` entries.
"""

from typing import Any

from fastapi import FastAPI

NOT_FOUND_MESSAGE = "Resource not found"

CONFLICT_MESSAGE = "Resource already exists or was modified concurrently"

INTERNAL_ERROR_MESSAGE = "Internal server error"


def error_handler_options() -> dict[str, Any]:
    """Standupless's error handler arguments, shared by `create_app` and the suite.

    `error_envelope="detailed"` is the org standard shape and implies `error_codes`
    and `validation_details`. Both are passed explicitly so the intent survives a
    change to the package default.
    """
    from webbpulse.http import DynamoDBErrorHandlerOptions

    return {
        "error_envelope": "detailed",
        "error_codes": True,
        "validation_details": True,
        "dynamodb_handlers": True,
        "dynamodb_error_handlers": DynamoDBErrorHandlerOptions(
            not_found_message=NOT_FOUND_MESSAGE,
            conflict_message=CONFLICT_MESSAGE,
            internal_error_message=INTERNAL_ERROR_MESSAGE,
        ),
    }


def register_error_handlers(app: FastAPI) -> None:
    """Install the shared handlers on an application `create_app` did not build."""
    from webbpulse.http import register_error_handlers as _register

    _register(app, **error_handler_options())
