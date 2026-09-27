"""API key and MCP traffic fails open when the rate limiter's store is unavailable.

The owner's decision in design section 8: an outage of the counter table must cost
availability nothing, so a key or MCP caller is served, and the failure is visible as
the package's `rate_limit_failed_open` WARNING rather than as a 5xx or a 429.

The limiter is switched on here, since the test environment otherwise runs without
it, and every counter write is made to raise the error an unavailable table gives.
"""

from __future__ import annotations

import logging
from typing import Any, Iterator

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

from app.common.api.middleware import rate_limiter
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import MEMBER, OWNER, add_member, make_team, make_workspace

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"


def _unavailable(*_args: Any, **_kwargs: Any) -> Any:
    """Raise what a counter write against a missing or unreachable table raises."""
    raise ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "Requested resource not found"}},
        "UpdateItem",
    )


@pytest.fixture
def client(repositories: Any, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """Every domain, with the limiter on and its store failing on every call."""
    from webbpulse.ratelimit import RateLimiter

    from app.common.api.dependencies.repositories import bind_repositories

    monkeypatch.setattr(rate_limiter, "rate_limiting_enabled", lambda: True)
    monkeypatch.setattr(RateLimiter, "update", _unavailable)
    monkeypatch.setattr(RateLimiter, "put", _unavailable)
    rate_limiter.reset_rate_limit_middleware()

    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_team(repositories, WORKSPACE, TEAM, "ABC")

    app = build_domain_app(list(DOMAINS.values()))
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client
    rate_limiter.reset_rate_limit_middleware()


def _key(repositories: Any) -> str:
    """A member's key carrying every scope, as an integration would hold one."""
    from webbpulse.identity.api_keys import mint

    from app.common.db.dynamo.api_keys import API_KEY_SCOPES

    return mint(
        user_id=MEMBER,
        tenant_id=WORKSPACE,
        scopes=API_KEY_SCOPES,
        name="A key",
        store=repositories.api_keys,
        created_by=MEMBER,
    ).plaintext


def _failed_open(caplog: pytest.LogCaptureFixture) -> bool:
    """Whether the limiter logged its fail-open WARNING."""
    return any(
        getattr(record, "rate_limit_failed_open", False) and record.levelno == logging.WARNING
        for record in caplog.records
    )


def test_an_api_key_is_served_and_the_failure_is_logged(
    client: TestClient, repositories: Any, caplog: pytest.LogCaptureFixture
) -> None:
    """A REST read and write both succeed while the counter table is down."""
    secret = _key(repositories)
    client.headers["authorization"] = f"Bearer {secret}"

    with caplog.at_level(logging.WARNING):
        listed = client.get(f"/api/workspaces/{WORKSPACE}/teams")
        created = client.post(f"/api/workspaces/{WORKSPACE}/issues", json={"team_id": TEAM, "title": "Still up"})

    assert listed.status_code == 200, listed.text
    assert created.status_code == 201, created.text
    assert "ratelimit-policy" not in {name.lower() for name in listed.headers}
    assert _failed_open(caplog)


def test_an_mcp_call_is_served_and_the_failure_is_logged(
    client: TestClient, repositories: Any, caplog: pytest.LogCaptureFixture
) -> None:
    """The MCP handshake succeeds while the counter table is down."""
    secret = _key(repositories)

    with caplog.at_level(logging.WARNING):
        response = client.post(
            "/api/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
            headers={"authorization": f"Bearer {secret}"},
        )

    assert response.status_code == 200, response.text
    assert "result" in response.json()
    assert _failed_open(caplog)
