"""Status routes: the workflow columns a team's issues move through.

A team always keeps at least one status per category it still uses, so the
delete route refuses the last one of a category rather than leaving issues with
nowhere to sit once M2 adds them.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.team_config import Status, new_config_id, status_key
from app.domains.teams.schemas.team import (
    StatusCreate,
    StatusListRead,
    StatusRead,
    StatusUpdate,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

LAST_OF_CATEGORY = {
    "error_code": "CONFLICT",
    "message": "A team must keep one status in each category it uses",
}


@router.get("/{workspace_id}/teams/{team_id}/statuses", response_model=StatusListRead)
def list_statuses(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusListRead:
    """Every status of the team, ordered by position."""
    rows = repositories.team_config.list_statuses(context.workspace_id, str(context.team_id))
    ordered = sorted(rows, key=lambda row: (row.position, row.name))
    return StatusListRead(statuses=[StatusRead.from_row(row) for row in ordered])


@router.post(
    "/{workspace_id}/teams/{team_id}/statuses",
    response_model=StatusRead,
    status_code=status.HTTP_201_CREATED,
)
def create_status(
    payload: StatusCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusRead:
    """Add a status, defaulting its position to the end of the list."""
    team_id = str(context.team_id)
    position = payload.position
    if position is None:
        existing = repositories.team_config.list_statuses(context.workspace_id, team_id)
        position = max((row.position for row in existing), default=-1) + 1

    status_id = new_config_id()
    created = repositories.team_config.create_status(
        Status(
            workspace_id=context.workspace_id,
            config_key=status_key(team_id, status_id),
            team_id=team_id,
            status_id=status_id,
            name=payload.name,
            category=payload.category,
            position=position,
        )
    )
    return StatusRead.from_row(created)


@router.patch("/{workspace_id}/teams/{team_id}/statuses/{status_id}", response_model=StatusRead)
def update_status(
    payload: StatusUpdate,
    status_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusRead:
    """Rename a status, recategorise it or move it in the order."""
    team_id = str(context.team_id)
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not attributes:
        existing = repositories.team_config.get_status(context.workspace_id, team_id, status_id)
        if existing is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
        return StatusRead.from_row(existing)

    updated = repositories.team_config.update_status(context.workspace_id, team_id, status_id, **attributes)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return StatusRead.from_row(updated)


@router.delete(
    "/{workspace_id}/teams/{team_id}/statuses/{status_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_status(
    status_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a status, refusing the last one of its category.

    The board renders a column per category, so removing the only status of one
    would leave a category that can be assigned but never displayed.
    """
    team_id = str(context.team_id)
    existing = repositories.team_config.get_status(context.workspace_id, team_id, status_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)

    siblings = [
        row
        for row in repositories.team_config.list_statuses(context.workspace_id, team_id)
        if row.category == existing.category and row.status_id != status_id
    ]
    if not siblings:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_OF_CATEGORY)

    repositories.team_config.delete_status(context.workspace_id, team_id, status_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
