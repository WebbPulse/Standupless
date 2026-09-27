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

Containment is the package's from webbpulse 0.49.0: `webbpulse.http.create_app`
installs `ExceptionGroupMiddleware` beneath `ServerErrorMiddleware` on every
application it builds. What is pinned here is that this product's own applications,
which `build_domain_app` assembles through `create_app` with the rate limiter added
inside it, actually carry that guard and answer rather than die.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from app.common.api.middleware.rate_limiter import reset_rate_limit_middleware


@pytest.fixture(autouse=True)
def _fresh_middleware() -> Any:
    """Rebuild the rate limiter around each test so settings are read fresh."""
    reset_rate_limit_middleware()
    yield
    reset_rate_limit_middleware()


def _app_raising(exception: BaseException) -> Any:
    """An application built the deployed way whose `/boom` route raises `exception`."""
    from app.common.composition.wiring import build_domain_app

    app = build_domain_app("planning")
    router = APIRouter()

    @router.get("/boom")
    def boom() -> dict[str, str]:
        """Fail the way a record model rejecting a stored value fails."""
        raise exception

    app.include_router(router)
    return app


def test_the_guard_is_installed_by_create_app() -> None:
    """Every application this product builds carries the package's group guard."""
    from webbpulse.http import ExceptionGroupMiddleware

    from app.common.composition.wiring import build_domain_app

    app = build_domain_app("planning")
    stack: Any = app.build_middleware_stack()
    for _ in range(32):
        if isinstance(stack, ExceptionGroupMiddleware):
            break
        stack = getattr(stack, "app", None)
        if stack is None:
            break
    assert isinstance(stack, ExceptionGroupMiddleware)


def test_an_exception_group_is_contained(monkeypatch: pytest.MonkeyPatch) -> None:
    """The deployed shape: tracing turns the failure into an `ExceptionGroup`.

    Raising a multi-leaf group directly is what reproduces the staging crash, because
    Starlette collapses a single-leaf group but lets a wider one through, and no
    FastAPI handler is registered against `ExceptionGroup`.
    """
    monkeypatch.setenv("ENABLE_RATE_LIMITING", "false")
    group = ExceptionGroup("unhandled errors in a TaskGroup", [ValueError("kaboom"), ValueError("again")])
    client = TestClient(_app_raising(group), raise_server_exceptions=False)
    response = client.get("/boom")
    assert response.status_code == 500
    body = response.json()
    assert body["success"] is False
    assert body["status"] == 500


def test_the_app_keeps_serving_after_a_group(monkeypatch: pytest.MonkeyPatch) -> None:
    """Containment is worth having only if the next request on that worker still answers."""
    monkeypatch.setenv("ENABLE_RATE_LIMITING", "false")
    group = ExceptionGroup("unhandled errors in a TaskGroup", [ValueError("kaboom"), ValueError("again")])
    client = TestClient(_app_raising(group), raise_server_exceptions=False)
    assert client.get("/boom").status_code == 500
    assert client.get("/health").status_code == 200
    assert client.get("/boom").status_code == 500


def test_a_successful_request_is_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    """Containment must not change the ordinary path."""
    monkeypatch.setenv("ENABLE_RATE_LIMITING", "false")
    from app.common.composition.wiring import build_domain_app

    app = build_domain_app("planning")
    router = APIRouter()

    @router.get("/fine")
    def fine() -> dict[str, str]:
        """Answer normally."""
        return {"status": "ok"}

    app.include_router(router)
    client = TestClient(app)
    response = client.get("/fine")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
