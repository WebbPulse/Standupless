"""The clock an SLA timer runs on: calendar time, or business days in a team's timezone.

A team's SLA rules count either every hour (`calendar`, the default) or only
the hours of Monday to Friday where the team works (`business_days`), the way
Linear lets an SLA skip weekends. Business time is real elapsed time with every
local Saturday and Sunday taken out, so a weekday that a daylight saving change
makes 23 or 25 hours long counts 23 or 25 hours, and a weekend counts nothing.

Every SLA computation goes through `advance`, `retreat` and `elapsed`, given
the timezone a timer runs in, or `None` for calendar time, where they reduce to
plain `datetime` arithmetic. A deadline that lands exactly at the end of a
Friday reads as the first instant of Saturday, the earliest moment that
amount of business time has passed.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from app.common.db.dynamo.team_config import SlaCalendar
from app.common.team_time import zone_named

WEEKEND_DAYS: frozenset[int] = frozenset({5, 6})
"""The weekdays, Monday as 0, that business time skips."""

ONE_DAY = timedelta(days=1)


def _day_start(day: date, zone_name: str) -> datetime:
    """The UTC instant a local calendar day begins in the zone `zone_name`."""
    return datetime.combine(day, time(0), tzinfo=zone_named(zone_name)).astimezone(timezone.utc)


def _local_day(moment: datetime, zone_name: str) -> date:
    """The local calendar day `moment` falls on in the zone `zone_name`."""
    return moment.astimezone(zone_named(zone_name)).date()


def _business(day: date) -> bool:
    """Whether a local calendar day counts toward business time."""
    return day.weekday() not in WEEKEND_DAYS


def advance(start: datetime, amount: timedelta, zone_name: Optional[str]) -> datetime:
    """The moment `amount` of SLA time after `start`, counting only business days when a zone is given.

    A negative `amount` goes back through `retreat`.
    """
    if zone_name is None:
        return start + amount
    if amount < timedelta(0):
        return retreat(start, -amount, zone_name)
    moment = start
    remaining = amount
    while True:
        day = _local_day(moment, zone_name)
        day_end = _day_start(day + ONE_DAY, zone_name)
        if _business(day):
            available = day_end - moment
            if remaining <= available:
                return moment + remaining
            remaining -= available
        moment = day_end


def retreat(end: datetime, amount: timedelta, zone_name: Optional[str]) -> datetime:
    """The moment `amount` of SLA time before `end`, counting only business days when a zone is given.

    The latest such moment, so retreating from the start of a Monday by an
    hour lands an hour before the end of the Friday before it.
    """
    if zone_name is None:
        return end - amount
    if amount < timedelta(0):
        return advance(end, -amount, zone_name)
    moment = end
    remaining = amount
    while True:
        day = _local_day(moment - timedelta(microseconds=1), zone_name)
        day_start = _day_start(day, zone_name)
        if _business(day):
            available = moment - day_start
            if remaining <= available:
                return moment - remaining
            remaining -= available
        moment = day_start


def elapsed(start: datetime, end: datetime, zone_name: Optional[str]) -> timedelta:
    """The SLA time between `start` and `end`, negative when `end` comes first."""
    if zone_name is None:
        return end - start
    if end < start:
        return -elapsed(end, start, zone_name)
    total = timedelta(0)
    moment = start
    while moment < end:
        day = _local_day(moment, zone_name)
        day_end = min(_day_start(day + ONE_DAY, zone_name), end)
        if _business(day):
            total += day_end - moment
        moment = day_end
    return total


def calendar_of(zone_name: Optional[str]) -> SlaCalendar:
    """The calendar a timer stamped with `zone_name` runs on."""
    return "calendar" if zone_name is None else "business_days"
