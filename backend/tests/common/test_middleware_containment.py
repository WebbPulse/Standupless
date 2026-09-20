"""An unhandled route exception must not reach the server and end the worker.

Standupless deploys one uvicorn process per execution environment behind the Lambda
Web Adapter, so an exception that escapes the ASGI application does not fail one
request: it kills the worker, and every other request sharing that environment dies
with it. API Gateway reports those as `INTEGRATION_FAILURE` on unrelated paths, which
is how a single bad ephemeral user address turned into 500s on
`GET /api/auth/passkeys/availability` and on CORS preflights during the first full
staging e2e run.

`BaseHTTPMiddleware` is what makes the escape possible: it re-raises inside the task
group it runs the downstream application in, and with the OpenTelemetry ASGI
middleware also on the stack the result arrives as an `ExceptionGroup` that no
FastAPI exception handler matches.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.common.api.middleware.rate_limiter import reset_rate_limit_middleware


@pytest.fixture(autouse=True)
def _fresh_middleware() -> Any:
    """Rebuild the rate limiter around each test so settings are read fresh."""
    reset_rate_limit_middleware()
    yield
    reset_rate_limit_middleware()


def _app_raising(exception: BaseException) -> FastAPI:
    """An application wired like a deployed one whose route raises `exception`."""
    from app.common.api.middleware import rate_limit_middleware

    app = FastAPI()
    app.middleware("http")(rate_limit_middleware)

    @app.get("/boom")
    def boom() -> dict[str, str]:
        """Fail the way a record model rejecting a stored value fails."""
        raise exception

    return app


def test_an_exception_group_is_contained(monkeypatch: pytest.MonkeyPatch) -> None:
    """The deployed shape: tracing turns the failure into an `ExceptionGroup`.

    Raising one directly is what reproduces the staging crash, because no FastAPI
    handler is registered against `ExceptionGroup` and the server ends the worker
    rather than answering.
    """
    monkeypatch.setenv("ENABLE_RATE_LIMITING", "false")
    group = ExceptionGroup("unhandled errors in a TaskGroup", [ValueError("kaboom")])
    client = TestClient(_app_raising(group), raise_server_exceptions=False)
    response = client.get("/boom")
    assert response.status_code == 500
    assert response.json()["error_code"] == "INTERNAL_ERROR"


def test_a_plain_exception_still_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    """Containment must not swallow what FastAPI's own handlers already render.

    The route tests that assert a failed write left nothing behind drive the
    application through a `TestClient` that re-raises, so catching every exception
    here would turn a real assertion about transactional behaviour into a silent
    500. Only the group, which no handler matches, is contained.
    """
    monkeypatch.setenv("ENABLE_RATE_LIMITING", "false")
    client = TestClient(_app_raising(ValueError("kaboom")))
    with pytest.raises(ValueError):
        client.get("/boom")


def test_a_successful_request_is_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    """Containment must not change the ordinary path."""
    monkeypatch.setenv("ENABLE_RATE_LIMITING", "false")
    from app.common.api.middleware import rate_limit_middleware

    app = FastAPI()
    app.middleware("http")(rate_limit_middleware)

    @app.get("/fine")
    def fine() -> dict[str, str]:
        """Answer normally."""
        return {"status": "ok"}

    client = TestClient(app)
    response = client.get("/fine")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
