"""When a recurring issue runs: daily, on chosen weekdays, or monthly, in one timezone.

Every rule is read as local wall time in its zone, so a schedule at 09:00 in
New York stays at 09:00 across a daylight saving change and lands an hour apart
in UTC. A local time skipped by a spring change runs one hour later on the clock, and
one repeated by an autumn change runs at its first occurrence.
A monthly day past a short month's end runs on that month's last day.

`interval` repeats every N days, weeks or months counted from `starts_on`, the
local date the schedule begins, so "every two weeks on Monday" stays on the
same fortnight however often it is edited.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

Frequency = Literal["daily", "weekly", "monthly"]

FREQUENCIES: tuple[str, ...] = ("daily", "weekly", "monthly")

MAX_INTERVAL: dict[str, int] = {"daily": 365, "weekly": 52, "monthly": 12}
"""The longest gap each frequency may repeat at, so the next run is always within about a year."""

SEARCH_DAYS = 800
"""How many local days ahead the next run is looked for, past the longest gap a rule allows."""


class RecurrenceError(ValueError):
    """A rule that cannot be read: an unknown zone, a malformed time or an empty weekday set."""


def resolve_zone(name: str) -> ZoneInfo:
    """The IANA zone `name`, or `RecurrenceError` when it is unknown."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise RecurrenceError(f"Unknown timezone {name!r}") from exc


def parse_time(value: str) -> time:
    """A `HH:MM` time of day, or `RecurrenceError` when it is malformed."""
    try:
        hours, minutes = value.split(":")
        if len(hours) != 2 or len(minutes) != 2:
            raise ValueError(value)
        return time(int(hours), int(minutes))
    except ValueError as exc:
        raise RecurrenceError(f"Time {value!r} is not HH:MM") from exc


@dataclass(frozen=True)
class Rule:
    """One recurrence: how often, on which days, at what local time, in which zone."""

    frequency: str
    interval: int
    weekdays: Sequence[int]
    day_of_month: int | None
    at: str
    timezone: str
    starts_on: date

    def check(self) -> None:
        """Raise `RecurrenceError` unless the rule can produce a run."""
        if self.frequency not in FREQUENCIES:
            raise RecurrenceError(f"Unknown frequency {self.frequency!r}")
        if not 1 <= self.interval <= MAX_INTERVAL[self.frequency]:
            raise RecurrenceError(f"interval must be between 1 and {MAX_INTERVAL[self.frequency]}")
        if self.frequency == "weekly" and (not self.weekdays or any(not 0 <= day <= 6 for day in self.weekdays)):
            raise RecurrenceError("A weekly schedule needs at least one weekday from 0 (Monday) to 6 (Sunday)")
        if self.frequency == "monthly" and not (self.day_of_month and 1 <= self.day_of_month <= 31):
            raise RecurrenceError("A monthly schedule needs a day_of_month from 1 to 31")
        parse_time(self.at)
        resolve_zone(self.timezone)


def _months_between(start: date, day: date) -> int:
    """Whole calendar months from `start`'s month to `day`'s."""
    return (day.year - start.year) * 12 + day.month - start.month


def _monday(day: date) -> date:
    """The Monday of `day`'s week."""
    return day - timedelta(days=day.weekday())


def matches(rule: Rule, day: date) -> bool:
    """Whether the rule runs on the local date `day`."""
    if day < rule.starts_on:
        return False
    if rule.frequency == "daily":
        return (day - rule.starts_on).days % rule.interval == 0
    if rule.frequency == "weekly":
        weeks = (_monday(day) - _monday(rule.starts_on)).days // 7
        return day.weekday() in rule.weekdays and weeks % rule.interval == 0
    if _months_between(rule.starts_on, day) % rule.interval:
        return False
    last = calendar.monthrange(day.year, day.month)[1]
    return day.day == min(rule.day_of_month or 1, last)


def local_run(day: date, at: time, zone: ZoneInfo) -> datetime:
    """The UTC instant of local wall time `at` on `day`, read with the offset in force before any change."""
    return datetime.combine(day, at, tzinfo=zone).astimezone(UTC)


def next_run(rule: Rule, after: datetime) -> datetime:
    """The first run strictly after `after`, in UTC to the minute.

    Raises `RecurrenceError` for a rule that cannot run, which `Rule.check`
    refuses before one is ever stored.
    """
    rule.check()
    zone = resolve_zone(rule.timezone)
    at = parse_time(rule.at)
    moment = (after if after.tzinfo else after.replace(tzinfo=UTC)).astimezone(UTC)
    day = max(moment.astimezone(zone).date() - timedelta(days=1), rule.starts_on)
    for _ in range(SEARCH_DAYS):
        if matches(rule, day):
            candidate = local_run(day, at, zone)
            if candidate > moment:
                return candidate
        day += timedelta(days=1)
    raise RecurrenceError("The schedule has no run in the next two years")


def upcoming_runs(rule: Rule, after: datetime, count: int) -> list[datetime]:
    """The next `count` runs after `after`, for a preview."""
    runs: list[datetime] = []
    moment = after
    for _ in range(count):
        moment = next_run(rule, moment)
        runs.append(moment)
    return runs
