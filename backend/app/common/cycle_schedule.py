"""Automatic cycles: keep a team stocked with a current cycle and its upcoming ones.

A team that turns cycles on gets Linear's behaviour: cycles of a fixed length,
each starting on the team's start weekday, separated by an optional cooldown,
with a set number of upcoming cycles always created ahead of today. The team
settings route runs this the moment the setting is turned on, and the planning
domain's hourly schedule runs it for every enabled team so the chain never runs
dry as cycles end.

Every automatic cycle's id is derived from its start date, and the write is
conditional on the key being free, so two runs racing, or a scheduled retry,
land on the same row rather than a duplicate. A run never changes an existing
cycle: a cycle a planner made by hand, moved or cancelled stays as it is, and the
chain simply continues after the latest end date of any cycle the team has. The
numbering continues from the latest numbered cycle, so a planner who renames a
cycle to a name ending in a number starts a new sequence, as Linear does.

The date rules a planner's own edit follows, Linear's too, live in
`cycle_writes`; the pure helpers they share live here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Iterable

from webbpulse.dynamodb import ConditionFailed

from app.common.db.dynamo.planning import Cycle, PlanningRepository, cycle_key
from app.common.db.dynamo.team_config import CycleSettings

AUTO_CYCLE_PREFIX = "auto-"

SYSTEM_ACTOR = "system"

MAX_CYCLES_PER_RUN = 20
"""The most cycles one run creates for one team, a bound on a runaway loop."""

RELATIVE_CYCLES: tuple[str, ...] = ("current", "next", "previous")
"""Cycle references resolved against a team's schedule on the day they are read."""

TRAILING_NUMBER = re.compile(r"(\d+)\s*$")
"""A number at the end of a cycle name, which starts a new numbering sequence."""


@dataclass
class ScheduleResult:
    """What one run did for one team: the cycles it created."""

    team_id: str
    created: list[Cycle] = field(default_factory=list)


def auto_cycle_id(start: date) -> str:
    """The deterministic id of the automatic cycle starting on `start`."""
    return f"{AUTO_CYCLE_PREFIX}{start.strftime('%Y%m%d')}"


def align_forward(day: date, weekday: int) -> date:
    """The first date on or after `day` that falls on `weekday` (Monday is 0)."""
    return day + timedelta(days=(weekday - day.weekday()) % 7)


def align_back(day: date, weekday: int) -> date:
    """The last date on or before `day` that falls on `weekday` (Monday is 0)."""
    return day - timedelta(days=(day.weekday() - weekday) % 7)


def active_cycle(cycles: Iterable[Cycle], today: date | None = None) -> Cycle | None:
    """The live cycle whose dates contain today, earliest start first."""
    now = (today or date.today()).isoformat()
    live = [c for c in cycles if not c.cancelled and c.start_date <= now <= c.end_date]
    return min(live, key=lambda c: (c.start_date, c.cycle_id)) if live else None


def relative_cycle(cycles: list[Cycle], which: str, today: date) -> Cycle | None:
    """The current, next or previous live cycle of one team on one day."""
    if which == "current":
        return active_cycle(cycles, today)
    now = today.isoformat()
    live = [cycle for cycle in cycles if not cycle.cancelled]
    if which == "next":
        ahead = [cycle for cycle in live if cycle.start_date > now]
        return min(ahead, key=lambda cycle: (cycle.start_date, cycle.cycle_id)) if ahead else None
    behind = [cycle for cycle in live if cycle.end_date < now]
    return max(behind, key=lambda cycle: (cycle.end_date, cycle.cycle_id)) if behind else None


def plan_cycles(
    settings: CycleSettings,
    existing: list[Cycle],
    today: date,
) -> list[tuple[date, date]]:
    """The start and end dates of the cycles a team is missing, in order.

    The chain continues after the latest end date of any existing cycle,
    cancelled ones included, so a cancelled automatic cycle is not recreated.
    When no cycle covers today and none is ahead, a current cycle starting on
    the most recent start weekday is planned first, never overlapping the chain.
    Then upcoming cycles are planned until the team has `upcoming_count` live
    cycles starting after today.
    """
    length = timedelta(weeks=settings.duration_weeks)
    cooldown = timedelta(weeks=settings.cooldown_weeks)
    today_text = today.isoformat()
    upcoming = sum(1 for c in existing if not c.cancelled and c.start_date > today_text)
    chain_end = max((date.fromisoformat(c.end_date) for c in existing), default=None)

    planned: list[tuple[date, date]] = []
    if chain_end is None or chain_end < today:
        anchor = align_back(today, settings.start_weekday)
        start = anchor if chain_end is None else max(anchor, chain_end + timedelta(days=1))
        end = anchor + length - timedelta(days=1)
        planned.append((start, end))
        chain_end = end

    while upcoming < settings.upcoming_count and len(planned) < MAX_CYCLES_PER_RUN:
        start = align_forward(chain_end + timedelta(days=1) + cooldown, settings.start_weekday)
        end = start + length - timedelta(days=1)
        planned.append((start, end))
        chain_end = end
        upcoming += 1
    return planned


