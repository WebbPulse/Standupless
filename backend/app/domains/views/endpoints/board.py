"""Board routes: a whole board in one call, and one column paged on its own.

The board read is one call per team rather than per column. It reads the
team's statuses from `team_config` and queries `issues` on
`ws_team-status_updated-index` once per status, each capped at `column_limit`,
so one request's fan-out is bounded by how many statuses a team has rather than
by how many issues it holds. A column deeper than its cap is paged through the
column route, which is why each column carries its own cursor: one opaque string
covering several independent index positions is a cursor nothing could page.

Dragging a card is not here. It is the M2 issue patch, so there stays exactly one
write path onto an issue and one place activity is written.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.db.dynamo.issues import Issue, as_issue, ws_team_status
from app.common.issue_keys import current
from app.domains.views.schemas.view import (
    BOARD_DEFAULT_COLUMN_LIMIT,
    BOARD_MAX_COLUMN_LIMIT,
    BOARD_TOTAL_CAP,
    BoardColumn,
    BoardColumnRead,
    BoardRead,
    IssueRead,
    PriorityField,
    status_sort_key,
)
from app.domains.views.service import (
    matches_filters,
    require_team_reader,
    resolve_assignee,
)

router = APIRouter()

OVER_FETCH = 4
"""How much more than one column page each status is read for before filtering.

The assignee, label and priority filters are applied after the read because the
column is read by the status index, so a filtered column has to over-fetch or it
would answer short of its cap while more matching rows sat behind the boundary.
Bounded rather than unbounded, because the answer only has to be right about the
page the caller asked for.
"""


def _column_scope(workspace_id: str, team_id: str, status_id: str) -> str:
    """The scope a column's cursor is stamped with.

    Names the exact index position the cursor came from, so a cursor minted on one
    column is refused on another rather than fed to DynamoDB as a start key.
    """
    return f"board:{workspace_id}:{team_id}:{status_id}"


def _column_start_key(issue: Issue, status_id: str) -> dict[str, str]:
    """The index position one issue sits at, as a start key for the next page.

    Built from the row rather than taken from `LastEvaluatedKey` because the filters
    are applied after the read: the boundary the caller is actually resting on is
    the last row they were handed, not the last row DynamoDB looked at. A start key
    on a global secondary index needs both the table key and the index key, which is
    what these four attributes are.
    """
    return {
        "workspace_id": issue.workspace_id,
        "issue_id": issue.issue_id,
        "ws_team_status": ws_team_status(issue.workspace_id, issue.team_id, status_id),
        "updated_at": issue.updated_at.isoformat(),
    }


@router.get("/{workspace_id}/board", response_model=BoardRead)
def read_board(
    workspace_id: str = Path(..., min_length=1),
    team_id: str = Query(..., min_length=1),
    assignee_id: Optional[str] = Query(default=None),
    label_id: Optional[str] = Query(default=None),
    priority: Optional[PriorityField] = Query(default=None),
    cycle_id: Optional[str] = Query(default=None),
    project_id: Optional[str] = Query(default=None),
    column_limit: int = Query(default=BOARD_DEFAULT_COLUMN_LIMIT, ge=1, le=BOARD_MAX_COLUMN_LIMIT),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> BoardRead:
    """One team's whole board, a column per status in position order.

    `cycle_id` and `project_id` are accepted because the contract fixes the query
    signature, and they narrow nothing yet: an issue carries neither field until the
    `planning` domain adds them, so filtering on one would be filtering on an
    attribute no row has.
    """
    require_team_reader(repositories, context, team_id)
    wanted_assignee = resolve_assignee(context, assignee_id)

    statuses = sorted(repositories.team_config.list_statuses(workspace_id, team_id), key=status_sort_key)
    columns: list[BoardColumn] = []
    for status_row in statuses:
        page = repositories.issues.list_for_status(
            workspace_id,
            team_id,
            status_row.status_id,
            limit=min(column_limit * OVER_FETCH, BOARD_TOTAL_CAP),
        )
        rows = [as_issue(item) for item in page.items]
        kept = [
            row
            for row in rows
            if matches_filters(row, assignee_id=wanted_assignee, label_id=label_id, priority=priority)
        ]
        window = kept[:column_limit]
        more = bool(window) and (len(kept) > column_limit or page.has_more)
        columns.append(
            BoardColumn(
                status_id=status_row.status_id,
                name=status_row.name,
                category=status_row.category,
                position=status_row.position,
                issues=[IssueRead.from_row(current(repositories.teams, row)) for row in window],
                total=min(len(kept), BOARD_TOTAL_CAP),
                next_cursor=(
                    encode_cursor(
                        _column_start_key(window[-1], status_row.status_id),
                        _column_scope(workspace_id, team_id, status_row.status_id),
                    )
                    if more
                    else None
                ),
            )
        )

    return BoardRead(team_id=team_id, columns=columns)


@router.get("/{workspace_id}/board/columns/{status_id}", response_model=BoardColumnRead)
def read_board_column(
    workspace_id: str = Path(..., min_length=1),
    status_id: str = Path(..., min_length=1),
    team_id: str = Query(..., min_length=1),
    assignee_id: Optional[str] = Query(default=None),
    label_id: Optional[str] = Query(default=None),
    priority: Optional[PriorityField] = Query(default=None),
    cycle_id: Optional[str] = Query(default=None),
    project_id: Optional[str] = Query(default=None),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=BOARD_DEFAULT_COLUMN_LIMIT, ge=1, le=BOARD_MAX_COLUMN_LIMIT),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> CursorPage[IssueRead]:
    """One board column, paged, for a column deeper than the board's own cap."""
    require_team_reader(repositories, context, team_id)
    wanted_assignee = resolve_assignee(context, assignee_id)
    scope = _column_scope(workspace_id, team_id, status_id)

    page = repositories.issues.list_for_status(
        workspace_id,
        team_id,
        status_id,
        limit=min(limit * OVER_FETCH, BOARD_TOTAL_CAP),
        start_key=decode_cursor(cursor, scope),
    )
    rows = [as_issue(item) for item in page.items]
    kept = [
        row for row in rows if matches_filters(row, assignee_id=wanted_assignee, label_id=label_id, priority=priority)
    ]
    window = kept[:limit]
    more = bool(window) and (len(kept) > limit or page.has_more)
    return BoardColumnRead(
        items=[IssueRead.from_row(current(repositories.teams, row)) for row in window],
        next_cursor=encode_cursor(_column_start_key(window[-1], status_id), scope) if more else None,
    )
