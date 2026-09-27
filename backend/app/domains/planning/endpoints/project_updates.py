"""Project update routes: the feed, posting, editing and deleting, under one project.

An update is reached through its project, so a caller who can read the project
reads its feed and a writer on one of its visible teams posts to it. Editing and
deleting are its author's, or an admin's. The rules and the health mirroring
live in `app.common.project_updates`, which the MCP tools share.

Reactions and comments on updates are not offered: the discussion domain is
partitioned per issue, so they would need a partition of their own.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.planning import (
    MAX_LIMIT,
    UPDATES_DEFAULT_LIMIT,
    ProjectUpdateCreate,
    ProjectUpdateListRead,
    ProjectUpdatePatch,
    ProjectUpdateRead,
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
