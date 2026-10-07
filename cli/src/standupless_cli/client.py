"""A curated HTTP client over the Standupless REST API.

Only the endpoints the CLI's commands need are wrapped, each returning the TypedDict
generated from `backend/openapi.json`, so a renamed field shows up as a type error
here rather than a `KeyError` in a user's terminal. `tests/test_openapi_contract.py`
holds every path and method below to the published document.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any, cast

import httpx

from standupless_cli import __version__
from standupless_cli._generated.models import (
    AppCommonApiSchemasIssuesIssueRead,
    CommentCreate,
    CommentRead,
    CycleRead,
    IssueCreate,
    IssueExportRead,
    IssueMove,
    IssueUpdate,
    LabelCreate,
    LabelListRead,
    LabelRead,
    LabelUpdate,
    MemberListRead,
    MemberRead,
    OverrideUpdate,
    ProjectRead,
    StatusCreate,
    StatusListRead,
    StatusRead,
    StatusUpdate,
    TeamListRead,
    TeamRead,
    TeamUpdate,
    UserRead,
    ViewListRead,
    ViewRead,
    WorkspaceListRead,
    WorkspaceRead,
)

Issue = AppCommonApiSchemasIssuesIssueRead

PAGE_LIMIT = 100


class ApiError(Exception):
    """A non-2xx answer, carrying the error envelope's status, message and code."""

    def __init__(self, status: int, message: str, error_code: str | None = None, request_id: str | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.error_code = error_code
        self.request_id = request_id

    def __str__(self) -> str:
        """The message with the status and code, which is what a user can act on."""
        code = f" {self.error_code}" if self.error_code else ""
        return f"{self.message} (HTTP {self.status}{code})"


def _raise_for(response: httpx.Response) -> None:
    """Turn an error response into `ApiError`, reading the envelope when there is one."""
    if response.is_success:
        return
    message = response.reason_phrase or "Request failed"
    error_code = None
    request_id = None
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        message = str(body.get("message") or body.get("detail") or message)
        error_code = body.get("error_code")
        request_id = body.get("request_id")
    raise ApiError(response.status_code, message, error_code, request_id)


class StanduplessClient:
    """One authenticated connection to one API base URL."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        extra_headers: Mapping[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 30.0,
    ):
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": f"standupless-cli/{__version__}",
            **(extra_headers or {}),
        }
        self._http = httpx.Client(base_url=base_url, headers=headers, timeout=timeout, transport=transport)

    def close(self) -> None:
        """Release the connection pool."""
        self._http.close()

    def __enter__(self) -> StanduplessClient:
        """Use as a context manager so the pool closes on exit."""
        return self

    def __exit__(self, *exc: object) -> None:
        """Close on leaving the block."""
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        """Send one request and return the decoded body, raising `ApiError` on failure."""
        try:
            response = self._http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise ApiError(0, f"Could not reach {self._http.base_url}: {exc}") from exc
        _raise_for(response)
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    def _pages(self, path: str, key: str, params: Mapping[str, Any], limit: int | None) -> Iterator[Any]:
        """Follow `next_cursor` until the server stops or `limit` items have been yielded."""
        cursor: str | None = None
        seen = 0
        while True:
            page_size = PAGE_LIMIT if limit is None else max(1, min(PAGE_LIMIT, limit - seen))
            query = {**params, "limit": page_size}
            if cursor:
                query["cursor"] = cursor
            body = self._request("GET", path, params=query)
            for item in body.get(key) or []:
                yield item
                seen += 1
                if limit is not None and seen >= limit:
                    return
            cursor = body.get("next_cursor")
            if not cursor:
                return

    def list_workspaces(self) -> list[WorkspaceRead]:
        """Every workspace the key's user belongs to."""
        return cast(WorkspaceListRead, self._request("GET", "/api/workspaces"))["workspaces"]

    def get_workspace(self, workspace_id: str) -> WorkspaceRead:
        """One workspace, which also proves the key is bound to it."""
        return cast(WorkspaceRead, self._request("GET", f"/api/workspaces/{workspace_id}"))

    def get_me(self) -> UserRead:
        """The person a personal key belongs to; a workspace key gets a 403."""
        return cast(UserRead, self._request("GET", "/api/users/me"))

    def list_teams(self, workspace_id: str) -> list[TeamRead]:
        """The workspace's teams."""
        return cast(TeamListRead, self._request("GET", f"/api/workspaces/{workspace_id}/teams"))["teams"]

    def update_team(self, workspace_id: str, team_id: str, body: TeamUpdate) -> TeamRead:
        """Change a team's settings, with team admin."""
        return cast(TeamRead, self._request("PATCH", f"/api/workspaces/{workspace_id}/teams/{team_id}", json=body))

    def list_statuses(self, workspace_id: str, team_id: str, include_hidden: bool = False) -> list[StatusRead]:
        """A team's effective workflow statuses, its own and the inherited workspace ones."""
        path = f"/api/workspaces/{workspace_id}/teams/{team_id}/statuses"
        params = {"include_hidden": "true"} if include_hidden else None
        return cast(StatusListRead, self._request("GET", path, params=params))["statuses"]

    def create_status(self, workspace_id: str, team_id: str, body: StatusCreate) -> StatusRead:
        """Add a workflow status to a team."""
        path = f"/api/workspaces/{workspace_id}/teams/{team_id}/statuses"
        return cast(StatusRead, self._request("POST", path, json=body))

    def update_status(self, workspace_id: str, team_id: str, status_id: str, body: StatusUpdate) -> StatusRead:
        """Patch a status; a null color or icon resets it to the category default."""
        path = f"/api/workspaces/{workspace_id}/teams/{team_id}/statuses/{status_id}"
        return cast(StatusRead, self._request("PATCH", path, json=body))

    def delete_status(
        self, workspace_id: str, team_id: str, status_id: str, replacement_status_id: str | None = None
    ) -> None:
        """Delete one of a team's own statuses, moving its issues to `replacement_status_id`."""
        params = {"replacement_status_id": replacement_status_id} if replacement_status_id else None
        self._request("DELETE", f"/api/workspaces/{workspace_id}/teams/{team_id}/statuses/{status_id}", params=params)

    def override_status(self, workspace_id: str, team_id: str, status_id: str, body: OverrideUpdate) -> StatusRead:
        """Hide, show or rename an inherited workspace status in one team."""
        path = f"/api/workspaces/{workspace_id}/teams/{team_id}/statuses/{status_id}/override"
        return cast(StatusRead, self._request("PATCH", path, json=body))

    def clear_status_override(self, workspace_id: str, team_id: str, status_id: str) -> StatusRead:
        """Show an inherited workspace status again in one team, under its workspace name."""
        path = f"/api/workspaces/{workspace_id}/teams/{team_id}/statuses/{status_id}/override"
        return cast(StatusRead, self._request("DELETE", path))

    def list_workspace_statuses(self, workspace_id: str) -> list[StatusRead]:
        """The workspace statuses every team inherits."""
        return cast(StatusListRead, self._request("GET", f"/api/workspaces/{workspace_id}/statuses"))["statuses"]

    def create_workspace_status(self, workspace_id: str, body: StatusCreate) -> StatusRead:
        """Add a workspace status every team inherits."""
        return cast(StatusRead, self._request("POST", f"/api/workspaces/{workspace_id}/statuses", json=body))

    def update_workspace_status(self, workspace_id: str, status_id: str, body: StatusUpdate) -> StatusRead:
        """Patch a workspace status in every team at once."""
        path = f"/api/workspaces/{workspace_id}/statuses/{status_id}"
        return cast(StatusRead, self._request("PATCH", path, json=body))

    def delete_workspace_status(
        self, workspace_id: str, status_id: str, replacement_status_id: str | None = None
    ) -> None:
        """Delete a workspace status from every team, moving its issues to `replacement_status_id`."""
        params = {"replacement_status_id": replacement_status_id} if replacement_status_id else None
        self._request("DELETE", f"/api/workspaces/{workspace_id}/statuses/{status_id}", params=params)

    def list_labels(self, workspace_id: str, team_id: str, include_hidden: bool = False) -> list[LabelRead]:
        """A team's effective labels, its own and the inherited workspace ones."""
        path = f"/api/workspaces/{workspace_id}/teams/{team_id}/labels"
        params = {"include_hidden": "true"} if include_hidden else None
        return cast(LabelListRead, self._request("GET", path, params=params))["labels"]

    def create_label(self, workspace_id: str, team_id: str, body: LabelCreate) -> LabelRead:
        """Add a label to a team."""
        path = f"/api/workspaces/{workspace_id}/teams/{team_id}/labels"
        return cast(LabelRead, self._request("POST", path, json=body))

    def update_label(self, workspace_id: str, team_id: str, label_id: str, body: LabelUpdate) -> LabelRead:
        """Rename or recolour one of a team's own labels."""
        path = f"/api/workspaces/{workspace_id}/teams/{team_id}/labels/{label_id}"
        return cast(LabelRead, self._request("PATCH", path, json=body))

    def delete_label(self, workspace_id: str, team_id: str, label_id: str) -> None:
        """Delete one of a team's own labels."""
        self._request("DELETE", f"/api/workspaces/{workspace_id}/teams/{team_id}/labels/{label_id}")

    def override_label(self, workspace_id: str, team_id: str, label_id: str, body: OverrideUpdate) -> LabelRead:
        """Hide, show or rename an inherited workspace label in one team."""
        path = f"/api/workspaces/{workspace_id}/teams/{team_id}/labels/{label_id}/override"
        return cast(LabelRead, self._request("PATCH", path, json=body))

    def clear_label_override(self, workspace_id: str, team_id: str, label_id: str) -> LabelRead:
        """Show an inherited workspace label again in one team, under its workspace name."""
        path = f"/api/workspaces/{workspace_id}/teams/{team_id}/labels/{label_id}/override"
        return cast(LabelRead, self._request("DELETE", path))

    def list_workspace_labels(self, workspace_id: str) -> list[LabelRead]:
        """The workspace labels every team inherits."""
        return cast(LabelListRead, self._request("GET", f"/api/workspaces/{workspace_id}/labels"))["labels"]

    def create_workspace_label(self, workspace_id: str, body: LabelCreate) -> LabelRead:
        """Add a workspace label every team inherits."""
        return cast(LabelRead, self._request("POST", f"/api/workspaces/{workspace_id}/labels", json=body))

    def update_workspace_label(self, workspace_id: str, label_id: str, body: LabelUpdate) -> LabelRead:
        """Rename or recolour a workspace label in every team at once."""
        path = f"/api/workspaces/{workspace_id}/labels/{label_id}"
        return cast(LabelRead, self._request("PATCH", path, json=body))

    def delete_workspace_label(self, workspace_id: str, label_id: str) -> None:
        """Delete a workspace label from every team."""
        self._request("DELETE", f"/api/workspaces/{workspace_id}/labels/{label_id}")

    def list_members(self, workspace_id: str) -> list[MemberRead]:
        """The workspace's members."""
        return cast(MemberListRead, self._request("GET", f"/api/workspaces/{workspace_id}/members"))["members"]

    def list_issues(self, workspace_id: str, params: Mapping[str, Any], limit: int | None = 50) -> list[Issue]:
        """Issues matching the filter params, following cursors up to `limit`."""
        path = f"/api/workspaces/{workspace_id}/issues"
        return list(self._pages(path, "issues", params, limit))

    def export_issues(self, workspace_id: str, params: Mapping[str, Any]) -> Iterator[str]:
        """The CSV export of the issues the filter params select, one page of text at a time.

        The first page starts with the header row, so the pages joined in order are the
        whole file.
        """
        path = f"/api/workspaces/{workspace_id}/issues/export"
        cursor: str | None = None
        while True:
            query = {**params, "cursor": cursor} if cursor else dict(params)
            body = cast(IssueExportRead, self._request("GET", path, params=query))
            yield body["csv"]
            cursor = body.get("next_cursor")
            if not cursor:
                return

    def list_views(self, workspace_id: str, scope: str = "all") -> list[ViewRead]:
        """The saved views the key's user may read: `mine`, `team` or `all`."""
        path = f"/api/workspaces/{workspace_id}/views"
        return cast(ViewListRead, self._request("GET", path, params={"scope": scope})).get("views", [])

    def get_issue_by_key(self, workspace_id: str, key: str) -> Issue:
        """One issue by its human key, such as `ENG-12`."""
        return cast(Issue, self._request("GET", f"/api/workspaces/{workspace_id}/issues/by-key/{key}"))

    def create_issue(self, workspace_id: str, body: IssueCreate) -> Issue:
        """Create an issue."""
        return cast(Issue, self._request("POST", f"/api/workspaces/{workspace_id}/issues", json=body))

    def update_issue(self, workspace_id: str, issue_id: str, body: IssueUpdate) -> Issue:
        """Patch an issue; only the fields present are changed."""
        path = f"/api/workspaces/{workspace_id}/issues/{issue_id}"
        return cast(Issue, self._request("PATCH", path, json=body))

    def move_issue(self, workspace_id: str, issue_id: str, team_id: str) -> Issue:
        """Move an issue to another team, which gives it that team's next key."""
        path = f"/api/workspaces/{workspace_id}/issues/{issue_id}/move"
        body: IssueMove = {"team_id": team_id}
        return cast(Issue, self._request("POST", path, json=body))

    def list_comments(self, workspace_id: str, issue_id: str, limit: int | None = None) -> list[CommentRead]:
        """An issue's comments, oldest first as the server orders them."""
        path = f"/api/workspaces/{workspace_id}/issues/{issue_id}/comments"
        return list(self._pages(path, "comments", {}, limit))

    def create_comment(self, workspace_id: str, issue_id: str, body: CommentCreate) -> CommentRead:
        """Post a comment on an issue."""
        path = f"/api/workspaces/{workspace_id}/issues/{issue_id}/comments"
        return cast(CommentRead, self._request("POST", path, json=body))

    def list_cycles(
        self, workspace_id: str, team_id: str, status: str | None = None, limit: int | None = None
    ) -> list[CycleRead]:
        """A team's cycles, optionally narrowed to one status."""
        params: dict[str, Any] = {"team_id": team_id}
        if status:
            params["status"] = status
        return list(self._pages(f"/api/workspaces/{workspace_id}/cycles", "cycles", params, limit))

    def list_projects(
        self, workspace_id: str, team_id: str | None = None, status: str | None = None, limit: int | None = None
    ) -> list[ProjectRead]:
        """The workspace's projects, optionally narrowed to a team or a status."""
        params: dict[str, Any] = {}
        if team_id:
            params["team_id"] = team_id
        if status:
            params["status"] = status
        return list(self._pages(f"/api/workspaces/{workspace_id}/projects", "projects", params, limit))

    def get_project(self, workspace_id: str, project_id: str) -> ProjectRead:
        """One project."""
        return cast(ProjectRead, self._request("GET", f"/api/workspaces/{workspace_id}/projects/{project_id}"))
