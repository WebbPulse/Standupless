"""The activity route: one issue's history, newest first.

Read only. Every row is written by the handler that made the change, so there is
nothing here that creates history and no way for a client to forge an entry.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.db.dynamo.activity import as_activity
from app.domains.issues.schemas.issue import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    ActivityListRead,
    ActivityRead,
)
from app.domains.issues.service import load_visible_issue

router = APIRouter()


@router.get("/{workspace_id}/issues/{issue_id}/activity", response_model=ActivityListRead)
def list_activity(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> ActivityListRead:
    """One page of an issue's history, newest first.

    The sort key is a ULID, so descending order is the query's own direction and
    the cursor is DynamoDB's start key rather than an offset into a merged set.
    """
    load_visible_issue(repositories, context, issue_id)
    scope = f"activity:{context.workspace_id}:{issue_id}"
    page = repositories.activity.list_for_issue(
        context.workspace_id,
        issue_id,
        limit=limit,
        start_key=decode_cursor(cursor, scope),
    )
    rows = [as_activity(item) for item in page.items]
    return ActivityListRead(
        activity=[ActivityRead.from_row(row) for row in rows],
        next_cursor=encode_cursor(page.last_evaluated_key, scope),
    )
