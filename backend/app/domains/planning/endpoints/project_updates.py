"""Project update routes: the feed, posting, editing and deleting, under one project.

The project's activity feed, its recorded property and milestone changes, is read
here too, since the overview interleaves it with the updates.

An update is reached through its project, so a caller who can read the project
reads its feed and a writer on one of its visible teams posts to it. Editing and
deleting are its author's, or an admin's. The rules and the health mirroring
live in `app.common.project_updates`, which the MCP tools share.

Each update carries a thread: replies and emoji reactions, on the update and on
its replies, filed in the planning table under the update. Anyone who can read
the project replies and reacts, and a reply is its author's or an admin's to
edit or delete. Those rules live in `app.common.project_update_threads`.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.planning import (
    MAX_LIMIT,
    PROJECT_ACTIVITY_DEFAULT_LIMIT,
    UPDATES_DEFAULT_LIMIT,
    ProjectActivityListRead,
    ProjectUpdateCreate,
    ProjectUpdateListRead,
    ProjectUpdatePatch,
    ProjectUpdateRead,
)
from app.common.api.schemas.update_threads import (
    ProjectUpdateCommentCreate,
    ProjectUpdateCommentListRead,
    ProjectUpdateCommentPatch,
    ProjectUpdateCommentRead,
    ProjectUpdateReactionWrite,
)
from app.common.discussion_reads import ReactionGroupRead
from app.common.project_activity import activity_page
from app.common.project_update_threads import (
    add_update_reaction,
    create_update_comment,
    delete_update_comment,
    edit_update_comment,
    list_update_comments,
    remove_update_reaction,
)
from app.common.project_updates import (
    create_project_update,
    delete_project_update,
    list_project_updates,
    update_project_update,
)

router = APIRouter()


@router.get("/{workspace_id}/projects/{project_id}/updates", response_model=ProjectUpdateListRead)
def list_updates(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = UPDATES_DEFAULT_LIMIT,
) -> Any:
    """One page of a project's updates, newest first."""
    rows, next_cursor = list_project_updates(repositories, context, project_id, cursor=cursor, limit=limit)
    return ProjectUpdateListRead(items=rows, next_cursor=next_cursor)


@router.get("/{workspace_id}/projects/{project_id}/activity", response_model=ProjectActivityListRead)
def list_activity(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = PROJECT_ACTIVITY_DEFAULT_LIMIT,
) -> Any:
    """One page of a project's property and milestone changes, newest first."""
    rows, next_cursor = activity_page(repositories, context, project_id, cursor=cursor, limit=limit)
    return ProjectActivityListRead(items=rows, next_cursor=next_cursor)


@router.post(
    "/{workspace_id}/projects/{project_id}/updates",
    response_model=ProjectUpdateRead,
    status_code=status.HTTP_201_CREATED,
)
def create_update(
    payload: ProjectUpdateCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> ProjectUpdateRead:
    """Post an update, which sets the project's health to the one it reports."""
    return create_project_update(repositories, context, project_id, payload)


@router.patch("/{workspace_id}/projects/{project_id}/updates/{update_id}", response_model=ProjectUpdateRead)
def update_update(
    payload: ProjectUpdatePatch,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> ProjectUpdateRead:
    """Edit an update's body or health, as its author or an admin."""
    return update_project_update(repositories, context, project_id, update_id, payload)


@router.delete(
    "/{workspace_id}/projects/{project_id}/updates/{update_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_update(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> Response:
    """Delete an update, as its author or an admin."""
    delete_project_update(repositories, context, project_id, update_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/{workspace_id}/projects/{project_id}/updates/{update_id}/comments",
    response_model=ProjectUpdateCommentListRead,
)
def list_update_replies(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> ProjectUpdateCommentListRead:
    """Every reply on an update, oldest first."""
    return ProjectUpdateCommentListRead(comments=list_update_comments(repositories, context, project_id, update_id))


@router.post(
    "/{workspace_id}/projects/{project_id}/updates/{update_id}/comments",
    response_model=ProjectUpdateCommentRead,
    status_code=status.HTTP_201_CREATED,
)
def create_update_reply(
    payload: ProjectUpdateCommentCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> ProjectUpdateCommentRead:
    """Reply on an update, notifying its author and anyone mentioned."""
    return create_update_comment(repositories, context, project_id, update_id, payload)


@router.patch(
    "/{workspace_id}/projects/{project_id}/updates/{update_id}/comments/{comment_id}",
    response_model=ProjectUpdateCommentRead,
)
def edit_update_reply(
    payload: ProjectUpdateCommentPatch,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
    comment_id: Annotated[str, Path()],
) -> ProjectUpdateCommentRead:
    """Edit a reply, as its author or an admin."""
    return edit_update_comment(repositories, context, project_id, update_id, comment_id, payload)


@router.delete(
    "/{workspace_id}/projects/{project_id}/updates/{update_id}/comments/{comment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_update_reply(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
    comment_id: Annotated[str, Path()],
) -> Response:
    """Delete a reply and its reactions, as its author or an admin."""
    delete_update_comment(repositories, context, project_id, update_id, comment_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/{workspace_id}/projects/{project_id}/updates/{update_id}/reactions",
    response_model=ReactionGroupRead,
)
def add_update_reaction_route(
    payload: ProjectUpdateReactionWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> ReactionGroupRead:
    """React to an update, or to one of its replies when `comment_id` names one."""
    return add_update_reaction(repositories, context, project_id, update_id, payload)


@router.delete(
    "/{workspace_id}/projects/{project_id}/updates/{update_id}/reactions",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_update_reaction_route(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
    emoji: Annotated[str, Query(min_length=1, max_length=64)],
    comment_id: Annotated[Optional[str], Query()] = None,
) -> Response:
    """Take the caller's reaction off an update or one of its replies."""
    remove_update_reaction(repositories, context, project_id, update_id, emoji, comment_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
