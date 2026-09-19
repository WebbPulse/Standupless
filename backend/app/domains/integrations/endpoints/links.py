"""The pull requests linked to one issue, read by anyone who can read the issue.

Linking is decided by the consumer, so there is no write route here. The read is
the `ws_issue-link-index` query, which is why the link row carries the workspace
and issue in one attribute rather than being found by scanning the partition.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.db.dynamo.github import IssueLink
from app.domains.integrations.schemas.integrations import IssueLinkRead
from app.domains.integrations.service import link_read, not_found

router = APIRouter()

DEFAULT_LIMIT = 50

MAX_LIMIT = 100


@router.get("/{workspace_id}/issues/{issue_id}/github-links", response_model=CursorPage[IssueLinkRead])
def list_issue_links(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[IssueLinkRead]:
    """The pull requests that mention this issue, newest first.

    The issue is loaded first so that an issue in a project the caller is outside
    gives the same 404 as one that does not exist, rather than an empty list which
    would confirm the id.
    """
    issue = repositories.issues.get(context.workspace_id, issue_id)
    if issue is None:
        raise not_found()
    if not context.can_see_project(issue.project_id):
        raise not_found()

    scope = f"github-links:{context.workspace_id}:{issue_id}"
    page = repositories.github.list_links_for_issue(
        context.workspace_id,
        issue_id,
        limit=limit,
        start_key=decode_cursor(cursor, scope),
    )
    return CursorPage(
        items=[link_read(IssueLink.model_validate(dict(row))) for row in page.items],
        next_cursor=encode_cursor(page.last_evaluated_key, scope),
    )
