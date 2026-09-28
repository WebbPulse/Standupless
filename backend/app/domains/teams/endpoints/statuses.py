"""Status routes: the workflow columns a team's issues move through.

A team always keeps at least one status per category it still uses, so the
delete route refuses the last one of a category rather than leaving issues with
nowhere to sit once M2 adds them.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.common import team_workflow
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.teams import (
    StatusCreate,
    StatusListRead,
    StatusRead,
    StatusUpdate,
)

router = APIRouter()


@router.get("/{workspace_id}/teams/{team_id}/statuses", response_model=StatusListRead)
def list_statuses(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusListRead:
    """Every status of the team, ordered by position."""
    ordered = team_workflow.ordered_statuses(repositories, context.workspace_id, str(context.team_id))
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
    created = team_workflow.create_status(repositories, context.workspace_id, str(context.team_id), payload)
    return StatusRead.from_row(created)


@router.patch("/{workspace_id}/teams/{team_id}/statuses/{status_id}", response_model=StatusRead)
def update_status(
    payload: StatusUpdate,
    status_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusRead:
    """Rename a status, recategorise it or move it in the order."""
    updated = team_workflow.update_status(repositories, context.workspace_id, str(context.team_id), status_id, payload)
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
    team_workflow.delete_status(repositories, context.workspace_id, str(context.team_id), status_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
