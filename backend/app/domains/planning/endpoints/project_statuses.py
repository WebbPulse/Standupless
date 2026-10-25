"""Project status routes: the workspace's own project statuses, each inside one fixed category.

Any reader of the workspace lists them, and only a workspace admin adds, edits,
reorders or deletes one. The rules live in `app.common.project_statuses`, which
the MCP tools share.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.project_statuses import (
    ProjectStatusCreate,
    ProjectStatusListRead,
    ProjectStatusRead,
    ProjectStatusUpdate,
)
from app.common.project_statuses import (
    create_project_status,
    delete_project_status,
    list_project_statuses,
    update_project_status,
)

router = APIRouter()


@router.get("/{workspace_id}/project-statuses", response_model=ProjectStatusListRead)
def list_statuses(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> ProjectStatusListRead:
    """Every project status by category then position, each with how many projects the caller can see sit in it."""
    return list_project_statuses(repositories, context)


@router.post("/{workspace_id}/project-statuses", response_model=ProjectStatusRead, status_code=status.HTTP_201_CREATED)
def add_status(
    payload: ProjectStatusCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> ProjectStatusRead:
    """Add a project status to a category, as a workspace admin; a taken name answers 409."""
    return create_project_status(repositories, context, payload)


@router.patch("/{workspace_id}/project-statuses/{status_id}", response_model=ProjectStatusRead)
def edit_status(
    payload: ProjectStatusUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    status_id: Annotated[str, Path()],
) -> ProjectStatusRead:
    """Rename, recolour, redescribe or reorder a project status, as a workspace admin."""
    return update_project_status(repositories, context, status_id, payload)


@router.delete("/{workspace_id}/project-statuses/{status_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_status(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    status_id: Annotated[str, Path()],
    replacement_status_id: Annotated[Optional[str], Query(min_length=1)] = None,
) -> Response:
    """Delete a project status and move its projects onto a replacement in the same category, as a workspace admin."""
    delete_project_status(repositories, context, status_id, replacement_status_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
