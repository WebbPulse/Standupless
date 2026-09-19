"""Milestone routes: list, create, read, patch and delete.

A milestone's status is stored rather than derived, because its one date is a
target and a target says nothing about whether the work has started. Everything
else mirrors the cycle routes, including that the project travels in the query or
the body rather than the path.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from webbpulse.dynamodb import ConditionFailed
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import Milestone, milestone_key, new_planning_id
from app.domains.planning.schemas.planning import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    MilestoneCreate,
    MilestoneListRead,
    MilestoneRead,
    MilestoneStatusField,
    MilestoneUpdate,
)
from app.domains.planning.service import (
    load_readable_milestone,
    not_found,
    require_project_admin,
    require_project_member,
    require_project_reader,
)

router = APIRouter()


@router.get("/{workspace_id}/milestones", response_model=MilestoneListRead)
def list_milestones(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Query()],
    status_filter: Annotated[Optional[MilestoneStatusField], Query(alias="status")] = None,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[MilestoneRead]:
    """One page of a project's milestones, by target date ascending, undated last.

    Undated milestones sort last rather than first, because an absent target is a
    milestone nobody has committed to yet and putting it ahead of dated work would
    read as the most urgent thing on the list.
    """
    require_project_reader(repositories, context, project_id)
    scope = f"milestones:{context.workspace_id}:{project_id}"
    start_key = decode_cursor(cursor, scope)
    rows, last_key = repositories.planning.list_milestones(
        context.workspace_id,
        project_id,
        limit=limit,
        start_key=start_key,
    )
    if status_filter is not None:
        rows = [row for row in rows if row.status == status_filter]
    bodies = [MilestoneRead.from_row(row) for row in rows]
    return MilestoneListRead(items=bodies, next_cursor=encode_cursor(last_key, scope))


@router.post("/{workspace_id}/milestones", response_model=MilestoneRead, status_code=status.HTTP_201_CREATED)
def create_milestone(
    payload: MilestoneCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> MilestoneRead:
    """Create a milestone in one project."""
    require_project_member(repositories, context, payload.project_id)
    if repositories.projects.get(context.workspace_id, payload.project_id) is None:
        raise not_found()

    milestone_id = new_planning_id()
    milestone = Milestone(
        workspace_id=context.workspace_id,
        planning_key=milestone_key(payload.project_id, milestone_id),
        milestone_id=milestone_id,
        project_id=payload.project_id,
        name=payload.name,
        description=payload.description,
        target_date=payload.target_date,
        status=payload.status,
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


@router.get("/{workspace_id}/milestones/{milestone_id}", response_model=MilestoneRead)
def read_milestone(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    milestone_id: Annotated[str, Path()],
    project_id: Annotated[str, Query()],
) -> MilestoneRead:
    """One milestone, or a 404 when the caller cannot see its project."""
    return MilestoneRead.from_row(load_readable_milestone(repositories, context, project_id, milestone_id))


@router.patch("/{workspace_id}/milestones/{milestone_id}", response_model=MilestoneRead)
def update_milestone(
    payload: MilestoneUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    milestone_id: Annotated[str, Path()],
) -> MilestoneRead:
    """Patch a milestone's name, description, target date or status.

    Setting `target_date` to null clears it, which takes the row out of the roadmap
    index rather than leaving it indexed under an empty date.
    """
    existing = load_readable_milestone(repositories, context, payload.project_id, milestone_id)
    require_project_member(repositories, context, payload.project_id)

    fields = payload.model_dump(exclude_unset=True, exclude={"project_id"})
    updated = existing.model_copy(update={**fields, "updated_at": utc_now()})

    try:
        stored = repositories.planning.replace_milestone(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    return MilestoneRead.from_row(stored)


@router.delete("/{workspace_id}/milestones/{milestone_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_milestone(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    milestone_id: Annotated[str, Path()],
    project_id: Annotated[str, Query()],
) -> Response:
    """Delete a milestone, leaving every issue that pointed at it in place."""
    load_readable_milestone(repositories, context, project_id, milestone_id)
    require_project_admin(repositories, context, project_id)
    repositories.planning.delete(context.workspace_id, milestone_key(project_id, milestone_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
