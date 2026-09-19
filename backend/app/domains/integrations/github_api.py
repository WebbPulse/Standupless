"""The smallest GitHub App client this product needs, and nothing more.

Waits on an upstream surface. Minting an installation token from an App private key
is the same sequence in every product that installs a GitHub App: a short lived
RS256 App JWT signed with the private key, then an exchange of that JWT for an
installation token good for an hour. `webbpulse.integrations.github` should own it.
Until it does, this module is the local shim, deliberately kept to the four calls
M5 makes rather than growing into a general client.

No token is ever stored or logged. A token is minted for one unit of work and
discarded, which is why nothing here caches: the caller is a queue consumer handling
one delivery, and a cache that outlived the invocation would be a credential sitting
in a warm container for no gain.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Mapping, Sequence

import httpx
import jwt

from app.common.core.config import settings

_log = logging.getLogger(__name__)

API_ROOT = "https://api.github.com"

ACCEPT = "application/vnd.github+json"

API_VERSION = "2022-11-28"

APP_JWT_TTL_SECONDS = 540
"""Nine minutes. GitHub refuses an App JWT claiming more than ten."""

TIMEOUT_SECONDS = 10.0


class GithubError(Exception):
    """GitHub did not answer, or answered a status this product cannot act on."""


class GithubNotConfigured(GithubError):
    """This environment has no GitHub App credentials in its secret."""


def app_jwt() -> str:
    """A short lived JWT proving this is the App, signed with its private key.

    `iat` is backdated by a minute because GitHub rejects a token whose issue time
    is ahead of its own clock, and a Lambda's clock can be slightly fast.
    """
    app_id = settings.GITHUB_APP_ID
    private_key = settings.GITHUB_PRIVATE_KEY
    if not app_id or not private_key:
        raise GithubNotConfigured("the GitHub App credentials are not in this environment's secret")
    now = int(time.time())
    return jwt.encode(
        {"iat": now - 60, "exp": now + APP_JWT_TTL_SECONDS, "iss": app_id},
        private_key,
        algorithm="RS256",
    )


def _request(
    method: str,
    path: str,
    *,
    token: str,
    json: Mapping[str, Any] | None = None,
    params: Mapping[str, Any] | None = None,
    client: httpx.Client | None = None,
) -> Any:
    """One GitHub call, raising `GithubError` on anything but a success.

    The response body is returned parsed and the token never appears in a log line:
    a failure logs the method, the path and the status, which is what an operator
    needs and is all of it that is safe to keep.
    """
    headers = {
        "Accept": ACCEPT,
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": API_VERSION,
    }
    owned = client is None
    http = client if client is not None else httpx.Client(timeout=TIMEOUT_SECONDS)
    try:
        response = http.request(method, f"{API_ROOT}{path}", headers=headers, json=json, params=params)
    except httpx.HTTPError as error:
        raise GithubError(f"{method} {path} did not answer") from error
    finally:
        if owned:
            http.close()
    if response.status_code >= 400:
        _log.warning(
            "GitHub refused a call.",
            extra={
                "event": "integrations.github.error",
                "method": method,
                "path": path,
                "status": response.status_code,
            },
        )
        raise GithubError(f"{method} {path} answered {response.status_code}")
    if not response.content:
        return None
    return response.json()


def installation_token(installation_id: str, *, client: httpx.Client | None = None) -> str:
    """An installation access token, good for an hour and never stored."""
    body = _request(
        "POST",
        f"/app/installations/{installation_id}/access_tokens",
        token=app_jwt(),
        client=client,
    )
    token = str((body or {}).get("token", ""))
    if not token:
        raise GithubError("the installation token exchange answered no token")
    return token


def get_installation(installation_id: str, *, client: httpx.Client | None = None) -> Mapping[str, Any]:
    """One installation's own record, read with the App JWT rather than its token."""
    body = _request("GET", f"/app/installations/{installation_id}", token=app_jwt(), client=client)
    if not isinstance(body, dict):
        raise GithubError("the installation read answered no object")
    return body


def list_installation_repositories(token: str, *, client: httpx.Client | None = None) -> list[Mapping[str, Any]]:
    """Every repository an installation covers, paged to the end.

    Paged rather than capped because a missing repository means its branches link no
    issues, which is a silent wrong answer rather than a visible one.
    """
    repositories: list[Mapping[str, Any]] = []
    page = 1
    while page <= 20:
        body = _request(
            "GET",
            "/installation/repositories",
            token=token,
            params={"per_page": 100, "page": page},
            client=client,
        )
        batch = list((body or {}).get("repositories", []))
        repositories.extend(item for item in batch if isinstance(item, dict))
        if len(batch) < 100:
            break
        page += 1
    return repositories


def create_comment(
    token: str,
    repository_full_name: str,
    issue_number: int,
    body: str,
    *,
    client: httpx.Client | None = None,
) -> str:
    """Post one pull request comment, answering its id."""
    answer = _request(
        "POST",
        f"/repos/{repository_full_name}/issues/{issue_number}/comments",
        token=token,
        json={"body": body},
        client=client,
    )
    return str((answer or {}).get("id", ""))


def update_comment(
    token: str,
    repository_full_name: str,
    comment_id: str,
    body: str,
    *,
    client: httpx.Client | None = None,
) -> None:
    """Edit a comment this product already posted, rather than posting a second."""
    _request(
        "PATCH",
        f"/repos/{repository_full_name}/issues/comments/{comment_id}",
        token=token,
        json={"body": body},
        client=client,
    )


def create_check_run(
    token: str,
    repository_full_name: str,
    head_sha: str,
    *,
    conclusion: str,
    title: str,
    summary: str,
    client: httpx.Client | None = None,
) -> str:
    """Set the check run reporting whether this pull request links an issue."""
    answer = _request(
        "POST",
        f"/repos/{repository_full_name}/check-runs",
        token=token,
        json={
            "name": "Standupless",
            "head_sha": head_sha,
            "status": "completed",
            "conclusion": conclusion,
            "output": {"title": title, "summary": summary},
        },
        client=client,
    )
    return str((answer or {}).get("id", ""))


def install_url(state: str) -> str:
    """Where a workspace admin is sent to install the App.

    Built from the slug rather than the App id because the slug is what the public
    install path takes, and it is a configuration value rather than a secret.
    """
    slug = settings.GITHUB_APP_SLUG
    if not slug:
        raise GithubNotConfigured("this environment has no GitHub App slug")
    return f"https://github.com/apps/{slug}/installations/new?state={state}"


def repository_names(repositories: Sequence[Mapping[str, Any]]) -> list[str]:
    """The full names of a repository list, for a log line that names no token."""
    return [str(item.get("full_name", "")) for item in repositories if item.get("full_name")]
