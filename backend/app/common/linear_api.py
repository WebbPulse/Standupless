"""The Linear GraphQL calls the importer makes, and the one place a request leaves for Linear.

A personal API key travels only in the `Authorization` header of a request built
here. It is never formatted into an exception, a log line or a return value, so
whatever goes wrong, what reaches a log or a job object is a code such as
`authentication_failed`, never the key.

Linear meters requests per key and per hour, and answers an exhausted budget with
HTTP 429 or a GraphQL error coded `RATELIMITED`, carrying the time the budget
resets. `LinearClient.query` waits until then, bounded by `MAX_WAIT_SECONDS`, and
retries a few times, so a large workspace imports at Linear's pace instead of
failing. A 5xx answer and a dropped connection are retried the same way.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Mapping, Optional

import httpx

from app.common.core.config import settings

TIMEOUT_SECONDS = 20.0

MAX_ATTEMPTS = 5
"""How many times one query is sent before the failure is raised."""

MAX_WAIT_SECONDS = 60.0
"""The longest one rate limit or retry pause lasts, so a step always ends inside its invocation."""

BACKOFF_SECONDS = 2.0
"""The first pause after a 5xx or a dropped connection, doubled on each retry."""

PAGE_SIZE = 50

RATE_LIMIT_CODE = "RATELIMITED"

AUTH_CODES = frozenset({"AUTHENTICATION_ERROR", "FORBIDDEN"})


class LinearError(Exception):
    """Linear refused or did not answer a query, carrying only a code and never the key."""

    def __init__(self, code: str, *, status_code: int = 0) -> None:
        """Carry Linear's refusal as a short code and the HTTP status it came with."""
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class LinearAuthFailed(LinearError):
    """The key was refused: wrong, revoked, or without read access."""


class LinearRateLimited(LinearError):
    """Linear's rate limit still held after every retry."""


