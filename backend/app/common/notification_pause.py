"""When a person's push notifications wait: a pause they set, and the working hours they chose.

A pause runs until a moment the person picked, and working hours are a weekly
schedule read in the person's own timezone. While either holds, email and
desktop notifications wait and the inbox still fills, as in Linear. `held_until`
answers the moment they may go out again, so a held email knows when its digest
is due and the flush can tell whether a held person is reachable yet.

The rules are pure functions of the user row and a clock, so the consumer, the
flush and the tests all read the same answer.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import TYPE_CHECKING, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator

if TYPE_CHECKING:
    from app.common.db.dynamo.users import User

WEEKDAYS: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
"""The days a working hours schedule may name, in `date.weekday()` order."""

PAUSE_MAX = timedelta(days=30)
"""The longest pause a person may set, which keeps held emails inside their retention."""

BYPASS_KINDS: frozenset[str] = frozenset({"mentioned"})
"""Kinds that reach a person who let urgent notifications through a hold, whatever the priority."""

URGENT_BYPASS_KINDS: frozenset[str] = frozenset({"assigned"})
"""Kinds that reach a person who let urgent notifications through a hold when the issue is urgent."""


def _clock(value: str) -> time:
    """One `HH:MM` value as a time of day, refusing anything else."""
    hours, separator, minutes = value.partition(":")
    if not separator or len(hours) != 2 or len(minutes) != 2 or not (hours + minutes).isdigit():
        raise ValueError(f"{value!r} is not an HH:MM time")
    hour, minute = int(hours), int(minutes)
    if hour > 23 or minute > 59:
        raise ValueError(f"{value!r} is not an HH:MM time")
    return time(hour, minute)


class WorkingHours(BaseModel):
    """The weekly hours a person takes notifications in, read in their own timezone.

    `days` names the weekdays, `start` and `end` bound each day as `HH:MM`, and
    `end` comes after `start`, so a day never runs past midnight.
    """

    days: list[str] = Field(min_length=1, max_length=len(WEEKDAYS))
    start: str = "09:00"
    end: str = "17:00"

    @field_validator("days")
    @classmethod
    def _known_days(cls, value: list[str]) -> list[str]:
        """Refuse a day the schedule does not have, and keep the rest in week order once each."""
        unknown = sorted(set(value) - set(WEEKDAYS))
        if unknown:
            raise ValueError(f"Unknown day: {', '.join(unknown)}")
        return [day for day in WEEKDAYS if day in value]

    @field_validator("start", "end")
    @classmethod
    def _clock_shape(cls, value: str) -> str:
        """Refuse a time that is not `HH:MM`."""
        _clock(value)
        return value

    @model_validator(mode="after")
    def _ordered(self) -> "WorkingHours":
        """Refuse a day that ends before it starts."""
        if _clock(self.end) <= _clock(self.start):
            raise ValueError("Working hours must end after they start")
        return self


def zone_of(name: Optional[str]) -> ZoneInfo:
    """The person's zone, or UTC when none is stored or the stored name is no longer known."""
    if name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return ZoneInfo("UTC")


def _aware(moment: datetime) -> datetime:
    """A moment with a zone, reading a naive one as UTC."""
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def next_working_moment(hours: WorkingHours, zone: ZoneInfo, moment: datetime) -> datetime:
    """`moment` when it falls inside the working hours, else the next moment they begin.

    Each day's bounds are built as wall clock times in the zone, so a daylight
    saving change moves them with the clock the person reads.
    """
    local = _aware(moment).astimezone(zone)
    start, end = _clock(hours.start), _clock(hours.end)
    for offset in range(len(WEEKDAYS) + 1):
        day: date = local.date() + timedelta(days=offset)
        if WEEKDAYS[day.weekday()] not in hours.days:
            continue
        opens = datetime.combine(day, start, tzinfo=zone)
        closes = datetime.combine(day, end, tzinfo=zone)
        if local < opens:
            return opens.astimezone(timezone.utc)
        if local < closes:
            return _aware(moment).astimezone(timezone.utc)
    return _aware(moment).astimezone(timezone.utc)


def held_until(user: "User", now: datetime | None = None) -> datetime | None:
    """The moment this person's push notifications may go out again, or `None` when they may now.

    A pause that has not ended moves the moment to its end, and working hours
    then move it on to the next time they begin, so a pause ending on a Saturday
    for someone who works weekdays holds until Monday morning.
    """
    moment = _aware(now or datetime.now(timezone.utc))
    release = moment
    paused = user.notifications_paused_until
    if paused is not None and _aware(paused) > release:
        release = _aware(paused)
    if user.working_hours is not None:
        release = next_working_moment(user.working_hours, zone_of(user.timezone), release)
    return release if release > moment else None


def bypasses_hold(user: "User", kind: str, urgent: bool) -> bool:
    """Whether one notification reaches a held person anyway, because they let urgent ones through."""
    if not user.urgent_bypasses_pause:
        return False
    return kind in BYPASS_KINDS or (urgent and kind in URGENT_BYPASS_KINDS)
