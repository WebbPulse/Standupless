"""Cycle list, create, patch and delete, shared by the cycle routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a cycle an agent plans must pass the same team rules a person's does:
any member of the team creates or edits one, and only its administrator deletes
one, since a delete detaches every issue that pointed at it.

An edit follows Linear's cycle rules: dates already in the past stay fixed,
extending a cycle into the next one shortens that next one, and shortening one
leaves a gap the list reports as `gap_before_days`. A name ending in a number
renumbers the automatically named cycles after it, so the schedule continues
from that number. Every date rule, and every status a body derives, is judged
against today in the team's own timezone, as `team_time` reads it.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed, encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import decode_offset_cursor, encode_offset_cursor, resume_key
from app.common.api.schemas.planning import CycleCreate, CycleRead, CycleUpdate
from app.common.cycle_schedule import (
    automatic_name,
    following_cycle,
    gaps_before,
    preceding_cycle,
    trailing_number,
)
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
    unprocessable,
)
from app.common.sub_teams import listed_teams
from app.common.team_time import team_today


def conflict(message: str) -> HTTPException:
    """The 409 a cycle edit that would break the team's chain gets."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error_code": "CONFLICT", "message": message},
    )


def with_gaps(bodies: list[CycleRead], cycles: list[Cycle]) -> list[CycleRead]:
    """The bodies with each one's `gap_before_days` read off its team's whole chain."""
    gaps = gaps_before(cycles)
    return [body.model_copy(update={"gap_before_days": gaps.get(body.cycle_id)}) for body in bodies]


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
    Each cycle's `gap_before_days` is read off the team's whole chain, so the
    first cycle of a page still knows the gap before it.
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
        chain = repositories.planning.list_for_roadmap(context.workspace_id, team_id)
        today = team_today(repositories, context.workspace_id, team_id).isoformat()
        bodies = with_gaps([CycleRead.from_row(row, today, count_unestimated=counted) for row in rows], chain)
        if status_filter is not None:
            bodies = [body for body in bodies if body.status == status_filter]
        return bodies, encode_start_key(last_key, scope=scope)

    merged: list[CycleRead] = []
    for member in teams:
        counted = counts_unestimated(repositories, context.workspace_id, member)
        chain = repositories.planning.list_for_roadmap(context.workspace_id, member)
        today = team_today(repositories, context.workspace_id, member).isoformat()
        for body in with_gaps([CycleRead.from_row(row, today, count_unestimated=counted) for row in chain], chain):
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
    today = team_today(repositories, context.workspace_id, payload.team_id).isoformat()
    return CycleRead.from_row(created, today, count_unestimated=counted)


