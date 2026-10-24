"""The Asana REST calls the Asana importer makes, and the one place a request leaves for Asana.

A personal access token travels only in the `Authorization` header of a request
built here. It is never formatted into an exception, a log line or a return
value, so whatever goes wrong, what reaches a log or a job object is a code such
as `authentication_failed`, never the token.

Asana answers an exhausted rate limit with HTTP 429 and a `Retry-After` header in
seconds. `AsanaClient.get` waits that long, bounded by `MAX_WAIT_SECONDS`, and
retries a few times, so a large project imports at Asana's pace instead of
failing. A 5xx answer and a dropped connection are retried the same way. Lists
are paged with Asana's `offset` token, at most `PAGE_LIMIT` records a call.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

import httpx

from app.common.core.config import settings

TIMEOUT_SECONDS = 20.0

MAX_ATTEMPTS = 5
"""How many times one call is sent before the failure is raised."""

MAX_WAIT_SECONDS = 60.0
"""The longest one rate limit or retry pause lasts, so a step always ends inside its invocation."""

BACKOFF_SECONDS = 2.0
"""The first pause after a 5xx or a dropped connection, doubled on each retry."""

PAGE_LIMIT = 100
"""The most records Asana answers per list call."""

MAX_LIST_PAGES = 50
"""How many pages a whole-list read follows, so a runaway list cannot hold a step forever."""

PROJECT_FIELDS = (
    "name,archived,completed,notes,start_on,due_on,created_at,"
    "owner.email,owner.name,permalink_url,team.name,workspace.name"
)

TASK_FIELDS = (
    "name,notes,completed,completed_at,created_at,due_on,due_at,start_on,"
    "assignee.email,assignee.name,created_by.email,tags.name,tags.color,"
    "memberships.project.gid,memberships.section.name,"
    "custom_fields.gid,custom_fields.name,custom_fields.resource_subtype,custom_fields.enum_value.name,"
    "permalink_url,num_subtasks"
)

STORY_FIELDS = "resource_subtype,text,created_at,created_by.email,created_by.name"

CUSTOM_FIELD_FIELDS = "custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.enum_options.name"


class AsanaError(Exception):
    """Asana refused or did not answer a call, carrying only a code and never the token."""

    def __init__(self, code: str, *, status_code: int = 0) -> None:
        """Carry Asana's refusal as a short code and the HTTP status it came with."""
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class AsanaAuthFailed(AsanaError):
    """The token was refused: wrong, expired or revoked."""


class AsanaNotFound(AsanaError):
    """The record does not exist or the token cannot see it."""


class AsanaRateLimited(AsanaError):
    """Asana's rate limit still held after every retry."""


@dataclass
class AsanaPage:
    """One page of an Asana list and the offset of the next, `None` after the last."""

    data: list[dict[str, Any]]
    offset: Optional[str] = None


@dataclass
class AsanaClient:
    """An Asana API session for one token, with an injectable transport and clock for the tests."""

    token: str = field(repr=False)
    url: str = ""
    transport: Optional[httpx.BaseTransport] = None
    sleep: Callable[[float], None] = time.sleep

    def __post_init__(self) -> None:
        """Default the base to the configured one."""
        self.url = (self.url or settings.ASANA_API_URL).rstrip("/")

    def _send(self, path: str, params: Mapping[str, Any]) -> dict[str, Any]:
        """Send one GET and answer its JSON body, waiting out rate limits and transient failures."""
        attempt = 0
        while True:
            attempt += 1
            try:
                with httpx.Client(timeout=TIMEOUT_SECONDS, transport=self.transport) as client:
                    response = client.get(
                        f"{self.url}{path}",
                        params={key: value for key, value in params.items() if value is not None},
                        headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json"},
                    )
            except httpx.HTTPError:
                if attempt >= MAX_ATTEMPTS:
                    raise AsanaError("unreachable") from None
                self.sleep(min(BACKOFF_SECONDS * 2 ** (attempt - 1), MAX_WAIT_SECONDS))
                continue
            if response.status_code == 429:
                if attempt >= MAX_ATTEMPTS:
                    raise AsanaRateLimited("rate_limited", status_code=429)
                self.sleep(_retry_after(response))
                continue
            if response.status_code >= 500:
                if attempt >= MAX_ATTEMPTS:
                    raise AsanaError("unavailable", status_code=response.status_code)
                self.sleep(min(BACKOFF_SECONDS * 2 ** (attempt - 1), MAX_WAIT_SECONDS))
                continue
            return _body(response)

    def get(self, path: str, **params: Any) -> dict[str, Any]:
        """One record's `data`."""
        data = self._send(path, params).get("data")
        if not isinstance(data, dict):
            raise AsanaError("invalid_response")
        return data

    def page(self, path: str, offset: Optional[str] = None, limit: int = PAGE_LIMIT, **params: Any) -> AsanaPage:
        """One page of a list from `offset`, with the offset of the next page."""
        body = self._send(path, {**params, "limit": max(1, min(limit, PAGE_LIMIT)), "offset": offset or None})
        data = body.get("data")
        if not isinstance(data, list):
            raise AsanaError("invalid_response")
        next_page = body.get("next_page")
        following = next_page.get("offset") if isinstance(next_page, dict) else None
        return AsanaPage(
            data=[entry for entry in data if isinstance(entry, dict)],
            offset=str(following) if following else None,
        )

    def every(self, path: str, **params: Any) -> list[dict[str, Any]]:
        """Every record of a list, page by page, up to `MAX_LIST_PAGES` pages."""
        records: list[dict[str, Any]] = []
        offset: Optional[str] = None
        for _ in range(MAX_LIST_PAGES):
            page = self.page(path, offset, **params)
            records.extend(page.data)
            offset = page.offset
            if offset is None:
                break
        return records


