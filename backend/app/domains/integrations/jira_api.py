"""The Jira Cloud REST calls the Jira importer makes, and the one place a request leaves for Jira.

Jira Cloud authenticates a script with basic auth: the account email and an API
token. Both travel only in the `Authorization` header of a request built here.
Neither is formatted into an exception, a log line or a return value, so
whatever goes wrong, what reaches a log or a job object is a code such as
`authentication_failed`, never the credentials.

Requests go only to the site the admin named, held to `https://<site>.atlassian.net`
by `site_url`, so a pasted URL can never point the importer at another host.

Jira answers an exhausted rate limit with HTTP 429 and a `Retry-After` header in
seconds. `JiraClient` waits that long, bounded by `MAX_WAIT_SECONDS`, and retries
a few times, so a large project imports at Jira's pace instead of failing. A 5xx
answer and a dropped connection are retried the same way. Issue searches page by
issue id, `id > <last id>` in id order, so a step that runs again reads the same
page and no page token can expire between steps.
"""

from __future__ import annotations

import base64
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional
from urllib.parse import urlsplit

import httpx

TIMEOUT_SECONDS = 20.0

MAX_ATTEMPTS = 5
"""How many times one call is sent before the failure is raised."""

MAX_WAIT_SECONDS = 60.0
"""The longest one rate limit or retry pause lasts, so a step always ends inside its invocation."""

BACKOFF_SECONDS = 2.0
"""The first pause after a 5xx or a dropped connection, doubled on each retry."""

PAGE_LIMIT = 100
"""The most records Jira answers per list call."""

MAX_LIST_PAGES = 50
"""How many pages a whole-list read follows, so a runaway list cannot hold a step forever."""

BULK_LIMIT = 100
"""The most issues one bulk fetch names."""

SITE_HOST = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$")

STORY_POINT_NAMES = frozenset({"story points", "story point estimate"})

STORY_POINT_TYPES = frozenset(
    {"com.pyxis.greenhopper.jira:jsw-story-points", "com.atlassian.jira.plugin.system.customfieldtypes:float"}
)

SPRINT_TYPE = "com.pyxis.greenhopper.jira:gh-sprint"

ISSUE_FIELDS = (
    "summary",
    "description",
    "issuetype",
    "status",
    "priority",
    "assignee",
    "reporter",
    "creator",
    "labels",
    "duedate",
    "created",
    "parent",
)

EPIC_FIELDS = ("summary", "description", "issuetype", "status", "assignee", "duedate", "created")

LINK_FIELDS = ("issuetype", "parent", "issuelinks", "created")


class JiraError(Exception):
    """Jira refused or did not answer a call, carrying only a code and never the credentials."""

    def __init__(self, code: str, *, status_code: int = 0) -> None:
        """Carry Jira's refusal as a short code and the HTTP status it came with."""
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class JiraAuthFailed(JiraError):
    """The email and token were refused: wrong, expired or revoked."""


class JiraNotFound(JiraError):
    """The record does not exist or the account cannot see it."""


class JiraBadQuery(JiraError):
    """Jira refused a JQL query as invalid."""


class JiraRateLimited(JiraError):
    """Jira's rate limit still held after every retry."""


class InvalidSite(ValueError):
    """A site URL that is not an `https://<site>.atlassian.net` Jira Cloud site."""


def site_url(value: str) -> str:
    """A Jira Cloud site as `https://<site>.atlassian.net`, raising `InvalidSite` for any other host."""
    text = value.strip()
    if "://" not in text:
        text = f"https://{text}"
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        raise InvalidSite("not a URL") from None
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or port is not None or parts.username or parts.password or not SITE_HOST.match(host):
        raise InvalidSite("not a Jira Cloud site")
    if parts.path.strip("/") not in ("", "jira") or parts.query or parts.fragment:
        raise InvalidSite("not a Jira Cloud site")
    return f"https://{host}"


@dataclass
class JiraPage:
    """One page of issues and whether Jira holds more after it."""

    issues: list[dict[str, Any]]
    is_last: bool = True


