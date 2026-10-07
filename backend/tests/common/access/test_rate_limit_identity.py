"""The rate limiter keys a signed-in caller by principal and an anonymous one by IP.

Keying by source IP alone put a browser, the CLI and agents behind one address in a
single GET bucket, and the owner's browser was refused on page load (SUP-41).
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request
from webbpulse.testing import make_request_context_headers

from app.common.api.middleware import rate_limiter

SHARED_IP = "198.51.100.40"


def _headers(*, sub: str | None = None, bearer: str | None = None) -> dict[str, str]:
    """Request context headers for one caller behind the shared address."""
    extra = {"authorizer": {"jwt": {"claims": {"sub": sub}}}} if sub else None
    headers = make_request_context_headers(SHARED_IP, extra=extra)
    if bearer:
        headers["authorization"] = f"Bearer {bearer}"
    return headers


def _request(headers: dict[str, str]) -> Request:
    """A bare request carrying `headers`."""
    raw = [(name.lower().encode(), value.encode()) for name, value in headers.items()]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": raw, "query_string": b""})


class _CountingLimiter:
    """An in-memory stand-in for `RateLimiter.check`, counting per identity."""

    def __init__(self) -> None:
        """Start with no counts."""
        self.counts: dict[str, int] = {}

    def check(self, identity: str, *, limit: int, window_seconds: int) -> Any:
        """Count one request and allow it while the identity is within `limit`."""
        from webbpulse.ratelimit import RateLimitDecision

        count = self.counts.get(identity, 0) + 1
        self.counts[identity] = count
        return RateLimitDecision(
            allowed=count <= limit,
            limit=limit,
            remaining=max(limit - count, 0),
            reset_after=window_seconds,
            window_seconds=window_seconds,
        )


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """One GET route behind the product's class limits alone, with a GET allowance of two."""
    from app.common.core.config import settings

    monkeypatch.setattr(rate_limiter, "rate_limiting_enabled", lambda: True)
    monkeypatch.setattr(settings, "RATE_LIMIT_GET_REQUESTS_PER_MINUTE", 2)
    limiters = {limit_class.name: _CountingLimiter() for limit_class in rate_limiter.limit_classes()}
    app = FastAPI()
    app.middleware("http")(rate_limiter.build_rate_limit_middleware(limiters=limiters, tiers=None))

    @app.get("/api/workspaces")
    async def workspaces() -> dict[str, bool]:
        """A read route."""
        return {"ok": True}

    return TestClient(app)


def test_a_verified_user_keys_by_sub() -> None:
    """Two users behind one address get distinct identities."""
    alice = rate_limiter.rate_limit_identity(_request(_headers(sub="alice")))
    bob = rate_limiter.rate_limit_identity(_request(_headers(sub="bob")))
    assert alice == "user:alice"
    assert bob == "user:bob"


def test_a_key_shaped_bearer_stays_on_the_ip() -> None:
    """An unverified API key cannot buy its own bucket; the middleware runs before verification."""
    key = "wpk_" + "b" * 43
    assert rate_limiter.rate_limit_identity(_request(_headers(bearer=key))) == SHARED_IP


def test_an_anonymous_caller_keys_by_ip() -> None:
    """No claims and no API key stays on the source IP."""
    assert rate_limiter.rate_limit_identity(_request(_headers())) == SHARED_IP
    assert rate_limiter.rate_limit_identity(_request(_headers(bearer="eyJ.not.verified"))) == SHARED_IP


def test_two_users_behind_one_ip_get_separate_buckets(client: TestClient) -> None:
    """Spending one user's GET allowance leaves the other user's untouched."""
    for _ in range(2):
        assert client.get("/api/workspaces", headers=_headers(sub="alice")).status_code == 200
    assert client.get("/api/workspaces", headers=_headers(sub="alice")).status_code == 429
    assert client.get("/api/workspaces", headers=_headers(sub="bob")).status_code == 200


def test_anonymous_callers_behind_one_ip_share_a_bucket(client: TestClient) -> None:
    """Anonymous traffic is still limited per address."""
    for _ in range(2):
        assert client.get("/api/workspaces", headers=_headers()).status_code == 200
    assert client.get("/api/workspaces", headers=_headers()).status_code == 429
    assert client.get("/api/workspaces", headers=_headers(sub="alice")).status_code == 200