def _retry_after(response: httpx.Response) -> float:
    """How long a rate limited answer asks to wait, held between one second and `MAX_WAIT_SECONDS`."""
    try:
        wait = float(response.headers.get("Retry-After") or BACKOFF_SECONDS)
    except ValueError:
        wait = BACKOFF_SECONDS
    return min(max(wait, 1.0), MAX_WAIT_SECONDS)


def _body(response: httpx.Response) -> dict[str, Any]:
    """The JSON of a settled answer, or the refusal it carries as an `AsanaError`."""
    if response.status_code == 401:
        raise AsanaAuthFailed("authentication_failed", status_code=401)
    if response.status_code in (403, 404):
        raise AsanaNotFound("not_found", status_code=response.status_code)
    if response.status_code == 402:
        raise AsanaError("payment_required", status_code=402)
    if response.status_code >= 400:
        raise AsanaError(f"http_{response.status_code}", status_code=response.status_code)
    try:
        payload = response.json()
    except ValueError:
        raise AsanaError("invalid_response", status_code=response.status_code) from None
    if not isinstance(payload, dict):
        raise AsanaError("invalid_response", status_code=response.status_code)
    return payload


def me(client: AsanaClient) -> dict[str, Any]:
    """The token's user with the workspaces it belongs to, raising `AsanaAuthFailed` for a refused token."""
    return client.get("/users/me", opt_fields="name,email,workspaces.name")


def list_projects(client: AsanaClient, workspace_gid: str) -> list[dict[str, Any]]:
    """Every project of one workspace the token can see, archived ones included."""
    return client.every("/projects", workspace=workspace_gid, opt_fields=PROJECT_FIELDS)


def get_project(client: AsanaClient, project_gid: str) -> dict[str, Any]:
    """One project, raising `AsanaNotFound` when the token cannot see it."""
    return client.get(f"/projects/{project_gid}", opt_fields=PROJECT_FIELDS)


def list_sections(client: AsanaClient, project_gid: str) -> list[dict[str, Any]]:
    """One project's sections, in board order."""
    return client.every(f"/projects/{project_gid}/sections", opt_fields="name")


def list_enum_fields(client: AsanaClient, project_gid: str) -> list[dict[str, Any]]:
    """One project's single choice custom fields with their options, or none on a plan without custom fields."""
    try:
        settings_rows = client.every(f"/projects/{project_gid}/custom_field_settings", opt_fields=CUSTOM_FIELD_FIELDS)
    except AsanaError as exc:
        if exc.code == "payment_required":
            return []
        raise
    fields: list[dict[str, Any]] = []
    for row in settings_rows:
        custom = row.get("custom_field")
        if isinstance(custom, dict) and custom.get("gid") and custom.get("resource_subtype") == "enum":
            fields.append(custom)
    return fields


def task_counts(client: AsanaClient, project_gid: str) -> dict[str, int]:
    """How many tasks one project holds, and how many of them are complete."""
    data = client.get(f"/projects/{project_gid}/task_counts", opt_fields="num_tasks,num_completed_tasks")
    return {
        "tasks": int(data.get("num_tasks") or 0),
        "completed": int(data.get("num_completed_tasks") or 0),
    }


def task_page(client: AsanaClient, project_gid: str, offset: Optional[str], limit: int) -> AsanaPage:
    """One page of a project's top level tasks, complete ones included."""
    return client.page("/tasks", offset, limit, project=project_gid, opt_fields=TASK_FIELDS)


def list_subtasks(client: AsanaClient, task_gid: str) -> list[dict[str, Any]]:
    """Every subtask of one task."""
    return client.every(f"/tasks/{task_gid}/subtasks", opt_fields=TASK_FIELDS)


def list_comments(client: AsanaClient, task_gid: str) -> list[dict[str, Any]]:
    """The comments of one task, oldest first, leaving out the system stories Asana records for every change."""
    stories = client.every(f"/tasks/{task_gid}/stories", opt_fields=STORY_FIELDS)
    return [story for story in stories if story.get("resource_subtype") == "comment_added"]
