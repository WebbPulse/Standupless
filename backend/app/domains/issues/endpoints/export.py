"""The CSV export route: the issue list's filters, answered as CSV a page at a time.

Registered ahead of the issue routes so `export` is not read as an issue id. The
body is JSON carrying the CSV text and the next cursor rather than a raw CSV
stream, because a function behind the HTTP API answers buffered and size capped,
and a cursor in the body needs no exposed header for the browser to read it.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.issue_filters import UnknownStatusCategory, build_issue_filter
from app.common.issue_rules import unprocessable
from app.domains.issues.export import DEFAULT_ROWS, MAX_ROWS, export_page

router = APIRouter()

Values = Annotated[Optional[list[str]], Query()]
"""A repeatable query parameter: `k=a&k=b` is any of `a` or `b`."""


class IssueExportRead(BaseModel):
    """One page of a CSV export.

    `csv` is RFC 4180 text with CRLF line endings, and the first page starts with
    the header row, so the pages concatenated in order are the whole file. The
    export is finished when `next_cursor` is null; a page may hold no rows and still
    carry a cursor when it stopped at its read budget.
    """

    csv: str
    rows: int
    next_cursor: Optional[str] = None


@router.get("/{workspace_id}/issues/export", response_model=IssueExportRead)
def export_issues(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    team_id: Annotated[Optional[str], Query()] = None,
    status_id: Values = None,
    status_id_not: Values = None,
    status_category: Values = None,
    status_category_not: Values = None,
    assignee_id: Values = None,
    assignee_id_not: Values = None,
    creator_id: Values = None,
    creator_id_not: Values = None,
    label_id: Values = None,
    label_id_not: Values = None,
    parent_id: Values = None,
    priority: Values = None,
    priority_not: Values = None,
    cycle_id: Values = None,
    cycle_id_not: Values = None,
    project_id: Values = None,
    project_id_not: Values = None,
    project_milestone_id: Values = None,
    project_milestone_id_not: Values = None,
    estimate: Values = None,
    estimate_not: Values = None,
    sla_status: Values = None,
    due_before: Annotated[Optional[str], Query()] = None,
    due_after: Annotated[Optional[str], Query()] = None,
    team_id_in: Values = None,
    team_id_not: Values = None,
    created_after: Annotated[Optional[str], Query()] = None,
    created_before: Annotated[Optional[str], Query()] = None,
    updated_after: Annotated[Optional[str], Query()] = None,
    updated_before: Annotated[Optional[str], Query()] = None,
    q: Annotated[Optional[str], Query()] = None,
    is_blocked: Annotated[Optional[bool], Query()] = None,
    is_blocking: Annotated[Optional[bool], Query()] = None,
    has_relation: Values = None,
    include_archived: Annotated[bool, Query()] = False,
    archived_only: Annotated[bool, Query()] = False,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_ROWS)] = DEFAULT_ROWS,
) -> IssueExportRead:
    """One page of the CSV of every issue the caller may see that the filters keep.

    The filters are the issue list's, so a team list or a saved view exports
    exactly what it shows by sending its own query. Without `team_id` the export
    spans every team the caller can read, which for a workspace admin is the whole
    workspace. Rows come in team order, then by issue number, whatever the list's
    sort, because that order is what lets each page continue a key-bounded read.
    """
    try:
        wanted = build_issue_filter(
            user_id=context.user_id,
            status_id=status_id,
            status_id_not=status_id_not,
            status_category=status_category,
            status_category_not=status_category_not,
            assignee_id=assignee_id,
            assignee_id_not=assignee_id_not,
            creator_id=creator_id,
            creator_id_not=creator_id_not,
            label_id=label_id,
            label_id_not=label_id_not,
            priority=priority,
            priority_not=priority_not,
            parent_id=parent_id,
            cycle_id=cycle_id,
            cycle_id_not=cycle_id_not,
            project_id=project_id,
            project_id_not=project_id_not,
            project_milestone_id=project_milestone_id,
            project_milestone_id_not=project_milestone_id_not,
            estimate=estimate,
            estimate_not=estimate_not,
            sla_status=sla_status,
            due_before=due_before,
            due_after=due_after,
            team_id_in=team_id_in,
            team_id_not=team_id_not,
            created_after=created_after,
            created_before=created_before,
            updated_after=updated_after,
            updated_before=updated_before,
            q=q,
            include_archived=include_archived,
            archived_only=archived_only,
            is_blocked=is_blocked,
            is_blocking=is_blocking,
            has_relation=has_relation,
        )
    except UnknownStatusCategory as exc:
        raise unprocessable(str(exc)) from exc
    page = export_page(repositories, context, wanted, team_id=team_id, cursor=cursor, limit=limit)
    return IssueExportRead(csv=page.csv, rows=page.rows, next_cursor=page.next_cursor)
