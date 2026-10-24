"""A consumer's queue and stream batches are never rate limited (STUP-327).

The Lambda Web Adapter posts every SQS or DynamoDB stream batch to the events path
with no caller behind it, so all of them fell into one anonymous default bucket. A
refused batch was answered 429 inside an invocation Lambda still reports as a
success, and the event source mapping deleted the records unhandled. That is how a
pull request merge into `staging` never moved its `Fixes` issue to On Staging.
"""

from __future__ import annotations

import json
from typing import Any, Mapping

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from webbpulse.events import events_path, register_stream_consumer
from webbpulse.http import REQUEST_CONTEXT_HEADER
from webbpulse.testing import make_request_context_headers

from app.common.api.middleware import rate_limiter

GATEWAY_IP = "198.51.100.41"

PASS_THROUGH = {REQUEST_CONTEXT_HEADER: "null"}


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


def _batch(*bodies: Mapping[str, Any]) -> dict[str, Any]:
    """An SQS event as the adapter posts it, one record per body."""
    return {
        "Records": [
            {"messageId": f"m-{index}", "eventSource": "aws:sqs", "body": json.dumps(dict(body))}
            for index, body in enumerate(bodies)
        ]
    }


@pytest.fixture
def handled() -> list[Mapping[str, Any]]:
    """The records the consumer ran, in order."""
    return []


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, handled: list[Mapping[str, Any]]) -> TestClient:
    """A consumer route and one API route behind the class limits, with a default allowance of one."""
    from app.common.core.config import settings

    monkeypatch.setattr(rate_limiter, "rate_limiting_enabled", lambda: True)
    monkeypatch.setattr(settings, "RATE_LIMIT_REQUESTS_PER_MINUTE", 1)
    limiters = {limit_class.name: _CountingLimiter() for limit_class in rate_limiter.limit_classes()}
    app = FastAPI()
    app.middleware("http")(rate_limiter.build_rate_limit_middleware(limiters=limiters, tiers=None))

    router = APIRouter()
    register_stream_consumer(router, handled.append, guard_gateway=False)
    app.include_router(router)

    @app.post("/api/things")
    async def things() -> dict[str, bool]:
        """A write route a caller reaches through the gateway."""
        return {"ok": True}

    return TestClient(app)


def test_every_pass_through_batch_is_handled_past_the_default_allowance(
    client: TestClient, handled: list[Mapping[str, Any]]
) -> None:
    """Five batches in a minute against an allowance of one all run and report no failures."""
    for index in range(5):
        response = client.post(events_path(), json=_batch({"merge": index}), headers=PASS_THROUGH)
        assert response.status_code == 200, response.text
        assert response.json() == {"batchItemFailures": []}

    assert len(handled) == 5


def test_a_batch_with_no_request_context_header_is_not_counted(
    client: TestClient, handled: list[Mapping[str, Any]]
) -> None:
    """An invocation without the header at all is still a pass-through, not a gateway caller."""
    for _ in range(3):
        assert client.post(events_path(), json=_batch({"push": 1})).status_code == 200

    assert len(handled) == 3


def test_a_gateway_request_to_the_events_path_is_still_counted(client: TestClient) -> None:
    """The exemption needs both halves, so a gateway caller naming the path spends its allowance."""
    headers = make_request_context_headers(GATEWAY_IP)

    assert client.post(events_path(), json=_batch({}), headers=headers).status_code == 200
    assert client.post(events_path(), json=_batch({}), headers=headers).status_code == 429


def test_batches_spend_nothing_of_a_callers_allowance(client: TestClient) -> None:
    """Batches before a gateway write leave its first request allowed and its second refused."""
    for _ in range(3):
        client.post(events_path(), json=_batch({}), headers=PASS_THROUGH)
    headers = make_request_context_headers(GATEWAY_IP)

    assert client.post("/api/things", headers=headers).status_code == 200
    assert client.post("/api/things", headers=headers).status_code == 429


def test_is_event_source_batch_reads_method_path_and_gateway_context() -> None:
    """Only a POST to the events path without a gateway context is a batch."""
    from starlette.requests import Request

    def request(method: str, path: str, headers: Mapping[str, str]) -> Request:
        """A bare request with `headers`."""
        raw = [(name.lower().encode(), value.encode()) for name, value in headers.items()]
        return Request({"type": "http", "method": method, "path": path, "headers": raw, "query_string": b""})

    assert rate_limiter.is_event_source_batch(request("POST", events_path(), PASS_THROUGH))
    assert not rate_limiter.is_event_source_batch(request("GET", events_path(), PASS_THROUGH))
    assert not rate_limiter.is_event_source_batch(request("POST", "/api/things", PASS_THROUGH))
    assert not rate_limiter.is_event_source_batch(
        request("POST", events_path(), make_request_context_headers(GATEWAY_IP))
    )
