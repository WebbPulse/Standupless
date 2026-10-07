"""The repository calls Standupless makes on GitHub: issues, comments, labels, check runs and users.

Every repository scoped call is addressed as `/repositories/{repository_id}`, never
as `/repos/{owner}/{name}`. The numeric id survives a rename or a transfer, so a
renamed repository keeps syncing, while an owner and name copied into a row goes
stale and GitHub answers it with a redirect. The owner and name stay on the rows
for display only. The shared `webbpulse.integrations.github` client takes an owner
and name, so these calls are made here with its headers and its token exchange,
and a failure raises the shared `GitHubError` subclass for its status, so callers
already speak the upstream vocabulary.

Only a 2xx answer is a success. A redirect is raised as a `GitHubError` rather than
followed or read as an answer, because its body is not the resource asked for, and
reading it as one is how a comment that was never posted got saved as posted.

Rate limits are surfaced rather than slept through. A 429, or a 403 that says the
primary or secondary limit is spent, raises `GitHubRateLimited`, the consumer lets
it propagate, and the queue's visibility timeout is the back off: holding a Lambda
open until GitHub's reset would spend the function's whole timeout doing nothing.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping, Sequence
from urllib.parse import quote

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
    "GitHubNotFound",
    "GitHubRateLimited",
    "add_labels",
    "create_check_run",
    "create_comment",
    "create_issue",
    "create_label",
    "get_issue",
    "installation_token",
    "list_comments",
    "pull_request_commit_messages",
    "remove_label",
    "repository_path",
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


def repository_path(repository_id: int | str) -> str:
    """The API path of one repository by its numeric id, refusing anything that is not one."""
    return f"/repositories/{_identifier(repository_id, 'repository_id')}"


def _identifier(value: int | str, what: str) -> str:
    """A positive integer id rendered for a URL path, refusing anything else."""
    text = str(value).strip()
    if not text.isdigit() or int(text) <= 0:
        raise ValueError(f"{what} must be a positive integer")
    return str(int(text))


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
    if 300 <= status < 400:
        return GitHubError(f"{message}, a redirect rather than an answer", **context)
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
    """One GitHub call with the installation token, raising on anything but a 2xx.

    Redirects are not followed, so a 3xx raises like any other failure. The token
    never reaches a log line; a failure logs the method, the path and the status.
    """
    headers = {"Accept": ACCEPT, "Authorization": f"Bearer {token}", "X-GitHub-Api-Version": API_VERSION}
    owned = client is None
    http = client if client is not None else httpx.Client(timeout=TIMEOUT_SECONDS, follow_redirects=False)
    try:
        response = http.request(method, f"{API_ROOT}{path}", headers=headers, json=json, follow_redirects=False)
    except httpx.HTTPError as error:
        raise GitHubUnavailable(f"{method} {path} did not answer", method=method, path=path) from error
    finally:
        if owned:
            http.close()
    if not 200 <= response.status_code < 300:
        error = _error_for(response, method, path)
        _log.warning(
            "GitHub refused a repository call.",
            extra={
                "event": "integrations.sync.github_error",
                "method": method,
                "path": path,
                "status": response.status_code,
                "rate_limited": isinstance(error, GitHubRateLimited),
                "redirected": 300 <= response.status_code < 400,
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
    repository_id: str,
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
    path = f"{repository_path(repository_id)}/issues"
    return _numbered(_request("POST", path, token=token, json=payload, client=client), "issue", "number")


def update_issue(
    token: str,
    repository_id: str,
    number: int,
    changes: Mapping[str, Any],
    *,
    client: httpx.Client | None = None,
) -> Mapping[str, Any]:
    """Patch one issue with the given fields and answer GitHub's record of it."""
    path = f"{repository_path(repository_id)}/issues/{_identifier(number, 'number')}"
    return _numbered(_request("PATCH", path, token=token, json=dict(changes), client=client), "issue", "number")


def create_comment(
    token: str,
    repository_id: str,
    number: int,
    body: str,
    *,
    client: httpx.Client | None = None,
) -> Mapping[str, Any]:
    """Post one comment on an issue or pull request and answer GitHub's record of it, id included."""
    path = f"{repository_path(repository_id)}/issues/{_identifier(number, 'number')}/comments"
    return _numbered(_request("POST", path, token=token, json={"body": body}, client=client), "comment", "id")


def update_comment(
    token: str,
    repository_id: str,
    comment_id: str,
    body: str,
    *,
    client: httpx.Client | None = None,
) -> Mapping[str, Any]:
    """Replace one issue comment's body and answer GitHub's record of it."""
    path = f"{repository_path(repository_id)}/issues/comments/{_identifier(comment_id, 'comment_id')}"
    return _numbered(_request("PATCH", path, token=token, json={"body": body}, client=client), "comment", "id")


