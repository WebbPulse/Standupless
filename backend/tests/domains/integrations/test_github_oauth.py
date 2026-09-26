"""The user authorization calls, driven against a fake GitHub transport.

Pins that a refused code is a failure whatever status carries it, that the
installation list is paged, and that the token is revoked once it has been used.
"""

from __future__ import annotations

import json
from typing import Any, Iterator

import httpx
import pytest

from app.domains.integrations import github_oauth


@pytest.fixture
def credentials(github_env: None) -> Iterator[None]:
    """The App's client id and secret, set by the shared GitHub fixture."""
    yield


def _client(handler: Any) -> httpx.Client:
    """A client whose every request is answered by `handler`."""
    return httpx.Client(transport=httpx.MockTransport(handler))


def _github(pages: list[list[int]], seen: list[str], *, token_body: dict[str, Any] | None = None) -> Any:
    """A handler answering the code exchange, the paged installation list and the revocation."""

    def handler(request: httpx.Request) -> httpx.Response:
        """Route one request by its path, recording what was asked."""
        seen.append(f"{request.method} {request.url.path}")
        if request.url.path == "/login/oauth/access_token":
            return httpx.Response(200, json=token_body if token_body is not None else {"access_token": "user-token"})
        if request.url.path == "/user/installations":
            assert request.headers["Authorization"] == "Bearer user-token"
            page = int(request.url.params["page"])
            ids = pages[page - 1] if page <= len(pages) else []
            return httpx.Response(200, json={"installations": [{"id": value} for value in ids]})
        if request.url.path.endswith("/token"):
            assert json.loads(request.content) == {"access_token": "user-token"}
            return httpx.Response(204)
        return httpx.Response(404)

    return handler


def test_configured_needs_the_client_id_and_secret(credentials: None) -> None:
    """Both halves of the client credential are present in the test environment."""
    assert github_oauth.configured()


def test_a_reachable_installation_is_found_across_pages_and_the_token_revoked(credentials: None) -> None:
    """The second page holds the installation, and the token is revoked after the read."""
    seen: list[str] = []
    client = _client(_github([list(range(1, 101)), [44551122]], seen))

    assert github_oauth.user_can_reach("a-code", "44551122", client=client)
    assert seen[0] == "POST /login/oauth/access_token"
    assert seen.count("GET /user/installations") == 2
    assert seen[-1] == "DELETE /applications/Iv1.testclientid/token"


def test_an_unreachable_installation_answers_false(credentials: None) -> None:
    """An installation the person cannot see is a clear no, not an error."""
    seen: list[str] = []

    assert not github_oauth.user_can_reach("a-code", "44551122", client=_client(_github([[7]], seen)))
    assert seen[-1] == "DELETE /applications/Iv1.testclientid/token"


def test_a_refused_code_is_an_error_even_with_a_200(credentials: None) -> None:
    """GitHub refuses a spent or forged code with a 200 carrying an error, which must not read as a token."""
    seen: list[str] = []
    client = _client(_github([], seen, token_body={"error": "bad_verification_code"}))

    with pytest.raises(github_oauth.OAuthError):
        github_oauth.user_can_reach("spent", "44551122", client=client)
    assert seen == ["POST /login/oauth/access_token"]


def test_a_refused_installation_read_is_an_error(credentials: None) -> None:
    """A failing read is no answer rather than a no, so the caller falls back instead of refusing."""

    def handler(request: httpx.Request) -> httpx.Response:
        """Exchange the code, then refuse the read."""
        if request.url.path == "/login/oauth/access_token":
            return httpx.Response(200, json={"access_token": "user-token"})
        if request.url.path == "/user/installations":
            return httpx.Response(502)
        return httpx.Response(204)

    with pytest.raises(github_oauth.OAuthError):
        github_oauth.user_can_reach("a-code", "44551122", client=_client(handler))
