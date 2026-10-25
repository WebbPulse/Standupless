"""The SLA clock: calendar time stays plain arithmetic, business days skip local weekends.

2026-10-23 is a Friday. America/New_York falls back on Sunday 2026-11-01, and
Asia/Jerusalem springs forward on Friday 2026-03-27, a weekday that runs 23
hours, so both kinds of daylight saving change are covered.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.common.sla_clock import advance, calendar_of, elapsed, retreat

NEW_YORK = "America/New_York"
JERUSALEM = "Asia/Jerusalem"
UTC = "UTC"


def _at(text: str) -> datetime:
    """A UTC moment from an ISO string."""
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)


def _hours(count: float) -> timedelta:
    """`count` hours."""
    return timedelta(hours=count)


@pytest.mark.parametrize("amount", [_hours(1), _hours(48), _hours(200), -_hours(30)])
def test_calendar_time_is_plain_arithmetic(amount: timedelta) -> None:
    """Without a zone every function matches plain datetime arithmetic, weekends included."""
    start = _at("2026-10-23T12:00:00")
    assert advance(start, amount, None) == start + amount
    assert retreat(start, amount, None) == start - amount
    assert elapsed(start, start + amount, None) == amount


def test_a_deadline_inside_one_weekday_is_unchanged() -> None:
    """A window that ends before the weekend reads the same on either clock."""
    start = _at("2026-10-21T09:00:00")
    assert advance(start, _hours(8), UTC) == start + _hours(8)
    assert elapsed(start, start + _hours(8), UTC) == _hours(8)


def test_a_deadline_crossing_a_weekend_skips_it() -> None:
    """A day long SLA opened on Friday noon breaches on Monday noon."""
    start = _at("2026-10-23T12:00:00")
    deadline = advance(start, _hours(24), UTC)
    assert deadline == _at("2026-10-26T12:00:00")
    assert elapsed(start, deadline, UTC) == _hours(24)
    assert retreat(deadline, _hours(24), UTC) == start


def test_a_week_of_business_time_is_a_calendar_week() -> None:
    """Five business days from a Wednesday lands on the next Wednesday."""
    start = _at("2026-10-21T10:00:00")
    assert advance(start, _hours(120), UTC) == _at("2026-10-28T10:00:00")


def test_a_timer_started_on_a_weekend_waits_for_monday() -> None:
    """A Saturday start counts nothing until Monday midnight."""
    start = _at("2026-10-24T15:00:00")
    assert advance(start, _hours(4), UTC) == _at("2026-10-26T04:00:00")
    assert elapsed(start, _at("2026-10-26T00:00:00"), UTC) == timedelta(0)
    assert elapsed(start, _at("2026-10-26T06:00:00"), UTC) == _hours(6)


def test_the_end_of_friday_reads_as_saturday() -> None:
    """A deadline that uses up Friday lands on the first instant of Saturday."""
    assert advance(_at("2026-10-23T20:00:00"), _hours(4), UTC) == _at("2026-10-24T00:00:00")


def test_the_weekend_is_local_to_the_zone() -> None:
    """Friday evening in New York is still Friday even though it is Saturday in UTC."""
    start = _at("2026-10-24T01:00:00")
    assert advance(start, _hours(1), NEW_YORK) == _at("2026-10-24T02:00:00")
    assert advance(start, _hours(1), UTC) == _at("2026-10-26T01:00:00")


def test_a_daylight_saving_weekend_counts_nothing() -> None:
    """Friday noon EDT plus a day is Monday noon EST, an hour later in UTC."""
    start = _at("2026-10-30T16:00:00")
    deadline = advance(start, _hours(24), NEW_YORK)
    assert deadline == _at("2026-11-02T17:00:00")
    assert elapsed(start, deadline, NEW_YORK) == _hours(24)


def test_a_short_weekday_counts_its_real_hours() -> None:
    """The Friday Jerusalem springs forward runs 23 real hours of business time."""
    friday = _at("2026-03-26T22:00:00")
    saturday = _at("2026-03-27T21:00:00")
    assert elapsed(friday, saturday, JERUSALEM) == _hours(23)
    assert advance(friday, _hours(23), JERUSALEM) == saturday
    assert advance(friday, _hours(24), JERUSALEM) == _at("2026-03-29T22:00:00")


def test_retreat_crosses_a_weekend_back_to_friday() -> None:
    """An hour before Monday midnight is an hour before Friday ends."""
    assert retreat(_at("2026-10-26T00:00:00"), _hours(1), UTC) == _at("2026-10-23T23:00:00")
    assert retreat(_at("2026-10-26T06:00:00"), _hours(8), UTC) == _at("2026-10-23T22:00:00")


def test_retreat_from_a_weekend_starts_at_friday_end() -> None:
    """Retreating from inside a weekend counts back from the end of Friday."""
    assert retreat(_at("2026-10-25T09:00:00"), _hours(2), UTC) == _at("2026-10-23T22:00:00")


def test_elapsed_is_negative_when_the_end_comes_first() -> None:
    """Time already past a deadline reads as negative business time."""
    deadline = _at("2026-10-23T12:00:00")
    now = _at("2026-10-26T12:00:00")
    assert elapsed(now, deadline, UTC) == -_hours(24)


def test_negative_amounts_flip_direction() -> None:
    """Advancing by a negative amount retreats and retreating by one advances."""
    start = _at("2026-10-26T06:00:00")
    assert advance(start, -_hours(8), UTC) == retreat(start, _hours(8), UTC)
    assert retreat(start, -_hours(8), UTC) == advance(start, _hours(8), UTC)


def test_calendar_of_reads_the_stamped_zone() -> None:
    """A timer with no zone runs on calendar time, one with a zone on business days."""
    assert calendar_of(None) == "calendar"
    assert calendar_of(NEW_YORK) == "business_days"
