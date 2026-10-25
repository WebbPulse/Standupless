"""The cycle close: when a cycle ends, its unfinished issues roll into the next one.

A cycle's status is derived from its dates, so nothing writes when one ends. This
sweep is what does: an EventBridge Scheduler schedule invokes the issues function
hourly with one synthetic record, the consumer route hands it here, and every
cycle that ended in the last week is closed.

It runs in the issues function because it writes issues, and planning never
writes the issues table. Each move is conditional on the issue still sitting in
the ended cycle, so a close is idempotent: a second run finds nothing left to
move, and a planner who moved an issue meanwhile keeps their choice. A cycle
with no next cycle to roll into is left alone until one is created, which the
lookback window then picks up. A team that turned "Move unfinished issues to the
next cycle" off keeps its issues where they are; the setting is on by default,
including for a team that never saved cycle settings.

A cycle ends at midnight in its team's timezone, so each ended cycle is judged
against its own team's local date. The query window is one day wider than the
lookback so a team ahead of UTC is found the hour its midnight passes.

The move stamps each issue with the cycle it left, and the planning rollup reads
that marker off the stream to count the carry-over on both cycles.

On the day after a cycle's last day, every sweep also queues the channel post of
its completion, with its scope, completed and rolled over counts, and of the next
cycle's start once that one has begun. A team that keeps its unfinished issues in
place still hears of both. The posts are derived from the cycle and its dates, so
the day's hourly runs post once; the first run's counts are the ones a channel
sees, taken before that run moved anything.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Mapping, Sequence

from app.common.cycle_announcements import (
    CYCLE_COMPLETED,
    CYCLE_STARTED,
    CycleTally,
    queue_cycle_announcement,
    tally_cycle,
)
from app.common.cycle_rollover import carry_unfinished
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import Cycle
from app.common.team_retirement import is_active
from app.common.team_time import team_today

_log = logging.getLogger(__name__)

CYCLE_CLOSE_SOURCE = "standupless.cycle-close"
"""The `eventSource` the schedule's synthetic record carries."""

LOOKBACK_DAYS = 7
"""How far back a sweep looks for an ended cycle, so a missed run heals itself."""


def is_cycle_close(record: Mapping[str, Any]) -> bool:
    """Whether one record is the schedule's cycle close trigger rather than a stream record."""
    return str(record.get("eventSource", "")) == CYCLE_CLOSE_SOURCE


@dataclass
class CloseSummary:
    """What one sweep did, for the log line."""

    cycles: int = 0
    carried: int = 0
    without_next: int = 0
    disabled: int = 0
    announced: int = 0


def next_cycle(cycles: Sequence[Cycle], ended: Cycle, today: str) -> Cycle | None:
    """The cycle an ended cycle's unfinished issues roll into, or `None`.

    The earliest live cycle of the same team that starts after the ended one did
    and has not itself ended, so a close never rolls work into the past.
    """
    candidates = [
        cycle
        for cycle in cycles
        if cycle.cycle_id != ended.cycle_id
        and cycle.team_id == ended.team_id
        and not cycle.cancelled
        and cycle.start_date > ended.start_date
        and cycle.end_date >= today
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda cycle: (cycle.start_date, cycle.cycle_id))


def close_cycle(
    repositories: Any, ended: Cycle, today: str, *, moves: bool = True, announce: bool = False
) -> tuple[int, bool]:
    """Roll one ended cycle's unfinished issues into its next cycle, and announce both when asked.

    Returns how many issues moved and whether a next cycle existed. An issue whose
    status is unknown to the team is left where it is rather than guessed at.
    `moves` false leaves every issue in place, for a team that turned the
    rollover off. `announce` queues the completion of `ended`, with its counts
    taken before the move, and the start of the next cycle once it has begun.
    """
    workspace_id = ended.workspace_id
    target = next_cycle(repositories.planning.list_for_roadmap(workspace_id, ended.team_id), ended, today)
    tally = tally_cycle(repositories, workspace_id, ended.team_id, ended.cycle_id) if announce else None
    moved = 0
    if moves and target is not None:
        moved = carry_unfinished(repositories, workspace_id, ended.team_id, ended.cycle_id, target.cycle_id)
    if tally is not None:
        queue_cycle_announcement(
            ended, CYCLE_COMPLETED, CycleTally(scope=tally.scope, completed=tally.completed, rolled_over=moved)
        )
        if target is not None and target.start_date <= today:
            queue_cycle_announcement(target, CYCLE_STARTED)
    return moved, target is not None


def announces(ended: Cycle, today: str) -> bool:
    """Whether a sweep on `today` posts an ended cycle's completion: only on the day after its last day."""
    return ended.end_date == (date.fromisoformat(today) - timedelta(days=1)).isoformat()


def moves_unfinished(repositories: Any, workspace_id: str, team_id: str) -> bool:
    """Whether a team rolls unfinished issues forward, on for a team that never saved settings.

    A retired team is read-only, so its issues stay in the cycle that ended.
    """
    if not is_active(repositories.teams.get(workspace_id, team_id)):
        return False
    settings = repositories.team_config.get_cycle_settings(workspace_id, team_id)
    return settings is None or settings.move_unfinished


def sweep(repositories: Any, today: str | None = None, now: datetime | None = None) -> CloseSummary:
    """Close every cycle that ended within the lookback window.

    A cycle ends at the close of its `end_date` in its team's timezone, so a
    cycle counts only once its end date is before its team's local today.
    `today` pins one date for every team; otherwise each team is judged on its
    own local date at `now`, the current moment by default. Cancelled cycles are
    skipped: cancelling one is a decision about its issues that a close should
    not override.
    """
    moment = now or utc_now()
    anchor = date.fromisoformat(today) if today is not None else moment.date()
    until = (anchor - timedelta(days=1 if today is not None else 0)).isoformat()
    since = (anchor - timedelta(days=LOOKBACK_DAYS + (0 if today is not None else 1))).isoformat()
    days: dict[tuple[str, str], str] = {}
    summary = CloseSummary()
    for ended in repositories.planning.iter_cycles_ended_between(since, until):
        if ended.cancelled:
            continue
        team = (ended.workspace_id, ended.team_id)
        if team not in days:
            days[team] = today or team_today(repositories, ended.workspace_id, ended.team_id, moment).isoformat()
        local = days[team]
        if ended.end_date >= local:
            continue
        announce = announces(ended, local) and is_active(repositories.teams.get(ended.workspace_id, ended.team_id))
        if not moves_unfinished(repositories, ended.workspace_id, ended.team_id):
            summary.disabled += 1
            if announce:
                close_cycle(repositories, ended, local, moves=False, announce=True)
                summary.announced += 1
            continue
        summary.cycles += 1
        moved, had_next = close_cycle(repositories, ended, local, announce=announce)
        summary.carried += moved
        summary.announced += int(announce)
        if not had_next:
            summary.without_next += 1
    _log.info(
        "Closed ended cycles.",
        extra={
            "event": "issues.cycle_close",
            "cycles": summary.cycles,
            "carried": summary.carried,
            "without_next": summary.without_next,
            "disabled": summary.disabled,
            "announced": summary.announced,
        },
    )
    return summary
