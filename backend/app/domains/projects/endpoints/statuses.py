"""Status routes: the workflow columns a project's issues move through.

A project always keeps at least one status per category it still uses, so the
delete route refuses the last one of a category rather than leaving issues with
nowhere to sit once M2 adds them.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.project_config import Status, new_config_id, status_key
from app.domains.projects.schemas.project import (
    StatusCreate,
    StatusListRead,
    StatusRead,
    StatusUpdate,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

LAST_OF_CATEGORY = {
    "error_code": "CONFLICT",
    "message": "A project must keep one status in each category it uses",
}


@router.get("/{workspace_id}/projects/{project_id}/statuses", response_model=StatusListRead)
def list_statuses(
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusListRead:
    """Every status of the project, ordered by position."""
    rows = repositories.project_config.list_statuses(context.workspace_id, str(context.project_id))
    ordered = sorted(rows, key=lambda row: (row.position, row.name))
    return StatusListRead(statuses=[StatusRead.from_row(row) for row in ordered])


@router.post(
    "/{workspace_id}/projects/{project_id}/statuses",
    response_model=StatusRead,
    status_code=status.HTTP_201_CREATED,
)
def create_status(
    payload: StatusCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusRead:
    """Add a status, defaulting its position to the end of the list."""
    project_id = str(context.project_id)
    position = payload.position
    if position is None:
        existing = repositories.project_config.list_statuses(context.workspace_id, project_id)
        position = max((row.position for row in existing), default=-1) + 1

    status_id = new_config_id()
    created = repositories.project_config.create_status(
        Status(
            workspace_id=context.workspace_id,
            config_key=status_key(project_id, status_id),
            project_id=project_id,
            status_id=status_id,
            name=payload.name,
            category=payload.category,
            position=position,
        )
    )
    return StatusRead.from_row(created)


@router.patch("/{workspace_id}/projects/{project_id}/statuses/{status_id}", response_model=StatusRead)
def update_status(
    payload: StatusUpdate,
    status_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusRead:
    """Rename a status, recategorise it or move it in the order."""
    project_id = str(context.project_id)
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not attributes:
        existing = repositories.project_config.get_status(context.workspace_id, project_id, status_id)
        if existing is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
        return StatusRead.from_row(existing)

    updated = repositories.project_config.update_status(context.workspace_id, project_id, status_id, **attributes)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return StatusRead.from_row(updated)


@router.delete(
    "/{workspace_id}/projects/{project_id}/statuses/{status_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_status(
    status_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a status, refusing the last one of its category.

    The board renders a column per category, so removing the only status of one
    would leave a category that can be assigned but never displayed.
    """
    project_id = str(context.project_id)
    existing = repositories.project_config.get_status(context.workspace_id, project_id, status_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)

    siblings = [
        row
        for row in repositories.project_config.list_statuses(context.workspace_id, project_id)
        if row.category == existing.category and row.status_id != status_id
    ]
    if not siblings:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_OF_CATEGORY)

    repositories.project_config.delete_status(context.workspace_id, project_id, status_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
