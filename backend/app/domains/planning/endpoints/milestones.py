"""Project milestone routes: list, create, patch and delete, under one project.

A milestone is reached through its project, so visibility and edit rights are the
project's own: a caller who can read the project reads its milestones, and a
writer on one of its visible teams edits them. Reordering is a patch of
`sort_order`, a base 62 fractional key, so a drag rewrites one row.

Deleting a milestone leaves its issues in place. The issues domain clears the
milestone off each of them from the planning stream, because planning never
writes the issues table.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import ProjectMilestone, milestone_key, new_planning_id
from app.domains.planning.schemas.planning import (
    MilestoneCreate,
    MilestoneListRead,
    MilestoneRead,
    MilestoneUpdate,
)
from app.domains.planning.service import (
    load_readable_project,
    not_found,
    require_project_editor,
    unprocessable,
)

router = APIRouter()

MILESTONES_MAX = 100
"""How many milestones one project may hold; a plan, not a backlog."""

BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

FIRST_SORT_ORDER = "V"
"""Where the first milestone lands, near the middle of the alphabet so either end has room."""


def sort_order_after(last: str | None) -> str:
    """A base 62 key that sorts after `last`, or the first key when there is none.

    Bumps the final character when it has room and otherwise appends one, so the
    key stays short and still sorts after every key it follows.
    """
    if not last:
        return FIRST_SORT_ORDER
    position = BASE62.find(last[-1])
    if 0 <= position < len(BASE62) - 1:
        return last[:-1] + BASE62[position + 1]
    return last + FIRST_SORT_ORDER


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
    _, teams = load_readable_project(repositories, context, project_id)
    require_project_editor(repositories, context, teams)

    existing = repositories.planning.list_milestones(context.workspace_id, project_id)
    if len(existing) >= MILESTONES_MAX:
        raise unprocessable(f"A project holds at most {MILESTONES_MAX} milestones")
    sort_order = payload.sort_order or sort_order_after(existing[-1].sort_order if existing else None)

    milestone_id = new_planning_id()
    milestone = ProjectMilestone(
        workspace_id=context.workspace_id,
        planning_key=milestone_key(project_id, milestone_id),
        milestone_id=milestone_id,
        project_id=project_id,
        name=payload.name,
        description=payload.description,
        target_date=payload.target_date,
        sort_order=sort_order,
        created_by=context.user_id,
    )
    try:
        created = repositories.planning.create_milestone(milestone)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That milestone already exists"},
        ) from exc
    return MilestoneRead.from_row(created)


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
    _, teams = load_readable_project(repositories, context, project_id)
    require_project_editor(repositories, context, teams)
    existing = repositories.planning.get_milestone(context.workspace_id, project_id, milestone_id)
    if existing is None:
        raise not_found()

    fields: dict[str, Any] = payload.model_dump(exclude_unset=True)
    for name in ("name", "sort_order"):
        if name in fields and fields[name] is None:
            raise unprocessable(f"{name} must not be null")

    updated = existing.model_copy(update={**fields, "updated_at": utc_now()})
    try:
        stored = repositories.planning.replace_milestone(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    return MilestoneRead.from_row(stored)


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
    _, teams = load_readable_project(repositories, context, project_id)
    require_project_editor(repositories, context, teams)
    if not repositories.planning.delete(context.workspace_id, milestone_key(project_id, milestone_id)):
        raise not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