def create_check_run(
    token: str,
    repository_id: str,
    *,
    name: str,
    head_sha: str,
    conclusion: str,
    title: str,
    summary: str,
    client: httpx.Client | None = None,
) -> Mapping[str, Any]:
    """Set one completed check run on a commit and answer GitHub's record of it."""
    payload = {
        "name": name,
        "head_sha": head_sha,
        "status": "completed",
        "conclusion": conclusion,
        "output": {"title": title, "summary": summary},
    }
    path = f"{repository_path(repository_id)}/check-runs"
    return _numbered(_request("POST", path, token=token, json=payload, client=client), "check run", "id")


def _numbered(body: Any, what: str, field: str) -> Mapping[str, Any]:
    """A response object that must carry a positive integer `field`, or the call did not happen."""
    record = _object(body, what)
    value = record.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise GitHubError(f"the {what} call answered no {field}")
    return record


def get_issue(token: str, repository_id: str, number: int, *, client: httpx.Client | None = None) -> Mapping[str, Any]:
    """One issue or pull request as the issues API answers it, its state and labels included."""
    path = f"{repository_path(repository_id)}/issues/{_identifier(number, 'number')}"
    return _numbered(_request("GET", path, token=token, client=client), "issue", "number")


def create_label(token: str, repository_id: str, name: str, color: str, *, client: httpx.Client | None = None) -> bool:
    """Create one repository label, answering `False` when a label of that name already exists.

    GitHub answers a taken name with a 422, which is the outcome the caller wanted,
    so it is not raised. The color is sent as the six hex digits GitHub expects.
    """
    hex_color = color.lstrip("#").lower()
    body: dict[str, Any] = {"name": name}
    if len(hex_color) == 6 and all(char in "0123456789abcdef" for char in hex_color):
        body["color"] = hex_color
    try:
        _request("POST", f"{repository_path(repository_id)}/labels", token=token, json=body, client=client)
    except GitHubUnprocessable:
        return False
    return True


def add_labels(
    token: str, repository_id: str, number: int, names: Sequence[str], *, client: httpx.Client | None = None
) -> None:
    """Add labels to one issue or pull request, keeping the labels it already carries."""
    if not names:
        return
    path = f"{repository_path(repository_id)}/issues/{_identifier(number, 'number')}/labels"
    _request("POST", path, token=token, json={"labels": list(names)}, client=client)


def remove_label(token: str, repository_id: str, number: int, name: str, *, client: httpx.Client | None = None) -> None:
    """Take one label off an issue or pull request, treating one already gone as removed."""
    path = f"{repository_path(repository_id)}/issues/{_identifier(number, 'number')}/labels/{quote(name, safe='')}"
    try:
        _request("DELETE", path, token=token, client=client)
    except GitHubNotFound:
        return


COMMENT_PAGE_SIZE = 100

COMMENT_PAGES = 10
"""How many pages of comments a backlink search reads before giving up and posting."""


def list_comments(
    token: str, repository_id: str, number: int, *, client: httpx.Client | None = None
) -> list[Mapping[str, Any]]:
    """An issue's comments, oldest first, up to `COMMENT_PAGES` pages.

    A page that is not a list raises rather than reading as no comments, so a
    backlink search never concludes a comment is missing from an answer it could
    not read.
    """
    comments: list[Mapping[str, Any]] = []
    base = f"{repository_path(repository_id)}/issues/{_identifier(number, 'number')}/comments"
    for page in range(1, COMMENT_PAGES + 1):
        body = _request("GET", f"{base}?per_page={COMMENT_PAGE_SIZE}&page={page}", token=token, client=client)
        if not isinstance(body, list):
            raise GitHubError("the comment list call answered no list")
        batch = [entry for entry in body if isinstance(entry, Mapping)]
        comments.extend(batch)
        if len(batch) < COMMENT_PAGE_SIZE:
            break
    return comments


COMMIT_PAGE_SIZE = 100
PULL_COMMITS_LIMIT = 250
"""The most commits GitHub lists for one pull request; a longer one is read through a compare."""
COMPARE_PAGES = 50


def _commit_messages(entries: Any, what: str) -> list[str]:
    """The messages of one page of commit objects."""
    if not isinstance(entries, list):
        raise GitHubError(f"the {what} call answered no commit list")
    messages: list[str] = []
    for entry in entries:
        commit = entry.get("commit") if isinstance(entry, Mapping) else None
        if isinstance(commit, Mapping):
            messages.append(str(commit.get("message") or ""))
    return messages


