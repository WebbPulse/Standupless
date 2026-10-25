"""The one GitLab call this product makes: reading the group or project a connection names.

Connecting checks the access token against GitLab before anything is stored, so a
typo, a revoked token or a token without `read_api` is refused at once rather than
leaving a connection that silently receives nothing. The read is also what turns
the path an admin typed into GitLab's numeric id, which every merge request event
carries.

The instance URL is typed by an admin, so the request goes through the same
`PinnedHttpsSender` an outbound webhook uses: https only, public addresses only,
the checked address dialled and no redirect followed. The token travels only in
the `PRIVATE-TOKEN` header and is never formatted into an error, a log line or a
return value.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import quote, urlsplit, urlunsplit

from app.domains.integrations.outbound.ssrf import PinnedHttpsSender, UnsafeDestination, check_destination

TIMEOUT_SECONDS = 10.0

BODY_LIMIT = 256 * 1024
"""The most of GitLab's answer that is read, far more than one group or project record."""

DEFAULT_INSTANCE = "https://gitlab.com"

PATH_MAX = 255


class GitlabError(Exception):
    """A connection GitLab would not confirm, carrying a stable code and a message safe to show."""

    def __init__(self, code: str, message: str) -> None:
        """Keep the code the route answers and the sentence the admin reads."""
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class GitlabScope:
    """The group or project GitLab confirmed the token can read."""

    scope_id: str
    path: str
    name: str
    web_url: str


type Fetch = Callable[[str, Mapping[str, str]], tuple[int, str]]
"""Read one URL with the given headers and answer its status and body."""


def normalize_instance(url: str | None) -> str:
    """An instance URL as stored: https, no credentials, query or trailing slash, raising `GitlabError`.

    A self-managed instance may live under a path, such as `https://example.com/gitlab`,
    so the path is kept.
    """
    raw = (url or "").strip() or DEFAULT_INSTANCE
    try:
        check_destination(raw)
    except UnsafeDestination as exc:
        raise GitlabError("GITLAB_INSTANCE_INVALID", f"The GitLab URL is not allowed. {exc}") from exc
    parts = urlsplit(raw)
    if parts.query or parts.fragment:
        raise GitlabError("GITLAB_INSTANCE_INVALID", "The GitLab URL must not carry a query or fragment.")
    host = (parts.hostname or "").lower()
    netloc = f"{host}:{parts.port}" if parts.port and parts.port != 443 else host
    return urlunsplit(("https", netloc, parts.path.rstrip("/"), "", ""))


def normalize_path(path: str | None) -> str:
    """A group or project path as GitLab names it, without slashes at either end, raising `GitlabError`."""
    value = (path or "").strip().strip("/")
    if not value or len(value) > PATH_MAX or any(character.isspace() for character in value) or "//" in value:
        raise GitlabError("GITLAB_PATH_INVALID", "Enter the group or project path, such as my-group/my-project.")
    return value


def _pinned_fetch(url: str, headers: Mapping[str, str]) -> tuple[int, str]:
    """Read `url` through the SSRF guarded sender."""
    response = PinnedHttpsSender().get(url, headers=headers, timeout=TIMEOUT_SECONDS, body_limit=BODY_LIMIT)
    if response.status_code == 0:
        raise GitlabError("GITLAB_UNREACHABLE", "GitLab could not be reached at that URL.")
    return response.status_code, response.body or ""


fetch: Fetch = _pinned_fetch
"""The read every connection check makes, replaced in tests so none reaches GitLab."""


def read_scope(instance_url: str, scope_kind: str, path: str, token: str) -> GitlabScope:
    """The group or project at `path`, as the token sees it, raising `GitlabError` when GitLab refuses."""
    resource = "groups" if scope_kind == "group" else "projects"
    url = f"{instance_url}/api/v4/{resource}/{quote(path, safe='')}"
    if resource == "groups":
        url = f"{url}?with_projects=false"
    status, body = fetch(url, {"PRIVATE-TOKEN": token, "Accept": "application/json"})
    if status == 401:
        raise GitlabError("GITLAB_TOKEN_REJECTED", "GitLab did not accept that access token.")
    if status in (403, 404):
        raise GitlabError(
            "GITLAB_SCOPE_NOT_FOUND",
            f"GitLab has no {scope_kind} at that path that this token can read.",
        )
    if status != 200:
        raise GitlabError("GITLAB_UNREACHABLE", f"GitLab answered with status {status}.")
    try:
        record: Any = json.loads(body)
    except ValueError as exc:
        raise GitlabError("GITLAB_UNREACHABLE", "GitLab answered with something other than JSON.") from exc
    if not isinstance(record, Mapping) or record.get("id") in (None, ""):
        raise GitlabError("GITLAB_UNREACHABLE", "GitLab answered without the record asked for.")
    full_path = str(record.get("full_path") or record.get("path_with_namespace") or path)
    name = str(record.get("full_name") or record.get("name_with_namespace") or record.get("name") or full_path)
    return GitlabScope(
        scope_id=str(record["id"]),
        path=full_path,
        name=name,
        web_url=str(record.get("web_url") or ""),
    )