@dataclass
class JiraClient:
    """A Jira Cloud session for one site and account, with an injectable transport and clock for the tests."""

    url: str
    email: str = field(repr=False)
    token: str = field(repr=False)
    transport: Optional[httpx.BaseTransport] = None
    sleep: Callable[[float], None] = time.sleep

    def __post_init__(self) -> None:
        """Hold the base to a Jira Cloud site."""
        self.url = site_url(self.url)

    def _authorization(self) -> str:
        """The basic auth header value for the account email and token."""
        pair = f"{self.email}:{self.token}".encode()
        return f"Basic {base64.b64encode(pair).decode()}"

    def _send(self, method: str, path: str, params: Mapping[str, Any], body: Optional[dict[str, Any]] = None) -> Any:
        """Send one call and answer its JSON body, waiting out rate limits and transient failures."""
        attempt = 0
        while True:
            attempt += 1
            try:
                with httpx.Client(timeout=TIMEOUT_SECONDS, transport=self.transport) as client:
                    response = client.request(
                        method,
                        f"{self.url}{path}",
                        params={key: value for key, value in params.items() if value is not None},
                        json=body,
                        headers={"Authorization": self._authorization(), "Accept": "application/json"},
                    )
            except httpx.HTTPError:
                if attempt >= MAX_ATTEMPTS:
                    raise JiraError("unreachable") from None
                self.sleep(min(BACKOFF_SECONDS * 2 ** (attempt - 1), MAX_WAIT_SECONDS))
                continue
            if response.status_code == 429:
                if attempt >= MAX_ATTEMPTS:
                    raise JiraRateLimited("rate_limited", status_code=429)
                self.sleep(_retry_after(response))
                continue
            if response.status_code >= 500:
                if attempt >= MAX_ATTEMPTS:
                    raise JiraError("unavailable", status_code=response.status_code)
                self.sleep(min(BACKOFF_SECONDS * 2 ** (attempt - 1), MAX_WAIT_SECONDS))
                continue
            return _body(response)

    def get(self, path: str, **params: Any) -> Any:
        """One GET's JSON body."""
        return self._send("GET", path, params)

    def post(self, path: str, body: dict[str, Any]) -> Any:
        """One POST's JSON body."""
        return self._send("POST", path, {}, body)

    def record(self, path: str, **params: Any) -> dict[str, Any]:
        """One record, refusing an answer that is not an object."""
        data = self.get(path, **params)
        if not isinstance(data, dict):
            raise JiraError("invalid_response")
        return data

    def rows(self, path: str, **params: Any) -> list[dict[str, Any]]:
        """A list answered whole, refusing an answer that is not a list."""
        data = self.get(path, **params)
        if not isinstance(data, list):
            raise JiraError("invalid_response")
        return [entry for entry in data if isinstance(entry, dict)]

    def paged(self, path: str, key: str, **params: Any) -> list[dict[str, Any]]:
        """Every record of a `startAt` paged list, up to `MAX_LIST_PAGES` pages."""
        records: list[dict[str, Any]] = []
        start = 0
        for _ in range(MAX_LIST_PAGES):
            body = self.record(path, **params, startAt=start, maxResults=PAGE_LIMIT)
            values = body.get(key)
            if not isinstance(values, list):
                raise JiraError("invalid_response")
            page = [entry for entry in values if isinstance(entry, dict)]
            records.extend(page)
            start += len(page)
            total = body.get("total")
            last = body.get("isLast")
            if not page or last is True or (isinstance(total, int) and start >= total):
                break
        return records


def _retry_after(response: httpx.Response) -> float:
    """How long a rate limited answer asks to wait, held between one second and `MAX_WAIT_SECONDS`."""
    try:
        wait = float(response.headers.get("Retry-After") or BACKOFF_SECONDS)
    except ValueError:
        wait = BACKOFF_SECONDS
    return min(max(wait, 1.0), MAX_WAIT_SECONDS)


def _body(response: httpx.Response) -> Any:
    """The JSON of a settled answer, or the refusal it carries as a `JiraError`."""
    if response.status_code == 401:
        raise JiraAuthFailed("authentication_failed", status_code=401)
    if response.status_code in (403, 404):
        raise JiraNotFound("not_found", status_code=response.status_code)
    if response.status_code == 400:
        raise JiraBadQuery("bad_request", status_code=400)
    if response.status_code >= 400:
        raise JiraError(f"http_{response.status_code}", status_code=response.status_code)
    try:
        return response.json()
    except ValueError:
        raise JiraError("invalid_response", status_code=response.status_code) from None


