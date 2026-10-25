"""Rolling a cycle's unfinished issues forward, starting the next cycle today, and ending the current one today.

The cycle close in the issues function and the "Start cycle today" action share
one rollover rule: every issue of the cycle whose status is not in a completed
category moves into the target, each move conditional on the issue still sitting
in the cycle it leaves, and each one stamped with that cycle so the planning
rollup counts the carry-over on both rows. An issue whose status the team does
not know is left alone rather than guessed at.

"End cycle today" moves nothing itself: it ends the current cycle at the close
of today, and the hourly cycle close rolls its unfinished issues on under the
same rule once the day is over.

Held in `common` because the planning routes and the MCP tools both start and
end a cycle early, and neither image may import the issues domain.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Optional

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.planning import CycleRead, CycleStartTodayRead
from app.common.cycle_schedule import active_cycle, relative_cycle
from app.common.cycle_writes import team_today
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import Cycle
from app.common.issue_rules import COMPLETED_CATEGORIES
from app.common.planning_rules import counts_unestimated, load_readable_cycle, require_team_member

SYSTEM_ACTOR = "system"
"""The actor an automatic carry-over is recorded under."""


def carry_unfinished(
    repositories: Any,
    workspace_id: str,
    team_id: str,
    from_cycle_id: str,
    to_cycle_id: str,
    *,
    actor_id: str = SYSTEM_ACTOR,
    actor_kind: str = "system",
) -> int:
    """Move one cycle's unfinished issues into another and return how many moved."""
    categories = {row.status_id: row.category for row in repositories.team_config.list_statuses(workspace_id, team_id)}
    moved = 0
    for issue in repositories.issues.iter_for_cycle(workspace_id, team_id, from_cycle_id):
        category = categories.get(issue.status_id)
        if category is None or category in COMPLETED_CATEGORIES:
            continue
        if repositories.issues.carry_to_cycle(workspace_id, issue.issue_id, from_cycle_id, to_cycle_id) is None:
            continue
        repositories.activity.record(
            build_activity(
                workspace_id,
                issue.team_id,
                issue.issue_id,
                actor_id,
                "field_changed",
                actor_kind=actor_kind,
                field="cycle_id",
                from_value=from_cycle_id,
                to_value=to_cycle_id,
            )
        )
        moved += 1
    return moved


@dataclass
class StartedToday:
    """What starting a cycle today changed: the cycle, the one it ended and the issues moved."""

    cycle: Cycle
    ended: Optional[Cycle]
    moved: int


def _conflict(message: str) -> HTTPException:
    """The 409 a cycle that cannot start today gets."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error_code": "CONFLICT", "message": message},
    )


def start_cycle_today(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    cycle_id: str,
    today: Optional[date] = None,
) -> StartedToday:
    """Start a team's next upcoming cycle today, ending the current one and rolling its open issues in.

    Only the next live upcoming cycle may start early, so no cycle is ever
    skipped over. The current cycle ends yesterday rather than today, because a
    cycle's end date is inclusive and two cycles containing today would leave the
    old one current. A current cycle that itself started today is refused for the
    same reason. The started cycle keeps its end date, so the automatic schedule,
    which continues after the latest end date and counts only cycles starting
    after today as upcoming, tops the chain up without overlapping it. The moved
    issues are stamped as a carry-over, and the hourly close finds nothing left
    to move when it reaches the ended cycle.
    """
    target = load_readable_cycle(repositories, context, team_id, cycle_id)
    require_team_member(repositories, context, team_id)
    now = today or date.today()
    now_text = now.isoformat()
    if target.cancelled or target.start_date <= now_text:
        raise _conflict("Only an upcoming cycle can start today")

    cycles = repositories.planning.list_for_roadmap(context.workspace_id, team_id)
    following = relative_cycle(cycles, "next", now)
    if following is None or following.cycle_id != target.cycle_id:
        raise _conflict("Only the next upcoming cycle can start today")

    current = active_cycle(cycles, now)
    if current is not None and current.start_date >= now_text:
        raise _conflict("The current cycle started today, so the next one cannot start today too")

    stamp = utc_now()
    ended: Optional[Cycle] = None
    if current is not None:
        yesterday = (now - timedelta(days=1)).isoformat()
        ended = repositories.planning.replace_cycle(
            current.model_copy(update={"end_date": yesterday, "updated_at": stamp})
        )
    started = repositories.planning.replace_cycle(
        target.model_copy(update={"start_date": now_text, "updated_at": stamp})
    )

    moved = 0
    if current is not None:
        moved = carry_unfinished(
            repositories,
            context.workspace_id,
            team_id,
            current.cycle_id,
            target.cycle_id,
            actor_id=context.user_id,
            actor_kind="user",
        )
    return StartedToday(cycle=started, ended=ended, moved=moved)


def start_cycle_today_read(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    cycle_id: str,
    today: Optional[date] = None,
) -> CycleStartTodayRead:
    """Start a cycle today and answer with both cycles as the API shows them."""
    result = start_cycle_today(repositories, context, team_id, cycle_id, today)
    counted = counts_unestimated(repositories, context.workspace_id, team_id)
    now = (today or date.today()).isoformat()
    return CycleStartTodayRead(
        cycle=CycleRead.from_row(result.cycle, now, count_unestimated=counted),
        ended=None if result.ended is None else CycleRead.from_row(result.ended, now, count_unestimated=counted),
        moved_issues=result.moved,
    )


def end_cycle_today(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    cycle_id: str,
    today: Optional[date] = None,
) -> CycleRead:
    """End a team's current cycle at the close of today in the team's timezone, as Linear's action does.

    Only a live cycle whose dates hold today may end today; anything else is a
    409. A cycle already ending today is answered as it is. The cycle after it
    keeps its dates, so the days between read as a gap, and the hourly cycle
    close rolls the unfinished issues into the next cycle once today is over.
    """
    cycle = load_readable_cycle(repositories, context, team_id, cycle_id)
    require_team_member(repositories, context, team_id)
    now = (today or team_today(repositories, context.workspace_id, team_id)).isoformat()
    if cycle.cancelled or not cycle.start_date <= now <= cycle.end_date:
        raise _conflict("Only the current cycle can end today")

    stored = cycle
    if cycle.end_date != now:
        stored = repositories.planning.replace_cycle(
            cycle.model_copy(update={"end_date": now, "updated_at": utc_now()})
        )
    counted = counts_unestimated(repositories, context.workspace_id, team_id)
    return CycleRead.from_row(stored, now, count_unestimated=counted)
