"""Label routes: the free-form tags a team's issues carry.

Labels have no invariant a status has: nothing depends on one existing, so the
delete route is unconditional. A team's list is its own labels plus the workspace
ones it inherits, and the override routes hide or rename an inherited one here only.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common import team_workflow
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.teams import (
    LabelCreate,
    LabelListRead,
    LabelRead,
    LabelUpdate,
    OverrideUpdate,
)
from app.common.labels import create_label as create_label_row
from app.common.labels import ordered_labels

router = APIRouter()


@router.get("/{workspace_id}/teams/{team_id}/labels", response_model=LabelListRead)
def list_labels(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    include_hidden: Annotated[bool, Query(description="Also answer the inherited labels the team hid.")] = False,
) -> LabelListRead:
    """Every label of the team, its own and the inherited ones, in name order."""
    ordered = ordered_labels(repositories, context.workspace_id, str(context.team_id), include_hidden=include_hidden)
    return LabelListRead(labels=[LabelRead.from_row(row) for row in ordered])


@router.post(
    "/{workspace_id}/teams/{team_id}/labels",
    response_model=LabelRead,
    status_code=status.HTTP_201_CREATED,
)
def create_label(
    payload: LabelCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelRead:
    """Add a label to the team."""
    created = create_label_row(repositories, context.workspace_id, str(context.team_id), payload)
    return LabelRead.from_row(created)


@router.patch("/{workspace_id}/teams/{team_id}/labels/{label_id}", response_model=LabelRead)
def update_label(
    payload: LabelUpdate,
    label_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelRead:
    """Rename or recolour a label."""
    updated = team_workflow.update_label(repositories, context.workspace_id, str(context.team_id), label_id, payload)
    return LabelRead.from_row(updated)


@router.delete(
    "/{workspace_id}/teams/{team_id}/labels/{label_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_label(
    label_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a label and take it off every issue of the team carrying it."""
    team_workflow.delete_label(repositories, context.workspace_id, str(context.team_id), label_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch("/{workspace_id}/teams/{team_id}/labels/{label_id}/override", response_model=LabelRead)
def override_label(
    payload: OverrideUpdate,
    label_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelRead:
    """Hide, show or rename an inherited workspace label in this team, a null name clearing the rename."""
    updated = team_workflow.set_label_override(
        repositories, context.workspace_id, str(context.team_id), label_id, payload
    )
    return LabelRead.from_row(updated)


@router.delete("/{workspace_id}/teams/{team_id}/labels/{label_id}/override", response_model=LabelRead)
def clear_label_override(
    label_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelRead:
    """Drop this team's override of an inherited label, showing it under its workspace name."""
    cleared = team_workflow.clear_label_override(repositories, context.workspace_id, str(context.team_id), label_id)
    return LabelRead.from_row(cleared)
