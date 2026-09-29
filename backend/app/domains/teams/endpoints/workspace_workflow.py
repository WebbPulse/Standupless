"""Workspace status and label routes: the set every team of the workspace inherits.

Reads are open to any member, because every team's pickers draw on the set.
Writes are workspace admin, because one change reaches every team at once. A
team adjusts an inherited record for itself through the team override routes.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.common import team_workflow
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.teams import (
    LabelCreate,
    LabelListRead,
    LabelRead,
    LabelUpdate,
    StatusCreate,
    StatusListRead,
    StatusRead,
    StatusUpdate,
)

router = APIRouter()


@router.get("/{workspace_id}/statuses", response_model=StatusListRead)
def list_workspace_statuses(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusListRead:
    """Every workspace status, ordered by position."""
    ordered = team_workflow.ordered_workspace_statuses(repositories, context.workspace_id)
    return StatusListRead(statuses=[StatusRead.from_row(row) for row in ordered])


@router.post("/{workspace_id}/statuses", response_model=StatusRead, status_code=status.HTTP_201_CREATED)
def create_workspace_status(
    payload: StatusCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusRead:
    """Add a status every team inherits, defaulting its position to the end."""
    return StatusRead.from_row(team_workflow.create_workspace_status(repositories, context.workspace_id, payload))


@router.patch("/{workspace_id}/statuses/{status_id}", response_model=StatusRead)
def update_workspace_status(
    payload: StatusUpdate,
    status_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusRead:
    """Rename, recategorise, recolor or move a workspace status for every team."""
    updated = team_workflow.update_workspace_status(repositories, context.workspace_id, status_id, payload)
    return StatusRead.from_row(updated)


@router.delete("/{workspace_id}/statuses/{status_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace_status(
    status_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a workspace status, refusing when a team would lose its last visible status of the category."""
    team_workflow.delete_workspace_status(repositories, context.workspace_id, status_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/labels", response_model=LabelListRead)
def list_workspace_labels(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelListRead:
    """Every workspace label, in name order."""
    ordered = team_workflow.ordered_workspace_labels(repositories, context.workspace_id)
    return LabelListRead(labels=[LabelRead.from_row(row) for row in ordered])


@router.post("/{workspace_id}/labels", response_model=LabelRead, status_code=status.HTTP_201_CREATED)
def create_workspace_label(
    payload: LabelCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelRead:
    """Add a label every team inherits."""
    return LabelRead.from_row(team_workflow.create_workspace_label(repositories, context.workspace_id, payload))


@router.patch("/{workspace_id}/labels/{label_id}", response_model=LabelRead)
def update_workspace_label(
    payload: LabelUpdate,
    label_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelRead:
    """Rename or recolour a workspace label for every team."""
    return LabelRead.from_row(
        team_workflow.update_workspace_label(repositories, context.workspace_id, label_id, payload)
    )


@router.delete("/{workspace_id}/labels/{label_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace_label(
    label_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a workspace label, unconditionally, as a team label delete is."""
    team_workflow.delete_workspace_label(repositories, context.workspace_id, label_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
