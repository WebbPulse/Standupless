"""A cycle's scope history and a team's velocity, read off the daily snapshots.

The rollup consumer writes one snapshot row per cycle per day it moved, holding the
counters as they stood after that day's last move. Everything here is a pure fold
over those rows and the cycle's current counters, so a chart and a velocity figure
cost one query per cycle and no read of the `issues` table.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Sequence

from app.common.db.dynamo.planning import Cycle, CycleSnapshot, RollupCounts

MAX_HISTORY_DAYS = 366
"""The longest series a cycle's history renders, so a mistyped end date stays bounded."""


@dataclass(frozen=True)
class DayValue:
    """One day of a cycle's burn-up, in issues and in estimate points."""

    date: str
    scope: int
    started: int
    completed: int
    scope_points: int
    started_points: int
    completed_points: int

    @classmethod
    def of(cls, day: str, counts: RollupCounts, points: RollupCounts) -> "DayValue":
        """One day's value from the counters that stood at its close."""
        return cls(
            date=day,
            scope=counts.scope,
            started=counts.started,
            completed=counts.done,
            scope_points=points.scope,
            started_points=points.started,
            completed_points=points.done,
        )


def days_between(start: str, end: str) -> list[str]:
    """Every ISO day from `start` to `end` inclusive, empty when the range is inverted."""
    try:
        first = date.fromisoformat(start)
        last = date.fromisoformat(end)
    except ValueError:
        return []
    span = (last - first).days
    if span < 0:
        return []
    return [(first + timedelta(days=offset)).isoformat() for offset in range(min(span, MAX_HISTORY_DAYS - 1) + 1)]


def value_on(
    day: str,
    cycle: Cycle,
    snapshots: Sequence[CycleSnapshot],
    count_unestimated: bool = False,
) -> DayValue:
    """A cycle's counters as they stood at the close of one day.

    The latest snapshot dated on or before the day wins. A day before the first
    snapshot reads as that snapshot's opening value, which is what the cycle held
    before any recorded move. With no snapshots at all the current counters are the
    only truth there is. With `count_unestimated` each unestimated issue adds a point.
    """
    if not snapshots:
        return DayValue.of(day, cycle.counts, cycle.counted_points(count_unestimated))
    chosen: CycleSnapshot | None = None
    for snapshot in snapshots:
        if snapshot.day <= day:
            chosen = snapshot
        else:
            break
    if chosen is None:
        first = snapshots[0]
        return DayValue.of(day, first.opening_counts, first.counted_opening_points(count_unestimated))
    return DayValue.of(day, chosen.counts, chosen.counted_points(count_unestimated))


def burn_up(
    cycle: Cycle,
    snapshots: Sequence[CycleSnapshot],
    today: str,
    count_unestimated: bool = False,
) -> list[DayValue]:
    """The cycle's daily burn-up from its first day to today or its end, whichever is sooner.

    Today's value is always the current counters, so the chart never lags the
    cycle page's own numbers when a snapshot write was dropped. An upcoming cycle
    has no days yet.
    """
    last = min(today, cycle.end_date)
    series: list[DayValue] = []
    ordered = sorted(snapshots, key=lambda row: row.day)
    for day in days_between(cycle.start_date, last):
        if day == today:
            series.append(DayValue.of(day, cycle.counts, cycle.counted_points(count_unestimated)))
        else:
            series.append(value_on(day, cycle, ordered, count_unestimated))
    return series


@dataclass(frozen=True)
class VelocityEntry:
    """One closed cycle's delivered work, frozen at its end date."""

    cycle: Cycle
    at_close: DayValue


def velocity_entry(
    cycle: Cycle,
    snapshots: Sequence[CycleSnapshot],
    count_unestimated: bool = False,
) -> VelocityEntry:
    """A completed cycle's value on its last day.

    Read from the snapshots rather than the live counters, because a cycle close
    moves the unfinished issues out the day after, and the velocity has to count
    what the cycle held when it ended rather than what was left once it was closed.
    """
    ordered = sorted(snapshots, key=lambda row: row.day)
    return VelocityEntry(cycle=cycle, at_close=value_on(cycle.end_date, cycle, ordered, count_unestimated))


def closed_cycles(cycles: Sequence[Cycle], today: str, limit: int) -> list[Cycle]:
    """The team's last `limit` completed cycles, oldest first; cancelled ones never count."""
    done = [cycle for cycle in cycles if cycle.status(today) == "completed"]
    done.sort(key=lambda cycle: (cycle.end_date, cycle.cycle_id))
    return done[-limit:] if limit > 0 else []


def planning_cycle(cycles: Sequence[Cycle], today: str) -> Cycle | None:
    """The cycle capacity guidance speaks to: the active one, else the next upcoming one."""
    active = [cycle for cycle in cycles if cycle.status(today) == "active"]
    if active:
        return min(active, key=lambda cycle: (cycle.start_date, cycle.cycle_id))
    upcoming = [cycle for cycle in cycles if cycle.status(today) == "upcoming"]
    if upcoming:
        return min(upcoming, key=lambda cycle: (cycle.start_date, cycle.cycle_id))
    return None


def average(values: Sequence[int]) -> float:
    """The mean of the values, rounded to one decimal, zero for none."""
    if not values:
        return 0.0
    return round(sum(values) / len(values), 1)
