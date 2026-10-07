"""Status routes: the workflow columns a team's issues move through.

A team always keeps at least one visible status per category it still uses, so
the delete route refuses the last one of a category rather than leaving issues
with nowhere to sit once M2 adds them, and the override route refuses to hide it.

A team's list is its effective set: its own statuses and the workspace ones it
inherits, each tagged with its `scope`. The override routes hide or rename an
inherited status in this team only.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common import team_workflow
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.teams import (
    OverrideUpdate,
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
    include_hidden: Annotated[bool, Query(description="Also answer the inherited statuses the team hid.")] = False,
) -> StatusListRead:
    """Every status of the team, its own and the inherited ones, ordered by position."""
    ordered = team_workflow.ordered_statuses(
        repositories, context.workspace_id, str(context.team_id), include_hidden=include_hidden
    )
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
    replacement_status_id: Annotated[str | None, Query(min_length=1)] = None,
) -> Response:
    """Delete a status, moving its issues to `replacement_status_id`.

    The last visible status of a category is a 409, because the board renders a
    column per category. A status still holding issues is a 409 carrying
    `details.issue_count` until a replacement is named.
    """
    team_workflow.delete_status(
        repositories,
        context.workspace_id,
        str(context.team_id),
        status_id,
        actor_id=context.user_id,
        source=context.source,
        replacement_status_id=replacement_status_id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch("/{workspace_id}/teams/{team_id}/statuses/{status_id}/override", response_model=StatusRead)
def override_status(
    payload: OverrideUpdate,
    status_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusRead:
    """Hide, show or rename an inherited workspace status in this team, a null name clearing the rename."""
    updated = team_workflow.set_status_override(
        repositories, context.workspace_id, str(context.team_id), status_id, payload
    )
    return StatusRead.from_row(updated)


@router.delete("/{workspace_id}/teams/{team_id}/statuses/{status_id}/override", response_model=StatusRead)
def clear_status_override(
    status_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusRead:
    """Drop this team's override of an inherited status, showing it under its workspace name."""
    cleared = team_workflow.clear_status_override(repositories, context.workspace_id, str(context.team_id), status_id)
    return StatusRead.from_row(cleared)
