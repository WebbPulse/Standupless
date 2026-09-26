"""Cycle routes: list, create, read, patch and delete, plus history and velocity.

Cycles are workspace scoped like issues, so the team is a query parameter or a
body field rather than a path segment, and every route decides visibility against
the cycle's own team through the service helpers. A cycle's status is never
stored: it is derived from its dates on the way out, so nothing has to write at
midnight for a cycle to become active.

A cycle's history and a team's velocity are folds over the daily snapshots the
rollup consumer writes, so neither route reads the `issues` table.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from webbpulse.dynamodb import ConditionFailed
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import Cycle, cycle_key, new_planning_id
from app.common.db.dynamo.teams import DEFAULT_ESTIMATE_SCALE
from app.domains.planning.history import (
    average,
    burn_up,
    closed_cycles,
    planning_cycle,
    velocity_entry,
)
from app.domains.planning.schemas.planning import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    CycleCapacityRead,
    CycleCreate,
    CycleHistoryPoint,
    CycleHistoryRead,
    CycleListRead,
    CycleRead,
    CycleStatusField,
    CycleUpdate,
    VelocityCycleRead,
    VelocityRead,
)
from app.domains.planning.service import (
    check_dates,
    load_readable_cycle,
    not_found,
    require_team_admin,
    require_team_member,
    require_team_reader,
)

router = APIRouter()

VELOCITY_DEFAULT_CYCLES = 6
"""How many completed cycles a velocity reads when the caller names no count."""

VELOCITY_MAX_CYCLES = 12
"""The most completed cycles one velocity read folds over."""


@router.get("/{workspace_id}/cycles", response_model=CycleListRead)
def list_cycles(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[str, Query()],
    status_filter: Annotated[Optional[CycleStatusField], Query(alias="status")] = None,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[CycleRead]:
    """One page of a team's cycles, by start date ascending.

    The team is required rather than optional: a workspace-wide cycle list is
    what the roadmap answers, and it answers it in date order across both entities
    rather than as an undated pile of one of them.

    The status filter is applied after the read because status is derived, so no
    index can carry it.
    """
    require_team_reader(repositories, context, team_id)
    scope = f"cycles:{context.workspace_id}:{team_id}"
    start_key = decode_cursor(cursor, scope)
    rows, last_key = repositories.planning.list_cycles(
        context.workspace_id,
        team_id,
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
    """Create a cycle in one team.

    Overlapping cycles are allowed: a team moving a cycle's dates would otherwise
    have to delete and recreate it, and nothing downstream assumes an issue belongs
    to at most one cycle in flight.
    """
    require_team_member(repositories, context, payload.team_id)
    if repositories.teams.get(context.workspace_id, payload.team_id) is None:
        raise not_found()

    cycle_id = new_planning_id()
    cycle = Cycle(
        workspace_id=context.workspace_id,
        planning_key=cycle_key(payload.team_id, cycle_id),
        cycle_id=cycle_id,
        team_id=payload.team_id,
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


@router.get("/{workspace_id}/cycles/velocity", response_model=VelocityRead)
def read_velocity(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[str, Query()],
    limit: Annotated[int, Query(ge=1, le=VELOCITY_MAX_CYCLES)] = VELOCITY_DEFAULT_CYCLES,
) -> VelocityRead:
    """A team's completed work over its last completed cycles, and the cycle to plan next.

    Each cycle's figures are its value on its end date, so issues a cycle close
    carried out the day after still count toward the scope it ended with and not
    toward its completed work. Registered before the cycle id route so `velocity`
    is never read as a cycle id.
    """
    require_team_reader(repositories, context, team_id)
    team = repositories.teams.get(context.workspace_id, team_id)
    if team is None:
        raise not_found()

    today = date.today().isoformat()
    cycles = repositories.planning.list_for_roadmap(context.workspace_id, team_id)
    entries = [
        velocity_entry(cycle, repositories.planning.list_cycle_history(context.workspace_id, team_id, cycle.cycle_id))
        for cycle in closed_cycles(cycles, today, limit)
    ]
    bodies = [
        VelocityCycleRead(
            cycle_id=entry.cycle.cycle_id,
            name=entry.cycle.name,
            start_date=entry.cycle.start_date,
            end_date=entry.cycle.end_date,
            completed_issues=entry.at_close.completed,
            completed_points=entry.at_close.completed_points,
            scope_issues=entry.at_close.scope,
            scope_points=entry.at_close.scope_points,
            carried_out=entry.cycle.carry.carried_out,
            carried_out_points=entry.cycle.carry.carried_out_points,
        )
        for entry in entries
    ]

    upcoming: Optional[CycleCapacityRead] = None
    target = planning_cycle(cycles, today)
    if target is not None:
        upcoming = CycleCapacityRead(
            cycle_id=target.cycle_id,
            name=target.name,
            status=target.status(today),  # pyright: ignore[reportArgumentType]
            start_date=target.start_date,
            end_date=target.end_date,
            scope_issues=target.counts.scope,
            scope_points=target.points.scope,
            carried_in=target.carry.carried_in,
            carried_in_points=target.carry.carried_in_points,
        )

    return VelocityRead(
        team_id=team_id,
        estimate_scale=team.estimate_scale or DEFAULT_ESTIMATE_SCALE,
        cycles=bodies,
        average_points=average([body.completed_points for body in bodies]),
        average_issues=average([body.completed_issues for body in bodies]),
        upcoming=upcoming,
    )


@router.get("/{workspace_id}/cycles/{cycle_id}/history", response_model=CycleHistoryRead)
def read_cycle_history(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    cycle_id: Annotated[str, Path()],
    team_id: Annotated[str, Query()],
) -> CycleHistoryRead:
    """A cycle's daily scope, started and completed figures, from its first day on.

    One value per day up to today or the cycle's end, whichever is sooner. A day
    with no move of its own carries the previous day's value forward, and today
    always reads the live counters.
    """
    cycle = load_readable_cycle(repositories, context, team_id, cycle_id)
    today = date.today().isoformat()
    snapshots = repositories.planning.list_cycle_history(context.workspace_id, team_id, cycle_id)
    return CycleHistoryRead(
        cycle_id=cycle.cycle_id,
        team_id=cycle.team_id,
        start_date=cycle.start_date,
        end_date=cycle.end_date,
        status=cycle.status(today),  # pyright: ignore[reportArgumentType]
        today=today,
        days=[CycleHistoryPoint(**vars(day)) for day in burn_up(cycle, snapshots, today)],
    )


@router.get("/{workspace_id}/cycles/{cycle_id}", response_model=CycleRead)
def read_cycle(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    cycle_id: Annotated[str, Path()],
    team_id: Annotated[str, Query()],
) -> CycleRead:
    """One cycle, or a 404 when the caller cannot see its team."""
    return CycleRead.from_row(load_readable_cycle(repositories, context, team_id, cycle_id))


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
    existing = load_readable_cycle(repositories, context, payload.team_id, cycle_id)
    require_team_member(repositories, context, payload.team_id)

    fields = payload.model_dump(exclude_unset=True, exclude={"team_id"})
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
    team_id: Annotated[str, Query()],
) -> Response:
    """Delete a cycle, leaving every issue that pointed at it in place.

    The issues are not rewritten: an issue carrying a dead cycle id reads as
    unassigned, and rewriting a team's whole issue set from a planning route
    would be exactly the second write path the design forbids. The cycle's daily
    snapshots go with it.
    """
    load_readable_cycle(repositories, context, team_id, cycle_id)
    require_team_admin(repositories, context, team_id)
    repositories.planning.delete(context.workspace_id, cycle_key(team_id, cycle_id))
    repositories.planning.delete_cycle_history(context.workspace_id, team_id, cycle_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
