"""Cycle list, create, patch and delete, shared by the cycle routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a cycle an agent plans must pass the same team rules a person's does:
any member of the team creates or edits one, and only its administrator deletes
one, since a delete detaches every issue that pointed at it.
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed, encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import decode_offset_cursor, encode_offset_cursor, resume_key
from app.common.api.schemas.planning import CycleCreate, CycleRead, CycleUpdate
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import Cycle, cycle_key, new_planning_id
from app.common.planning_rules import (
    check_dates,
    counts_unestimated,
    load_readable_cycle,
    not_found,
    require_team_admin,
    require_team_member,
    require_team_reader,
)
from app.common.sub_teams import listed_teams


def list_cycles(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    *,
    status_filter: Optional[str],
    cursor: Optional[str],
    limit: int,
    include_sub_teams: bool = False,
) -> tuple[list[CycleRead], Optional[str]]:
    """One page of a team's cycles by start date, and the next cursor.

    The status is derived from the dates, so it is filtered after the read and a
    single team's page can come back short while the cursor still names more.
    `include_sub_teams` adds the cycles of the team's sub-teams the caller may
    read, as the issue list does, so a private sub-team stays out for anyone
    outside it. That roll-up reads each team's cycles whole, a bounded set a team
    plans by hand, and pages over the merged order.
    """
    require_team_reader(repositories, context, team_id)
    teams = listed_teams(repositories, context, team_id, include_sub_teams=include_sub_teams)
    if len(teams) == 1:
        scope = f"cycles:{context.workspace_id}:{team_id}"
        rows, last_key = repositories.planning.list_cycles(
            context.workspace_id,
            team_id,
            limit=limit,
            start_key=resume_key(cursor, scope),
        )
        counted = counts_unestimated(repositories, context.workspace_id, team_id)
        bodies = [CycleRead.from_row(row, count_unestimated=counted) for row in rows]
        if status_filter is not None:
            bodies = [body for body in bodies if body.status == status_filter]
        return bodies, encode_start_key(last_key, scope=scope)

    merged: list[CycleRead] = []
    for member in teams:
        counted = counts_unestimated(repositories, context.workspace_id, member)
        for row in repositories.planning.list_for_roadmap(context.workspace_id, member):
            body = CycleRead.from_row(row, count_unestimated=counted)
            if status_filter is None or body.status == status_filter:
                merged.append(body)
    merged.sort(key=lambda body: (body.start_date, body.team_id, body.cycle_id))
    scope = f"cycles-rollup:{context.workspace_id}:{team_id}:{status_filter or 'all'}"
    offset = decode_offset_cursor(cursor, scope)
    window = merged[offset : offset + limit]
    next_offset = offset + len(window)
    return window, encode_offset_cursor(next_offset, scope) if next_offset < len(merged) else None


def create_cycle(repositories: Repositories, context: AuthzContext, payload: CycleCreate) -> CycleRead:
    """Create a cycle in one team the caller may write in.

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
    counted = counts_unestimated(repositories, context.workspace_id, payload.team_id)
    return CycleRead.from_row(created, count_unestimated=counted)


def update_cycle(repositories: Repositories, context: AuthzContext, cycle_id: str, payload: CycleUpdate) -> CycleRead:
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
    counted = counts_unestimated(repositories, context.workspace_id, payload.team_id)
    return CycleRead.from_row(stored, count_unestimated=counted)


def delete_cycle(repositories: Repositories, context: AuthzContext, team_id: str, cycle_id: str) -> None:
    """Delete a cycle and its daily snapshots, leaving every issue that pointed at it in place.

    The issues are not rewritten: an issue carrying a dead cycle id reads as
    unassigned, and rewriting a team's whole issue set from a planning write
    would be exactly the second write path the design forbids.
    """
    load_readable_cycle(repositories, context, team_id, cycle_id)
    require_team_admin(repositories, context, team_id)
    repositories.planning.delete(context.workspace_id, cycle_key(team_id, cycle_id))
    repositories.planning.delete_cycle_history(context.workspace_id, team_id, cycle_id)
