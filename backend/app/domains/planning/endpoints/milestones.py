"""Project milestone routes: list, create, patch and delete, under one project.

A milestone is reached through its project, so visibility and edit rights are the
project's own: a caller who can read the project reads its milestones, and a
writer on one of its visible teams edits them. The write rules live in
`app.common.milestone_writes`, which the MCP tools share.

Deleting a milestone leaves its issues in place. The issues domain clears the
milestone off each of them from the planning stream, because planning never
writes the issues table.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.planning import (
    MilestoneCreate,
    MilestoneListRead,
    MilestoneRead,
    MilestoneUpdate,
)
from app.common.milestone_writes import MILESTONES_MAX, sort_order_after
from app.common.milestone_writes import create_milestone as create_milestone_row
from app.common.milestone_writes import delete_milestone as delete_milestone_row
from app.common.milestone_writes import update_milestone as update_milestone_row
from app.common.planning_rules import load_readable_project

__all__ = ["MILESTONES_MAX", "router", "sort_order_after"]

router = APIRouter()


@router.get("/{workspace_id}/projects/{project_id}/milestones", response_model=MilestoneListRead)
def list_milestones(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> Any:
    """Every milestone of one project, in its manual order, with progress counts.

    A project holds a bounded set, so the list is answered whole and never pages.
    """
    load_readable_project(repositories, context, project_id)
    rows = repositories.planning.list_milestones(context.workspace_id, project_id)
    return MilestoneListRead(items=[MilestoneRead.from_row(row) for row in rows], next_cursor=None)


@router.post(
    "/{workspace_id}/projects/{project_id}/milestones",
    response_model=MilestoneRead,
    status_code=status.HTTP_201_CREATED,
)
def create_milestone(
    payload: MilestoneCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> MilestoneRead:
    """Add a milestone to a project, after the last one unless a position is given."""
    return create_milestone_row(repositories, context, project_id, payload)


@router.patch("/{workspace_id}/projects/{project_id}/milestones/{milestone_id}", response_model=MilestoneRead)
def update_milestone(
    payload: MilestoneUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    milestone_id: Annotated[str, Path()],
) -> MilestoneRead:
    """Rename, redate, redescribe or reorder one milestone.

    The row is read first and written whole, so the counters the rollup consumer
    maintains ride along untouched.
    """
    return update_milestone_row(repositories, context, project_id, milestone_id, payload)


@router.delete(
    "/{workspace_id}/projects/{project_id}/milestones/{milestone_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_milestone(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    milestone_id: Annotated[str, Path()],
) -> Response:
    """Delete one milestone; its issues stay in the project with no milestone.

    Takes the same right as editing the project, since it removes a stage of the
    plan rather than any team's work.
    """
    delete_milestone_row(repositories, context, project_id, milestone_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
