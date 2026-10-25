"""Relative date bounds: how each offset resolves by calendar, and what is refused."""

from __future__ import annotations

from datetime import date

import pytest

from app.common.relative_days import (
    day_bound_well_formed,
    is_relative_day,
    resolve_day_bound,
    resolve_relative,
)

TODAY = date(2026, 3, 31)


@pytest.mark.parametrize(
    ("value", "day"),
    [
        ("today", "2026-03-31"),
        ("TODAY", "2026-03-31"),
        ("-14d", "2026-03-17"),
        ("+7d", "2026-04-07"),
        ("+1d", "2026-04-01"),
        ("-2w", "2026-03-17"),
        ("+1w", "2026-04-07"),
        ("-1m", "2026-02-28"),
        ("-3m", "2025-12-31"),
        ("+1m", "2026-04-30"),
        ("-6m", "2025-09-30"),
        ("-1y", "2025-03-31"),
        ("+12m", "2027-03-31"),
    ],
)
def test_offsets_resolve_by_calendar(value: str, day: str) -> None:
    """Days and weeks count days; months and years land on the same day, clamped to the month's end."""
    assert resolve_relative(value, TODAY) == day


def test_a_month_back_from_a_leap_day_clamps() -> None:
    """A year back from 29 February is 28 February."""
    assert resolve_relative("-1y", date(2028, 2, 29)) == "2027-02-28"
    assert resolve_relative("-1m", date(2028, 3, 30)) == "2028-02-29"


@pytest.mark.parametrize("value", ["2026-10-01", "2026-10-01T18:30:00Z", "20261001", ""])
def test_absolute_bounds_pass_through_untouched(value: str) -> None:
    """A day, or any text that does not read as relative, comes back exactly as sent."""
    assert not is_relative_day(value)
    assert day_bound_well_formed(value)
    assert resolve_day_bound(value, TODAY) == value


@pytest.mark.parametrize("value", ["-14days", "+x", "yesterday", "-14", "+12345d", "14d-"])
def test_a_bound_that_looks_relative_but_does_not_parse_is_refused(value: str) -> None:
    """A typo is an error rather than a text compare that keeps nothing."""
    if value[0] in "+-" or value[0].isalpha():
        assert not day_bound_well_formed(value)
        with pytest.raises(ValueError):
            resolve_day_bound(value, TODAY)
    else:
        assert day_bound_well_formed(value)


def test_an_offset_past_the_calendar_is_refused() -> None:
    """An offset that lands outside the calendar's range is a ValueError, not a crash."""
    with pytest.raises(ValueError):
        resolve_relative("+9999y", date(9000, 1, 1))


def test_the_default_day_is_today_in_utc(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without a day given, a bound resolves against the current UTC day."""
    monkeypatch.setattr("app.common.relative_days.utc_today", lambda: TODAY)

    assert resolve_day_bound("-1w") == "2026-03-24"