def _is_sha(value: str) -> bool:
    """Whether a value is a git object id safe to put in a URL path."""
    return 7 <= len(value) <= 64 and all(character in "0123456789abcdef" for character in value)


def pull_request_commit_messages(
    token: str,
    repository_id: int | str,
    number: int | str,
    *,
    base_sha: str = "",
    head_sha: str = "",
    client: httpx.Client | None = None,
) -> list[str]:
    """Every commit message on one pull request, which its webhook payload does not carry.

    The pull request commit list stops at 250 commits, so a longer one, such as a
    promotion carrying a release's worth of merges, is read again through a compare
    of its base and head, which pages past that limit.
    """
    base = f"{repository_path(repository_id)}/pulls/{_identifier(number, 'number')}/commits"
    messages: list[str] = []
    for page in range(1, PULL_COMMITS_LIMIT // COMMIT_PAGE_SIZE + 2):
        batch = _commit_messages(
            _request("GET", f"{base}?per_page={COMMIT_PAGE_SIZE}&page={page}", token=token, client=client),
            "pull request commits",
        )
        messages.extend(batch)
        if len(batch) < COMMIT_PAGE_SIZE:
            break
    if len(messages) < PULL_COMMITS_LIMIT or not (_is_sha(base_sha) and _is_sha(head_sha)):
        return messages

    compare = f"{repository_path(repository_id)}/compare/{base_sha}...{head_sha}"
    compared: list[str] = []
    for page in range(1, COMPARE_PAGES + 1):
        body = _object(
            _request("GET", f"{compare}?per_page={COMMIT_PAGE_SIZE}&page={page}", token=token, client=client),
            "compare",
        )
        batch = _commit_messages(body.get("commits"), "compare")
        compared.extend(batch)
        if len(batch) < COMMIT_PAGE_SIZE:
            break
    return compared if len(compared) > len(messages) else messages


COMPARE_COMMITS_LIMIT = 1000
"""How many commits of a deployment's range are read; a longer range keeps its newest."""


def _commit_pairs(entries: Any, what: str) -> list[tuple[str, str]]:
    """The sha and message of each commit object on one page."""
    if not isinstance(entries, list):
        raise GitHubError(f"the {what} call answered no commit list")
    pairs: list[tuple[str, str]] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        commit = entry.get("commit")
        message = str(commit.get("message") or "") if isinstance(commit, Mapping) else ""
        pairs.append((str(entry.get("sha") or "").lower(), message))
    return pairs


def compare_commits(
    token: str,
    repository_id: int | str,
    base_sha: str,
    head_sha: str,
    *,
    client: httpx.Client | None = None,
) -> list[tuple[str, str]]:
    """The sha and message of every commit after `base_sha` up to `head_sha`, oldest first.

    This is a deployment's range: what reached an environment since the commit it
    was last deployed at. The read stops at `COMPARE_COMMITS_LIMIT` commits.
    """
    if not (_is_sha(base_sha) and _is_sha(head_sha)):
        raise ValueError("a compare needs two commit shas")
    compare = f"{repository_path(repository_id)}/compare/{base_sha}...{head_sha}"
    pairs: list[tuple[str, str]] = []
    for page in range(1, COMPARE_COMMITS_LIMIT // COMMIT_PAGE_SIZE + 1):
        body = _object(
            _request("GET", f"{compare}?per_page={COMMIT_PAGE_SIZE}&page={page}", token=token, client=client),
            "compare",
        )
        batch = _commit_pairs(body.get("commits"), "compare")
        pairs.extend(batch)
        if len(batch) < COMMIT_PAGE_SIZE:
            break
    return pairs


def commit(token: str, repository_id: int | str, sha: str, *, client: httpx.Client | None = None) -> tuple[str, str]:
    """The sha and message of one commit, for a deployment with no earlier one to compare with."""
    if not _is_sha(sha):
        raise ValueError("a commit read needs a commit sha")
    body = _object(_request("GET", f"{repository_path(repository_id)}/commits/{sha}", token=token, client=client), "commit")
    pairs = _commit_pairs([body], "commit")
    return pairs[0] if pairs else (sha.lower(), "")


def user_login(token: str, github_user_id: str, *, client: httpx.Client | None = None) -> str:
    """The current login of one GitHub account, read by its stable numeric id.

    An OAuth link stores the id, not the login, because a login can be renamed;
    assigning on GitHub takes the login, so it is read at the moment it is needed.
    """
    body = _object(_request("GET", f"/user/{github_user_id}", token=token, client=client), "user")
    return str(body.get("login", ""))
