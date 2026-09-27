"""Automatic cycles: keep a team stocked with a current cycle and its upcoming ones.

A team that turns cycles on gets Linear's behaviour: cycles of a fixed length,
each starting on the team's start weekday, separated by an optional cooldown,
with a set number of upcoming cycles always created ahead of today. The team
settings route runs this the moment the setting is turned on, and the planning
domain's hourly schedule runs it for every enabled team so the chain never runs
dry as cycles end.

Every automatic cycle's id is derived from its start date, and the write is
conditional on the key being free, so two runs racing, or a scheduled retry,
land on the same row rather than a duplicate. Existing cycles are never changed:
a cycle a planner made by hand, moved or cancelled stays as it is, and the chain
simply continues after the latest end date of any cycle the team has.
"""

from __future__ import annotations

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


def next_number(existing: list[Cycle]) -> int:
    """The number the next automatic cycle of a team takes."""
    highest = max((c.number for c in existing if c.number is not None), default=0)
    return max(highest, len(existing)) + 1


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
            name=f"Cycle {number}",
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
