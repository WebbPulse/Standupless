"""The GitHub issue, comment and user calls the two way issue sync makes.

Waits on an upstream surface. `webbpulse.integrations.github.GitHubAppClient`
mints installation tokens and posts issue comments, but has no public call for
reading, creating or updating an issue, setting its labels and assignees, or
reading a user by id, and every product that mirrors issues needs the same ones.
Until it does, this module is the local shim, kept to exactly the calls the sync
makes and taking the installation token from `installation_token`, which is the
one line that changes when the shared client lands.

Rate limits are surfaced rather than slept through. A 429, or a 403 that says the
primary or secondary limit is spent, raises `GithubRateLimited`, the consumer lets
it propagate, and the queue's visibility timeout is the back off: holding a Lambda
open until GitHub's reset would spend the function's whole timeout doing nothing.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping, Sequence

import httpx

from app.domains.integrations import github_api

_log = logging.getLogger(__name__)

TIMEOUT_SECONDS = 10.0


class GithubRateLimited(github_api.GithubError):
    """GitHub asked this installation to slow down."""

    def __init__(self, message: str, *, status: int, retry_after: int | None) -> None:
        """Keep how long GitHub asked for, when it said."""
        super().__init__(message, status=status)
        self.retry_after = retry_after


def installation_token(installation_id: str) -> str:
    """An installation token for one unit of sync work, never stored."""
    return github_api.installation_token(installation_id)


def _rate_limited(response: httpx.Response) -> bool:
    """Whether a refusal is a rate limit rather than a permission problem."""
    if response.status_code == 429:
        return True
    if response.status_code != 403:
        return False
    return response.headers.get("x-ratelimit-remaining") == "0" or "retry-after" in response.headers


def _retry_after(response: httpx.Response) -> int | None:
    """How many seconds GitHub asked for, when it said."""
    raw = response.headers.get("retry-after")
    try:
        return int(raw) if raw is not None else None
    except ValueError:
        return None


def _request(
    method: str,
    path: str,
    *,
    token: str,
    json: Mapping[str, Any] | None = None,
    client: httpx.Client | None = None,
) -> Any:
    """One GitHub call with the installation token, raising on anything but a success.

    The token never reaches a log line; a failure logs the method, the path and
    the status.
    """
    headers = {
        "Accept": github_api.ACCEPT,
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": github_api.API_VERSION,
    }
    owned = client is None
    http = client if client is not None else httpx.Client(timeout=TIMEOUT_SECONDS)
    try:
        response = http.request(method, f"{github_api.API_ROOT}{path}", headers=headers, json=json)
    except httpx.HTTPError as error:
        raise github_api.GithubError(f"{method} {path} did not answer") from error
    finally:
        if owned:
            http.close()
    if _rate_limited(response):
        _log.warning(
            "GitHub rate limited the issue sync.",
            extra={"event": "integrations.sync.rate_limited", "method": method, "path": path},
        )
        raise GithubRateLimited(
            f"{method} {path} was rate limited",
            status=response.status_code,
            retry_after=_retry_after(response),
        )
    if response.status_code >= 400:
        _log.warning(
            "GitHub refused an issue sync call.",
            extra={
                "event": "integrations.sync.github_error",
                "method": method,
                "path": path,
                "status": response.status_code,
            },
        )
        raise github_api.GithubError(f"{method} {path} answered {response.status_code}", status=response.status_code)
    if not response.content:
        return None
    return response.json()


def _object(body: Any, what: str) -> Mapping[str, Any]:
    """A response body that must be an object."""
    if not isinstance(body, Mapping):
        raise github_api.GithubError(f"the {what} call answered no object")
    return body


def create_issue(
    token: str,
    full_name: str,
    *,
    title: str,
    body: str,
    labels: Sequence[str] = (),
    assignees: Sequence[str] = (),
    client: httpx.Client | None = None,
) -> Mapping[str, Any]:
    """Open one issue in a repository and answer GitHub's record of it."""
    payload: dict[str, Any] = {"title": title, "body": body}
    if labels:
        payload["labels"] = list(labels)
    if assignees:
        payload["assignees"] = list(assignees)
    return _object(_request("POST", f"/repos/{full_name}/issues", token=token, json=payload, client=client), "issue")


def update_issue(
    token: str,
    full_name: str,
    number: int,
    changes: Mapping[str, Any],
    *,
    client: httpx.Client | None = None,
) -> Mapping[str, Any]:
    """Patch one issue with the given fields and answer GitHub's record of it."""
    return _object(
        _request("PATCH", f"/repos/{full_name}/issues/{number}", token=token, json=dict(changes), client=client),
        "issue",
    )


def create_comment(
    token: str,
    full_name: str,
    number: int,
    body: str,
    *,
    client: httpx.Client | None = None,
) -> Mapping[str, Any]:
    """Post one comment on an issue and answer GitHub's record of it."""
    return _object(
        _request(
            "POST",
            f"/repos/{full_name}/issues/{number}/comments",
            token=token,
            json={"body": body},
            client=client,
        ),
        "comment",
    )


def update_comment(
    token: str,
    full_name: str,
    comment_id: str,
    body: str,
    *,
    client: httpx.Client | None = None,
) -> Mapping[str, Any]:
    """Replace one issue comment's body and answer GitHub's record of it."""
    return _object(
        _request(
            "PATCH",
            f"/repos/{full_name}/issues/comments/{comment_id}",
            token=token,
            json={"body": body},
            client=client,
        ),
        "comment",
    )


def user_login(token: str, github_user_id: str, *, client: httpx.Client | None = None) -> str:
    """The current login of one GitHub account, read by its stable numeric id.

    An OAuth link stores the id, not the login, because a login can be renamed;
    assigning on GitHub takes the login, so it is read at the moment it is needed.
    """
    body = _object(_request("GET", f"/user/{github_user_id}", token=token, client=client), "user")
    return str(body.get("login", ""))