@dataclass
class LinearClient:
    """A Linear API session for one key, with an injectable transport and clock for the tests."""

    api_key: str = field(repr=False)
    url: str = ""
    transport: Optional[httpx.BaseTransport] = None
    sleep: Callable[[float], None] = time.sleep
    now: Callable[[], float] = time.time

    def __post_init__(self) -> None:
        """Default the endpoint to the configured one."""
        self.url = self.url or settings.LINEAR_API_URL

    def query(self, document: str, variables: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
        """Run one GraphQL query and answer its `data`, waiting out rate limits and transient failures."""
        attempt = 0
        while True:
            attempt += 1
            try:
                with httpx.Client(timeout=TIMEOUT_SECONDS, transport=self.transport) as client:
                    response = client.post(
                        self.url,
                        json={"query": document, "variables": dict(variables or {})},
                        headers={"Authorization": self.api_key, "Content-Type": "application/json"},
                    )
            except httpx.HTTPError:
                if attempt >= MAX_ATTEMPTS:
                    raise LinearError("unreachable") from None
                self.sleep(min(BACKOFF_SECONDS * 2 ** (attempt - 1), MAX_WAIT_SECONDS))
                continue
            wait = self._rate_limit_wait(response)
            if wait is not None:
                if attempt >= MAX_ATTEMPTS:
                    raise LinearRateLimited("rate_limited", status_code=response.status_code)
                self.sleep(wait)
                continue
            if response.status_code >= 500:
                if attempt >= MAX_ATTEMPTS:
                    raise LinearError("unavailable", status_code=response.status_code)
                self.sleep(min(BACKOFF_SECONDS * 2 ** (attempt - 1), MAX_WAIT_SECONDS))
                continue
            return self._data(response)

    def _rate_limit_wait(self, response: httpx.Response) -> Optional[float]:
        """How long to wait before retrying a rate limited answer, or `None` when it was not one."""
        limited = response.status_code == 429 or RATE_LIMIT_CODE in _error_codes(response)
        if not limited:
            return None
        reset = response.headers.get("X-RateLimit-Requests-Reset") or response.headers.get(
            "X-RateLimit-Complexity-Reset"
        )
        wait = BACKOFF_SECONDS
        if reset:
            try:
                wait = float(reset) / 1000.0 - self.now()
            except ValueError:
                wait = BACKOFF_SECONDS
        retry_after = response.headers.get("Retry-After")
        if retry_after:
            try:
                wait = max(wait, float(retry_after))
            except ValueError:
                pass
        return min(max(wait, 1.0), MAX_WAIT_SECONDS)

    def _data(self, response: httpx.Response) -> dict[str, Any]:
        """The `data` of a settled answer, or the refusal it carries as a `LinearError`."""
        codes = _error_codes(response)
        if response.status_code in (401, 403) or AUTH_CODES & set(codes):
            raise LinearAuthFailed("authentication_failed", status_code=response.status_code)
        try:
            payload = response.json()
        except ValueError:
            raise LinearError("invalid_response", status_code=response.status_code) from None
        if response.status_code >= 400 or payload.get("errors"):
            code = codes[0] if codes else f"http_{response.status_code}"
            raise LinearError(code.lower(), status_code=response.status_code)
        data = payload.get("data")
        if not isinstance(data, dict):
            raise LinearError("invalid_response", status_code=response.status_code)
        return data

    def pages(
        self, document: str, path: tuple[str, ...], variables: Optional[Mapping[str, Any]] = None
    ) -> Iterator[list[dict[str, Any]]]:
        """Every page of one connection, following `pageInfo.endCursor` until Linear says there is no more."""
        after: Optional[str] = None
        while True:
            page = self.page(document, path, {**dict(variables or {}), "after": after})
            yield page.nodes
            if not page.has_next:
                return
            after = page.end_cursor

    def page(self, document: str, path: tuple[str, ...], variables: Mapping[str, Any]) -> "Page":
        """One page of one connection, found in the answer at `path`."""
        node: Any = self.query(document, {"first": PAGE_SIZE, **dict(variables)})
        for name in path:
            node = node.get(name) if isinstance(node, dict) else None
        return Page.of(node)


@dataclass
class Page:
    """One page of a Linear connection: its nodes and where the next one starts."""

    nodes: list[dict[str, Any]]
    has_next: bool
    end_cursor: Optional[str]

    @classmethod
    def of(cls, connection: Any) -> "Page":
        """Read a connection object, treating a missing one as an empty last page."""
        if not isinstance(connection, dict):
            return cls(nodes=[], has_next=False, end_cursor=None)
        info = connection.get("pageInfo") or {}
        nodes = [node for node in connection.get("nodes") or [] if isinstance(node, dict)]
        cursor = info.get("endCursor")
        has_next = bool(info.get("hasNextPage")) and bool(cursor)
        return cls(nodes=nodes, has_next=has_next, end_cursor=str(cursor) if cursor else None)


def _error_codes(response: httpx.Response) -> list[str]:
    """The `extensions.code` of every GraphQL error in an answer, upper cased."""
    try:
        payload = response.json()
    except ValueError:
        return []
    errors = payload.get("errors") if isinstance(payload, dict) else None
    codes: list[str] = []
    for error in errors or []:
        if not isinstance(error, dict):
            continue
        extensions = error.get("extensions") or {}
        code = extensions.get("code") if isinstance(extensions, dict) else None
        if code:
            codes.append(str(code).upper())
    return codes


TEAMS_QUERY = """
query Teams($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    nodes { id key name }
    pageInfo { hasNextPage endCursor }
  }
}
"""

CYCLES_QUERY = """
query Cycles($team: String!, $first: Int!, $after: String) {
  team(id: $team) {
    cycles(first: $first, after: $after) {
      nodes { id number name description startsAt endsAt createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""

PROJECTS_QUERY = """
query Projects($team: String!, $first: Int!, $after: String) {
  team(id: $team) {
    projects(first: $first, after: $after) {
      nodes {
        id name description content url createdAt startDate targetDate priority health
        startDateResolution targetDateResolution
        status { type }
        lead { email }
        projectMilestones(first: 50) {
          nodes { id name description targetDate sortOrder createdAt }
          pageInfo { hasNextPage endCursor }
        }
        projectUpdates(first: 50) {
          nodes { id body health createdAt user { name email } }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""

PROJECT_MILESTONES_QUERY = """
query ProjectMilestones($project: String!, $first: Int!, $after: String) {
  project(id: $project) {
    projectMilestones(first: $first, after: $after) {
      nodes { id name description targetDate sortOrder createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""

PROJECT_UPDATES_QUERY = """
query ProjectUpdates($project: String!, $first: Int!, $after: String) {
  project(id: $project) {
    projectUpdates(first: $first, after: $after) {
      nodes { id body health createdAt user { name email } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""

ISSUES_QUERY = """
query Issues($team: String!, $first: Int!, $after: String) {
  team(id: $team) {
    issues(first: $first, after: $after, includeArchived: true) {
      nodes {
        id identifier url title description priority estimate dueDate createdAt
        state { id name type }
        assignee { email }
        creator { email }
        cycle { id createdAt }
        project { id createdAt }
        projectMilestone { id createdAt }
        labels(first: 50) { nodes { id name color parent { id name color } } }
        attachments(first: 50) { nodes { title url } }
        comments(first: 50) {
          nodes { id body createdAt parent { id createdAt } user { name email } }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""

ISSUE_COMMENTS_QUERY = """
query IssueComments($issue: String!, $first: Int!, $after: String) {
  issue(id: $issue) {
    comments(first: $first, after: $after) {
      nodes { id body createdAt parent { id createdAt } user { name email } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""

ISSUE_LINKS_QUERY = """
query IssueLinks($team: String!, $first: Int!, $after: String) {
  team(id: $team) {
    issues(first: $first, after: $after, includeArchived: true) {
      nodes {
        id createdAt
        parent { id createdAt }
        relations(first: 50) { nodes { type relatedIssue { id createdAt } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""

INITIATIVES_QUERY = """
query Initiatives($first: Int!, $after: String) {
  initiatives(first: $first, after: $after) {
    nodes {
      id name description status targetDate createdAt
      owner { email }
      projects(first: 50) { nodes { id createdAt } }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""

PROJECT_RELATIONS_QUERY = """
query ProjectRelations($first: Int!, $after: String) {
  projectRelations(first: $first, after: $after) {
    nodes {
      id type anchorType relatedAnchorType createdAt
      project { id createdAt }
      relatedProject { id createdAt }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""


def list_teams(client: LinearClient) -> list[dict[str, Any]]:
    """Every team the key can read, as `id`, `key` and `name`."""
    teams: list[dict[str, Any]] = []
    for nodes in client.pages(TEAMS_QUERY, ("teams",)):
        teams.extend(
            {"id": str(node.get("id") or ""), "key": str(node.get("key") or ""), "name": str(node.get("name") or "")}
            for node in nodes
            if node.get("id")
        )
    return teams