def update_cycle(repositories: Repositories, context: AuthzContext, cycle_id: str, payload: CycleUpdate) -> CycleRead:
    """Patch a cycle's name, dates, goal or cancellation, under Linear's date rules.

    The row is read first and written whole, so the counters the consumer maintains
    ride along untouched: a patch here must never become a second write path into
    the numbers the stream owns. A date change is checked against today and the
    team's other cycles before anything is written, and a next cycle shortened
    by an extension is written first, so a failure part way leaves a gap rather
    than an overlap.
    """
    existing = load_readable_cycle(repositories, context, payload.team_id, cycle_id)
    require_team_member(repositories, context, payload.team_id)

    fields = payload.model_dump(exclude_unset=True, exclude={"team_id"})
    renumbered = None
    if "name" in fields and fields["name"] != existing.name:
        renumbered = trailing_number(fields["name"])
        if renumbered is not None:
            fields["number"] = renumbered
    updated = existing.model_copy(update={**fields, "updated_at": utc_now()})
    check_dates(updated.start_date, updated.end_date)

    moves_dates = updated.start_date != existing.start_date or updated.end_date != existing.end_date
    chain: list[Cycle] = []
    shortened: Optional[Cycle] = None
    if moves_dates or renumbered is not None:
        chain = repositories.planning.list_for_roadmap(context.workspace_id, payload.team_id)
    if moves_dates:
        today = team_today(repositories, context.workspace_id, payload.team_id).isoformat()
        check_past_dates(existing, updated, today)
        if not updated.cancelled:
            check_previous(chain, existing, updated)
            shortened = shorten_following(chain, existing, updated, today)

    if shortened is not None:
        try:
            repositories.planning.replace_cycle(shortened)
        except ConditionFailed as exc:
            raise conflict("The next cycle changed while this one was saved; try again") from exc
    try:
        stored = repositories.planning.replace_cycle(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    if renumbered is not None:
        renumber_following(repositories, chain, stored, renumbered)
    counted = counts_unestimated(repositories, context.workspace_id, payload.team_id)
    today = team_today(repositories, context.workspace_id, payload.team_id).isoformat()
    return CycleRead.from_row(stored, today, count_unestimated=counted)


def check_past_dates(existing: Cycle, updated: Cycle, today: str) -> None:
    """Refuse a date change that rewrites the past, as Linear does, with a 422.

    A start date already behind today is fixed, and no start date may be moved
    behind today. An end date may not be moved behind today either, which holds
    a completed cycle's end in place and keeps the current cycle from ending
    before today; ending it today is the end today action.
    """
    if updated.start_date != existing.start_date:
        if existing.start_date < today:
            raise unprocessable("The cycle has already started, so its start date cannot change")
        if updated.start_date < today:
            raise unprocessable("start_date cannot be moved into the past")
    if updated.end_date != existing.end_date:
        if existing.end_date < today:
            raise unprocessable("The cycle has already ended, so its end date cannot change")
        if updated.end_date < today:
            raise unprocessable("end_date cannot be before today")


def check_previous(chain: list[Cycle], existing: Cycle, updated: Cycle) -> None:
    """Refuse a start moved earlier onto the cycle before it, with a 409."""
    if updated.start_date >= existing.start_date:
        return
    before = preceding_cycle(chain, existing)
    if before is not None and updated.start_date <= before.end_date:
        raise conflict(f"The start date overlaps {before.name}; shorten that cycle first")


def shorten_following(chain: list[Cycle], existing: Cycle, updated: Cycle, today: str) -> Optional[Cycle]:
    """The next cycle with its start moved to the day after an extended end, or `None`.

    Extending a cycle shortens the one after it rather than overlapping it, as
    in Linear; an extension that stops short of the next start, a cooldown
    included, leaves it alone. A next cycle that would be left with no days, or
    that has already started, is a 409 rather than a delete or a rewrite.
    """
    if updated.end_date <= existing.end_date:
        return None
    following = following_cycle(chain, existing)
    if following is None or updated.end_date < following.start_date:
        return None
    if following.start_date < today:
        raise conflict(f"{following.name} has already started, so this cycle cannot extend into it")
    start = (date.fromisoformat(updated.end_date) + timedelta(days=1)).isoformat()
    if start > following.end_date:
        raise conflict(f"Extending this cycle would leave {following.name} with no days")
    return following.model_copy(update={"start_date": start, "updated_at": utc_now()})


def renumber_following(repositories: Repositories, chain: list[Cycle], renamed: Cycle, number: int) -> None:
    """Number the automatically named cycles after a renamed one on from its new number.

    A cycle a planner named themselves keeps its name and only takes the next
    number, so the schedule, which continues from the latest numbered cycle,
    carries the new sequence on.
    """
    following = sorted(
        (
            c
            for c in chain
            if c.cycle_id != renamed.cycle_id and (c.start_date, c.cycle_id) > (renamed.start_date, renamed.cycle_id)
        ),
        key=lambda c: (c.start_date, c.cycle_id),
    )
    for offset, cycle in enumerate(following, start=1):
        target = number + offset
        if cycle.number == target:
            continue
        update: dict[str, object] = {"number": target, "updated_at": utc_now()}
        if cycle.number is not None and cycle.name == automatic_name(cycle.number):
            update["name"] = automatic_name(target)
        try:
            repositories.planning.replace_cycle(cycle.model_copy(update=update))
        except ConditionFailed:
            continue


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
