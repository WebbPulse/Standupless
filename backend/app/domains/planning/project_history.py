"""A project's progress history and its projected finish, read off the daily snapshots.

The project recount writes one snapshot row per project per day its buckets moved,
holding the counts as they stood after that day's last recount. Everything here is
a pure fold over those rows and the project's current counts, so the progress graph
costs one query on the project's own snapshot prefix and no read of the `issues`
table, and the projection is plain arithmetic on the series.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Sequence

from app.common.db.dynamo.planning import ProgressMeasure, Project, ProjectSnapshot
from app.domains.planning.history import MAX_HISTORY_DAYS, DayValue, days_between

PROJECTION_WINDOW_DAYS = 14
"""How many recent days the completion rate is read over, so an early burst does not set the pace."""

MIN_PROJECTION_DAYS = 3
"""How many days of series a projection needs before it is worth drawing."""

MAX_PROJECTION_DAYS = 3650
"""The furthest ahead a projected finish is named; slower than that reads as no finish in sight."""


@dataclass(frozen=True)
class ProjectHistory:
    """A project's daily series and the first day the snapshots recorded, if any."""

    days: list[DayValue]
    recorded_since: str | None


@dataclass(frozen=True)
class Projection:
    """Where the recent completion rate takes the project.

    `expected_date` is None when nothing was completed over the window, and
    `days_past_target` is negative when the finish lands before the target.
    """

    rate_per_day: float
    expected_date: str | None
    days_past_target: int | None


def _shift(day: str, offset: int) -> str:
    """The ISO day `offset` days from `day`."""
    return (date.fromisoformat(day) + timedelta(days=offset)).isoformat()


def project_origin(project: Project) -> str:
    """The day a project's graph opens on: its start date, else the day it was created."""
    return project.start_date or project.created_at.date().isoformat()


def project_value_on(day: str, snapshots: Sequence[ProjectSnapshot]) -> DayValue:
    """A project's counts at the close of one day, from snapshots ordered by day.

    The latest snapshot dated on or before the day wins, and a day before the
    first reads as that snapshot's opening value.
    """
    chosen: ProjectSnapshot | None = None
    for snapshot in snapshots:
        if snapshot.day <= day:
            chosen = snapshot
        else:
            break
    if chosen is None:
        first = snapshots[0]
        return DayValue.of(day, first.opening_counts, first.opening_points)
    return DayValue.of(day, chosen.counts, chosen.points)


def project_burn_up(project: Project, snapshots: Sequence[ProjectSnapshot], today: str) -> ProjectHistory:
    """The project's daily series from the day it opens to today.

    With no snapshots the series is today's counts alone. When the first
    snapshot opened on an empty project the history is whole, so it runs from
    the project's start; otherwise only the day before the first snapshot is
    known and the series opens there. The series never runs longer than
    `MAX_HISTORY_DAYS`, keeping the most recent days, and today always reads the
    live counts so the graph never lags the panel's own numbers.
    """
    live = DayValue.of(today, project.counts, project.points)
    origin = project_origin(project)
    if origin > today:
        return ProjectHistory(days=[], recorded_since=None)
    ordered = sorted(snapshots, key=lambda row: row.day)
    if not ordered:
        return ProjectHistory(days=[live], recorded_since=None)
    first = ordered[0]
    begin = origin if first.opening_counts.total == 0 else max(origin, _shift(first.day, -1))
    begin = min(max(begin, _shift(today, -(MAX_HISTORY_DAYS - 1))), today)
    series = [live if day == today else project_value_on(day, ordered) for day in days_between(begin, today)]
    return ProjectHistory(days=series, recorded_since=first.day)


def _scope_and_completed(value: DayValue, measure: ProgressMeasure) -> tuple[int, int]:
    """One day's scope and completed figures in the project's measure."""
    if measure == "points":
        return value.scope_points, value.completed_points
    return value.scope, value.completed


def project_projection(
    days: Sequence[DayValue],
    measure: ProgressMeasure,
    target_date: str | None,
    today: str,
) -> Projection | None:
    """Where the completion rate of the last `PROJECTION_WINDOW_DAYS` days lands the remaining scope.

    None when the series is too short, the scope is empty or the scope is
    already complete. The rate is completed work gained over the window divided
    by its length in days, and the finish is the first whole day by which the
    remaining scope is done at that rate.
    """
    if len(days) < MIN_PROJECTION_DAYS:
        return None
    scope, completed = _scope_and_completed(days[-1], measure)
    remaining = scope - completed
    if scope <= 0 or remaining <= 0:
        return None
    window = list(days[-(PROJECTION_WINDOW_DAYS + 1) :])
    _, opened = _scope_and_completed(window[0], measure)
    rate = (completed - opened) / (len(window) - 1)
    if rate <= 0:
        return Projection(rate_per_day=0.0, expected_date=None, days_past_target=None)
    needed = math.ceil(remaining / rate)
    if needed > MAX_PROJECTION_DAYS:
        return Projection(rate_per_day=round(rate, 2), expected_date=None, days_past_target=None)
    expected = _shift(today, needed)
    past = (date.fromisoformat(expected) - date.fromisoformat(target_date)).days if target_date else None
    return Projection(rate_per_day=round(rate, 2), expected_date=expected, days_past_target=past)
