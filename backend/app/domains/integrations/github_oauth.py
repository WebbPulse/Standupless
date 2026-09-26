"""The user authorization GitHub runs straight after an install, used as proof and discarded.

With "Request user authorization (OAuth) during installation" on, GitHub sends the
browser to the Callback URL with a `code` beside the `installation_id`. Exchanging
that code gives a user access token for the person who just installed, and asking
GitHub which installations that person can reach turns the redirect's spoofable
`installation_id` into one GitHub vouches for on their behalf.

Kept apart from `github_api`, which holds the App side calls and is moving into the
shared package, because this is the user side and stays local. The token is used
for one read, then revoked, and never stored or logged.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.common.core.config import settings

_log = logging.getLogger(__name__)

TOKEN_URL = "https://github.com/login/oauth/access_token"

API_ROOT = "https://api.github.com"

API_VERSION = "2022-11-28"

TIMEOUT_SECONDS = 10.0

MAX_PAGES = 10


class OAuthError(Exception):
    """GitHub did not exchange the code or did not answer the installation read."""


def configured() -> bool:
    """Whether this environment holds the App's client id and client secret."""
    return bool(settings.GITHUB_CLIENT_ID and settings.GITHUB_CLIENT_SECRET)


def _headers(token: str) -> dict[str, str]:
    """The headers for one call made as the user."""
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": API_VERSION,
    }


def _json(response: httpx.Response) -> Any:
    """The parsed body of a response, or an empty object when it is not JSON."""
    try:
        return response.json() if response.content else {}
    except ValueError:
        return {}


def exchange_code(code: str, *, client: httpx.Client) -> str:
    """The user access token a callback `code` stands for, or `OAuthError`.

    GitHub answers a refused code with a 200 carrying an `error` field rather than a
    4xx, so an answer without a token is the failure, whatever its status.
    """
    try:
        response = client.post(
            TOKEN_URL,
            headers={"Accept": "application/json"},
            data={
                "client_id": settings.GITHUB_CLIENT_ID,
                "client_secret": settings.GITHUB_CLIENT_SECRET,
                "code": code,
            },
        )
    except httpx.HTTPError as error:
        raise OAuthError("the code exchange did not answer") from error
    body: Any = _json(response)
    token = str(body.get("access_token", "")) if isinstance(body, dict) else ""
    if response.status_code >= 400 or not token:
        error_code = str(body.get("error", "")) if isinstance(body, dict) else ""
        _log.warning(
            "GitHub refused a user authorization code.",
            extra={"event": "integrations.oauth_exchange_refused", "status": response.status_code, "error": error_code},
        )
        raise OAuthError("the code exchange answered no token")
    return token


def user_installation_ids(token: str, *, client: httpx.Client) -> set[str]:
    """Every installation of this App the token's user can reach, paged to the end."""
    found: set[str] = set()
    for page in range(1, MAX_PAGES + 1):
        try:
            response = client.get(
                f"{API_ROOT}/user/installations",
                headers=_headers(token),
                params={"per_page": 100, "page": page},
            )
        except httpx.HTTPError as error:
            raise OAuthError("the installation read did not answer") from error
        if response.status_code >= 400:
            _log.warning(
                "GitHub refused the user installation read.",
                extra={"event": "integrations.oauth_installations_refused", "status": response.status_code},
            )
            raise OAuthError(f"the installation read answered {response.status_code}")
        body: Any = _json(response)
        batch = body.get("installations", []) if isinstance(body, dict) else []
        found.update(str(item.get("id", "")) for item in batch if isinstance(item, dict) and item.get("id"))
        if len(batch) < 100:
            break
    return found


def revoke(token: str, *, client: httpx.Client) -> None:
    """Revoke a user token this product has finished with, ignoring any failure.

    Best effort: the token expires by itself within hours, so a revocation GitHub
    does not answer is not worth failing an install over.
    """
    try:
        client.request(
            "DELETE",
            f"{API_ROOT}/applications/{settings.GITHUB_CLIENT_ID}/token",
            auth=(settings.GITHUB_CLIENT_ID, settings.GITHUB_CLIENT_SECRET),
            headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION},
            json={"access_token": token},
        )
    except httpx.HTTPError:
        _log.info("Revoking a user token did not answer.", extra={"event": "integrations.oauth_revoke_failed"})


def user_can_reach(code: str, installation_id: str, *, client: httpx.Client | None = None) -> bool:
    """Whether the person behind `code` can reach `installation_id` on GitHub.

    Raises `OAuthError` when GitHub gives no answer either way, which the caller
    treats as no proof rather than as a refusal.
    """
    owned = client is None
    http = client if client is not None else httpx.Client(timeout=TIMEOUT_SECONDS)
    try:
        token = exchange_code(code, client=http)
        try:
            return installation_id in user_installation_ids(token, client=http)
        finally:
            revoke(token, client=http)
    finally:
        if owned:
            http.close()