def myself(client: JiraClient) -> dict[str, Any]:
    """The account the credentials sign in as, raising `JiraAuthFailed` when they are refused."""
    return client.record("/rest/api/3/myself")


def list_projects(client: JiraClient) -> list[dict[str, Any]]:
    """Every project the account can browse."""
    return client.paged("/rest/api/3/project/search", "values", expand="description")


def get_project(client: JiraClient, key: str) -> dict[str, Any]:
    """One project by key, raising `JiraNotFound` when the account cannot browse it."""
    return client.record(f"/rest/api/3/project/{key}")


def project_status_names(client: JiraClient, key: str) -> list[str]:
    """The names of every status one project's issue types use, in workflow order."""
    names: list[str] = []
    for issue_type in client.rows(f"/rest/api/3/project/{key}/statuses"):
        for entry in issue_type.get("statuses") or []:
            if isinstance(entry, dict) and entry.get("name"):
                names.append(str(entry["name"]))
    return list(dict.fromkeys(names))


def list_statuses(client: JiraClient) -> list[dict[str, Any]]:
    """Every status on the site with its category."""
    return client.rows("/rest/api/3/status")


def list_fields(client: JiraClient) -> list[dict[str, Any]]:
    """Every issue field on the site, custom ones included."""
    return client.rows("/rest/api/3/field")


def estimate_and_sprint_fields(fields: list[dict[str, Any]]) -> tuple[list[dict[str, str]], Optional[dict[str, str]]]:
    """The story point fields and the sprint field among a site's fields, as id and name."""
    points: list[dict[str, str]] = []
    sprint: Optional[dict[str, str]] = None
    for entry in fields:
        if not entry.get("custom") or not entry.get("id"):
            continue
        name = str(entry.get("name") or "")
        schema = entry.get("schema") if isinstance(entry.get("schema"), dict) else {}
        kind = str(schema.get("custom") or "")
        if name.strip().lower() in STORY_POINT_NAMES and (kind in STORY_POINT_TYPES or not kind):
            points.append({"id": str(entry["id"]), "name": name})
        elif kind == SPRINT_TYPE and sprint is None:
            sprint = {"id": str(entry["id"]), "name": name}
    return points, sprint


def count(client: JiraClient, jql: str) -> int:
    """How many issues a query matches, as Jira estimates it."""
    body = client.post("/rest/api/3/search/approximate-count", {"jql": jql})
    if not isinstance(body, dict):
        raise JiraError("invalid_response")
    return int(body.get("count") or 0)


def search(client: JiraClient, jql: str, fields: tuple[str, ...], limit: int) -> JiraPage:
    """One page of the issues a query matches, with the fields named."""
    body = client.record(
        "/rest/api/3/search/jql",
        jql=jql,
        fields=",".join(fields),
        maxResults=max(1, min(limit, PAGE_LIMIT)),
    )
    issues = body.get("issues")
    if not isinstance(issues, list):
        raise JiraError("invalid_response")
    is_last = body.get("isLast")
    page = [entry for entry in issues if isinstance(entry, dict)]
    return JiraPage(issues=page, is_last=bool(is_last) if is_last is not None else not body.get("nextPageToken"))


def created_times(client: JiraClient, issue_ids: list[str]) -> dict[str, str]:
    """When each named issue was created, by id, leaving out the ones the account cannot see."""
    times: dict[str, str] = {}
    unique = list(dict.fromkeys(issue_ids))
    for start in range(0, len(unique), BULK_LIMIT):
        body = client.post(
            "/rest/api/3/issue/bulkfetch",
            {"issueIdsOrKeys": unique[start : start + BULK_LIMIT], "fields": ["created"]},
        )
        for issue in (body.get("issues") if isinstance(body, dict) else None) or []:
            fields = issue.get("fields") if isinstance(issue, dict) else None
            if isinstance(fields, dict) and issue.get("id") and fields.get("created"):
                times[str(issue["id"])] = str(fields["created"])
    return times


def list_comments(client: JiraClient, issue_id: str) -> list[dict[str, Any]]:
    """Every comment of one issue, oldest first."""
    return client.paged(f"/rest/api/3/issue/{issue_id}/comment", "comments", orderBy="created")