def automatic_name(number: int) -> str:
    """The name the schedule gives the cycle numbered `number`."""
    return f"Cycle {number}"


def trailing_number(name: str) -> int | None:
    """The number a cycle name ends in, or `None` when it ends in none."""
    found = TRAILING_NUMBER.search(name)
    return int(found.group(1)) if found else None


def next_number(existing: list[Cycle]) -> int:
    """The number the next automatic cycle of a team takes.

    It continues from the numbered cycle that starts latest, counting any cycle
    made by hand after it, so renumbering one cycle carries into the chain. A
    team with no numbered cycle numbers from how many cycles it has.
    """
    numbered = [c for c in existing if c.number is not None]
    if not numbered:
        return len(existing) + 1
    latest = max(numbered, key=lambda c: (c.start_date, c.cycle_id))
    after = sum(1 for c in existing if c.number is None and c.start_date > latest.start_date)
    return (latest.number or 0) + after + 1


def following_cycle(cycles: Iterable[Cycle], cycle: Cycle) -> Cycle | None:
    """The live cycle of the same team that starts next after `cycle`, or `None`."""
    after = [
        c
        for c in cycles
        if c.cycle_id != cycle.cycle_id
        and c.team_id == cycle.team_id
        and not c.cancelled
        and (c.start_date, c.cycle_id) > (cycle.start_date, cycle.cycle_id)
    ]
    return min(after, key=lambda c: (c.start_date, c.cycle_id)) if after else None


def preceding_cycle(cycles: Iterable[Cycle], cycle: Cycle) -> Cycle | None:
    """The live cycle of the same team that started before `cycle` and ends latest, or `None`."""
    before = [
        c
        for c in cycles
        if c.cycle_id != cycle.cycle_id
        and c.team_id == cycle.team_id
        and not c.cancelled
        and (c.start_date, c.cycle_id) < (cycle.start_date, cycle.cycle_id)
    ]
    return max(before, key=lambda c: (c.end_date, c.start_date, c.cycle_id)) if before else None


def gaps_before(cycles: list[Cycle]) -> dict[str, int | None]:
    """The days with no live cycle before each live cycle of one team, by cycle id.

    A cycle shortened or ended early leaves days before the next one, which the
    cycles page draws as "Cycles paused". The first live cycle has nothing
    before it and a cancelled one is outside the chain, so both read `None`;
    cycles that touch or overlap read 0.
    """
    gaps: dict[str, int | None] = {}
    latest_end: str | None = None
    for cycle in sorted(cycles, key=lambda c: (c.start_date, c.cycle_id)):
        if cycle.cancelled:
            gaps[cycle.cycle_id] = None
            continue
        if latest_end is None:
            gaps[cycle.cycle_id] = None
        else:
            days = (date.fromisoformat(cycle.start_date) - date.fromisoformat(latest_end)).days - 1
            gaps[cycle.cycle_id] = max(0, days)
        latest_end = cycle.end_date if latest_end is None else max(latest_end, cycle.end_date)
    return gaps


def ensure_cycles(
    planning: PlanningRepository,
    settings: CycleSettings,
    today: date | None = None,
) -> ScheduleResult:
    """Create the cycles a team with cycles turned on is missing.

    Does nothing when the settings are off. A cycle whose key is already taken,
    by a concurrent run or a retry, is taken as existing and still counts.
    """
    result = ScheduleResult(team_id=settings.team_id)
    if not settings.enabled:
        return result
    now = today or date.today()
    existing = planning.list_for_roadmap(settings.workspace_id, settings.team_id)
    number = next_number(existing)
    for start, end in plan_cycles(settings, existing, now):
        cycle_id = auto_cycle_id(start)
        cycle = Cycle(
            workspace_id=settings.workspace_id,
            planning_key=cycle_key(settings.team_id, cycle_id),
            cycle_id=cycle_id,
            team_id=settings.team_id,
            name=automatic_name(number),
            number=number,
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            created_by=SYSTEM_ACTOR,
        )
        number += 1
        try:
            planning.create_cycle(cycle)
        except ConditionFailed:
            continue
        result.created.append(cycle)
    return result
