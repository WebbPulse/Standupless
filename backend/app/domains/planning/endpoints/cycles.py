"""Cycle routes: list, create, read, patch and delete.

Cycles are workspace scoped like issues, so the project is a query parameter or a
body field rather than a path segment, and every route decides visibility against
the cycle's own project through the service helpers. A cycle's status is never
stored: it is derived from its dates on the way out, so nothing has to write at
midnight for a cycle to become active.
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
from app.common.db.dynamo.planning import Cycle, cycle_key, new_planning_id
from app.domains.planning.schemas.planning import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    CycleCreate,
    CycleListRead,
    CycleRead,
    CycleStatusField,
    CycleUpdate,
)
from app.domains.planning.service import (
    check_dates,
    load_readable_cycle,
    not_found,
    require_project_admin,
    require_project_member,
    require_project_reader,
)

router = APIRouter()


@router.get("/{workspace_id}/cycles", response_model=CycleListRead)
def list_cycles(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Query()],
    status_filter: Annotated[Optional[CycleStatusField], Query(alias="status")] = None,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[CycleRead]:
    """One page of a project's cycles, by start date ascending.

    The project is required rather than optional: a workspace-wide cycle list is
    what the roadmap answers, and it answers it in date order across both entities
    rather than as an undated pile of one of them.

    The status filter is applied after the read because status is derived, so no
    index can carry it.
    """
    require_project_reader(repositories, context, project_id)
    scope = f"cycles:{context.workspace_id}:{project_id}"
    start_key = decode_cursor(cursor, scope)
    rows, last_key = repositories.planning.list_cycles(
        context.workspace_id,
        project_id,
        limit=limit,
        start_key=start_key,
    )
    bodies = [CycleRead.from_row(row) for row in rows]
    if status_filter is not None:
        bodies = [body for body in bodies if body.status == status_filter]
    return CycleListRead(items=bodies, next_cursor=encode_cursor(last_key, scope))


@router.post("/{workspace_id}/cycles", response_model=CycleRead, status_code=status.HTTP_201_CREATED)
def create_cycle(
    payload: CycleCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> CycleRead:
    """Create a cycle in one project.

    Overlapping cycles are allowed: a team moving a cycle's dates would otherwise
    have to delete and recreate it, and nothing downstream assumes an issue belongs
    to at most one cycle in flight.
    """
    require_project_member(repositories, context, payload.project_id)
    if repositories.projects.get(context.workspace_id, payload.project_id) is None:
        raise not_found()

    cycle_id = new_planning_id()
    cycle = Cycle(
        workspace_id=context.workspace_id,
        planning_key=cycle_key(payload.project_id, cycle_id),
        cycle_id=cycle_id,
        project_id=payload.project_id,
        name=payload.name,
        start_date=payload.start_date,
        end_date=payload.end_date,
        goal=payload.goal,
        created_by=context.user_id,
    )
    try:
        created = repositories.planning.create_cycle(cycle)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That cycle already exists"},
        ) from exc
    return CycleRead.from_row(created)


@router.get("/{workspace_id}/cycles/{cycle_id}", response_model=CycleRead)
def read_cycle(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    cycle_id: Annotated[str, Path()],
    project_id: Annotated[str, Query()],
) -> CycleRead:
    """One cycle, or a 404 when the caller cannot see its project."""
    return CycleRead.from_row(load_readable_cycle(repositories, context, project_id, cycle_id))


@router.patch("/{workspace_id}/cycles/{cycle_id}", response_model=CycleRead)
def update_cycle(
    payload: CycleUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    cycle_id: Annotated[str, Path()],
) -> CycleRead:
    """Patch a cycle's name, dates, goal or cancellation.

    The row is read first and written whole, so the counters the consumer maintains
    ride along untouched: a patch here must never become a second write path into
    the numbers the stream owns.
    """
    existing = load_readable_cycle(repositories, context, payload.project_id, cycle_id)
    require_project_member(repositories, context, payload.project_id)

    fields = payload.model_dump(exclude_unset=True, exclude={"project_id"})
    updated = existing.model_copy(update={**fields, "updated_at": utc_now()})
    check_dates(updated.start_date, updated.end_date)

    try:
        stored = repositories.planning.replace_cycle(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    return CycleRead.from_row(stored)


@router.delete("/{workspace_id}/cycles/{cycle_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cycle(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    cycle_id: Annotated[str, Path()],
    project_id: Annotated[str, Query()],
) -> Response:
    """Delete a cycle, leaving every issue that pointed at it in place.

    The issues are not rewritten: an issue carrying a dead cycle id reads as
    unassigned, and rewriting a project's whole issue set from a planning route
    would be exactly the second write path the design forbids.
    """
    load_readable_cycle(repositories, context, project_id, cycle_id)
    require_project_admin(repositories, context, project_id)
    repositories.planning.delete(context.workspace_id, cycle_key(project_id, cycle_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
