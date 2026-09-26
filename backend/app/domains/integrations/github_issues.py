"""The GitHub issue, comment and user calls the two way issue sync makes.

The installation token and both comment calls go through
`webbpulse.integrations.github`. Reading a user by id and creating or updating an
issue, with its labels, assignees and state, have no public call there yet, and
every product that mirrors issues needs the same ones. Until they land upstream,
those three are made here with the shared client's headers, and a failure raises
the shared `GitHubError` subclass for its status, so callers already speak the
upstream vocabulary and only this module changes when the calls move.

Rate limits are surfaced rather than slept through. A 429, or a 403 that says the
primary or secondary limit is spent, raises `GitHubRateLimited`, the consumer lets
it propagate, and the queue's visibility timeout is the back off: holding a Lambda
open until GitHub's reset would spend the function's whole timeout doing nothing.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping, Sequence

import httpx
from webbpulse.integrations.github import (
    ACCEPT,
    API_ROOT,
    API_VERSION,
    GitHubError,
    GitHubForbidden,
    GitHubNotFound,
    GitHubRateLimited,
    GitHubUnauthorized,
    GitHubUnavailable,
    GitHubUnprocessable,
)

from app.domains.integrations import github_api

_log = logging.getLogger(__name__)

__all__ = [
    "GitHubError",
    "GitHubRateLimited",
    "create_comment",
    "create_issue",
    "installation_token",
    "update_comment",
    "update_issue",
    "user_login",
]

TIMEOUT_SECONDS = 10.0

_KINDS: dict[int, type[GitHubError]] = {
    401: GitHubUnauthorized,
    403: GitHubForbidden,
    404: GitHubNotFound,
    422: GitHubUnprocessable,
}


def installation_token(installation_id: str) -> str:
    """An installation token for one unit of sync work, minted by the shared client and never stored."""
    with github_api.app_client() as client:
        return client.installation_token(installation_id)


def _rate_limited(response: httpx.Response) -> bool:
    """Whether a refusal is a rate limit rather than a permission problem."""
    if response.status_code == 429:
        return True
    if response.status_code != 403:
        return False
    return response.headers.get("x-ratelimit-remaining") == "0" or "retry-after" in response.headers


def _retry_after(response: httpx.Response) -> float | None:
    """How many seconds GitHub asked for, when it said."""
    raw = response.headers.get("retry-after")
    try:
        return float(raw) if raw is not None else None
    except ValueError:
        return None


def _error_for(response: httpx.Response, method: str, path: str) -> GitHubError:
    """The shared `GitHubError` subclass a failed response maps to."""
    status = response.status_code
    message = f"{method} {path} answered {status}"
    context: dict[str, Any] = {"method": method, "path": path, "status_code": status}
    if _rate_limited(response):
        return GitHubRateLimited(message, retry_after=_retry_after(response), **context)
    if status >= 500:
        return GitHubUnavailable(message, **context)
    return _KINDS.get(status, GitHubError)(message, **context)


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
    headers = {"Accept": ACCEPT, "Authorization": f"Bearer {token}", "X-GitHub-Api-Version": API_VERSION}
    owned = client is None
    http = client if client is not None else httpx.Client(timeout=TIMEOUT_SECONDS)
    try:
        response = http.request(method, f"{API_ROOT}{path}", headers=headers, json=json)
    except httpx.HTTPError as error:
        raise GitHubUnavailable(f"{method} {path} did not answer", method=method, path=path) from error
    finally:
        if owned:
            http.close()
    if response.status_code >= 400:
        error = _error_for(response, method, path)
        _log.warning(
            "GitHub refused an issue sync call.",
            extra={
                "event": "integrations.sync.github_error",
                "method": method,
                "path": path,
                "status": response.status_code,
                "rate_limited": isinstance(error, GitHubRateLimited),
            },
        )
        raise error
    if not response.content:
        return None
    return response.json()


def _object(body: Any, what: str) -> Mapping[str, Any]:
    """A response body that must be an object."""
    if not isinstance(body, Mapping):
        raise GitHubError(f"the {what} call answered no object")
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


def create_comment(installation_id: str, full_name: str, number: int, body: str) -> Mapping[str, Any]:
    """Post one comment on an issue through the shared client and answer its id."""
    with github_api.app_client() as client:
        comment = client.create_issue_comment(full_name, number, body, installation_id=installation_id)
    return {"id": comment.id, "body": body}


def update_comment(installation_id: str, full_name: str, comment_id: str, body: str) -> Mapping[str, Any]:
    """Replace one issue comment's body through the shared client."""
    with github_api.app_client() as client:
        comment = client.update_issue_comment(full_name, comment_id, body, installation_id=installation_id)
    return {"id": comment.id, "body": body}


def user_login(token: str, github_user_id: str, *, client: httpx.Client | None = None) -> str:
    """The current login of one GitHub account, read by its stable numeric id.

    An OAuth link stores the id, not the login, because a login can be renamed;
    assigning on GitHub takes the login, so it is read at the moment it is needed.
    """
    body = _object(_request("GET", f"/user/{github_user_id}", token=token, client=client), "user")
    return str(body.get("login", ""))
