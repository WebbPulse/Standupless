"""Draft routes: list, read, save and discard the caller's own comment and new issue drafts.

A draft is the caller's alone, so every route reads and writes only rows keyed
by them. `parent_comment_id` names the reply thread a comment draft belongs to,
and is left out for a draft on the issue itself. New issue drafts sit under
`/drafts/new-issues`, registered first so the comment routes never read that
segment as an issue id.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.drafts import DraftListRead, DraftRead, DraftWrite
from app.common.api.schemas.issue_drafts import DRAFT_ID_PATTERN, IssueDraftListRead, IssueDraftRead, IssueDraftWrite
from app.common.comment_drafts import delete_draft, get_draft, list_drafts, save_draft
from app.common.db.dynamo.views import ISSUE_DRAFTS_MAX
from app.common.issue_drafts import delete_issue_draft, get_issue_draft, list_issue_drafts, save_issue_draft

router = APIRouter()


@router.get("/{workspace_id}/drafts/new-issues", response_model=IssueDraftListRead)
def read_issue_drafts(
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> IssueDraftListRead:
    """The caller's new issue drafts, newest saved first, with the most they may keep."""
    return IssueDraftListRead(drafts=list_issue_drafts(repositories, context), limit=ISSUE_DRAFTS_MAX)


@router.post(
    "/{workspace_id}/drafts/new-issues",
    response_model=IssueDraftRead,
    status_code=status.HTTP_201_CREATED,
)
def create_issue_draft(
    payload: IssueDraftWrite,
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> IssueDraftRead:
    """Save a new issue draft under a fresh id, or a 409 once the caller holds the most they may keep."""
    return save_issue_draft(repositories, context, payload)


@router.get("/{workspace_id}/drafts/new-issues/{draft_id}", response_model=IssueDraftRead)
def read_issue_draft(
    workspace_id: str = Path(..., min_length=1),
    draft_id: str = Path(..., pattern=DRAFT_ID_PATTERN),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> IssueDraftRead:
    """One of the caller's new issue drafts, or a 404 when there is none."""
    return get_issue_draft(repositories, context, draft_id)


@router.put("/{workspace_id}/drafts/new-issues/{draft_id}", response_model=IssueDraftRead)
def write_issue_draft(
    payload: IssueDraftWrite,
    workspace_id: str = Path(..., min_length=1),
    draft_id: str = Path(..., pattern=DRAFT_ID_PATTERN),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> IssueDraftRead:
    """Save one of the caller's new issue drafts under the id given, creating it when new."""
    return save_issue_draft(repositories, context, payload, draft_id=draft_id)


@router.delete("/{workspace_id}/drafts/new-issues/{draft_id}", status_code=status.HTTP_204_NO_CONTENT)
def discard_issue_draft(
    workspace_id: str = Path(..., min_length=1),
    draft_id: str = Path(..., pattern=DRAFT_ID_PATTERN),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Discard one of the caller's new issue drafts, a no-op when there is none."""
    delete_issue_draft(repositories, context, draft_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
