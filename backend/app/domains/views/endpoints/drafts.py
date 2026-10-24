"""Comment draft routes: list, read, save and discard the caller's own drafts.

A draft is the caller's alone, so every route reads and writes only rows keyed
by them. `parent_comment_id` names the reply thread a draft belongs to, and is
left out for a draft on the issue itself.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.drafts import DraftListRead, DraftRead, DraftWrite
from app.common.comment_drafts import delete_draft, get_draft, list_drafts, save_draft

router = APIRouter()


@router.get("/{workspace_id}/drafts", response_model=DraftListRead)
def read_drafts(
    workspace_id: str = Path(..., min_length=1),
    issue_id: Optional[str] = Query(default=None, min_length=1, max_length=64),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> DraftListRead:
    """The caller's drafts, newest saved first, across the workspace or on one issue."""
    return DraftListRead(drafts=list_drafts(repositories, context, issue_id=issue_id))


@router.get("/{workspace_id}/drafts/{issue_id}", response_model=DraftRead)
def read_draft(
    workspace_id: str = Path(..., min_length=1),
    issue_id: str = Path(..., min_length=1, max_length=64),
    parent_comment_id: Optional[str] = Query(default=None, max_length=64),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> DraftRead:
    """The caller's draft on an issue or one reply thread, or a 404 when there is none."""
    return get_draft(repositories, context, issue_id, parent_comment_id=parent_comment_id)


@router.put("/{workspace_id}/drafts/{issue_id}", response_model=DraftRead)
def write_draft(
    payload: DraftWrite,
    workspace_id: str = Path(..., min_length=1),
    issue_id: str = Path(..., min_length=1, max_length=64),
    parent_comment_id: Optional[str] = Query(default=None, max_length=64),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> DraftRead:
    """Save the caller's draft on an issue or one reply thread, replacing the one there."""
    return save_draft(repositories, context, issue_id, payload.body, parent_comment_id=parent_comment_id)


@router.delete("/{workspace_id}/drafts/{issue_id}", status_code=status.HTTP_204_NO_CONTENT)
def discard_draft(
    workspace_id: str = Path(..., min_length=1),
    issue_id: str = Path(..., min_length=1, max_length=64),
    parent_comment_id: Optional[str] = Query(default=None, max_length=64),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Discard the caller's draft in one thread, a no-op when there is none."""
    delete_draft(repositories, context, issue_id, parent_comment_id=parent_comment_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
