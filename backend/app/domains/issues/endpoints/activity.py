"""The activity route: one issue's history, newest first.

Read only. Every row is written by the handler that made the change, so there is
nothing here that creates history and no way for a client to forge an entry.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.issues import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    ActivityListRead,
    ActivityRead,
)
from app.common.change_source import ChangeSource
from app.common.issue_activity import activity_page

router = APIRouter()


@router.get("/{workspace_id}/issues/{issue_id}/activity", response_model=ActivityListRead)
def list_activity(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    source: Annotated[Optional[ChangeSource], Query()] = None,
) -> CursorPage[ActivityRead]:
    """One page of an issue's history, newest first.

    The sort key is a ULID, so descending order is the query's own direction and
    the cursor is DynamoDB's start key rather than an offset into a merged set.
    `source` keeps only the rows made through that client, filtered within the page.
    """
    rows, next_cursor = activity_page(repositories, context, issue_id, cursor=cursor, limit=limit, source=source)
    return ActivityListRead(
        items=[ActivityRead.from_row(row) for row in rows],
        next_cursor=next_cursor,
    )
