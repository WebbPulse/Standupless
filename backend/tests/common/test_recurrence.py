"""Recurrence rules: local wall time across daylight saving, month ends, weekdays and intervals."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from app.common.recurrence import RecurrenceError, Rule, next_run, upcoming_runs

NEW_YORK = "America/New_York"


def _rule(**fields: object) -> Rule:
    """A daily 09:00 UTC rule from 2026-01-01, with any field replaced."""
    base: dict[str, object] = {
        "frequency": "daily",
        "interval": 1,
        "weekdays": (),
        "day_of_month": None,
        "at": "09:00",
        "timezone": "UTC",
        "starts_on": date(2026, 1, 1),
    }
    base.update(fields)
    return Rule(**base)  # pyright: ignore[reportArgumentType]


def test_next_run_is_strictly_after() -> None:
    """A run at exactly `after` is not the next one."""
    rule = _rule()
    assert next_run(rule, datetime(2026, 3, 1, 8, 0, tzinfo=UTC)) == datetime(2026, 3, 1, 9, 0, tzinfo=UTC)
    assert next_run(rule, datetime(2026, 3, 1, 9, 0, tzinfo=UTC)) == datetime(2026, 3, 2, 9, 0, tzinfo=UTC)


def test_local_time_holds_across_daylight_saving() -> None:
    """09:00 in New York is 14:00 UTC in winter and 13:00 UTC in summer."""
    rule = _rule(timezone=NEW_YORK)
    runs = upcoming_runs(rule, datetime(2026, 3, 6, 15, 0, tzinfo=UTC), 3)
    assert runs == [
        datetime(2026, 3, 7, 14, 0, tzinfo=UTC),
        datetime(2026, 3, 8, 13, 0, tzinfo=UTC),
        datetime(2026, 3, 9, 13, 0, tzinfo=UTC),
    ]
    autumn = upcoming_runs(rule, datetime(2026, 10, 31, 14, 0, tzinfo=UTC), 2)
    assert autumn == [datetime(2026, 11, 1, 14, 0, tzinfo=UTC), datetime(2026, 11, 2, 14, 0, tzinfo=UTC)]


def test_a_skipped_spring_time_runs_an_hour_later_and_a_repeated_one_once() -> None:
    """02:30 on the spring change day runs at 03:30 local; 01:30 on the autumn day runs once, first."""
    gap = _rule(timezone=NEW_YORK, at="02:30")
    assert next_run(gap, datetime(2026, 3, 8, 0, 0, tzinfo=UTC)) == datetime(2026, 3, 8, 7, 30, tzinfo=UTC)
    fold = _rule(timezone=NEW_YORK, at="01:30")
    first = next_run(fold, datetime(2026, 11, 1, 0, 0, tzinfo=UTC))
    assert first == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)
    assert next_run(fold, first) == datetime(2026, 11, 2, 6, 30, tzinfo=UTC)


def test_monthly_past_a_short_month_runs_on_its_last_day() -> None:
    """Day 31 runs on Jan 31, Feb 28, Mar 31 and Apr 30."""
    rule = _rule(frequency="monthly", day_of_month=31)
    runs = upcoming_runs(rule, datetime(2026, 1, 1, tzinfo=UTC), 4)
    assert [run.date() for run in runs] == [date(2026, 1, 31), date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30)]


def test_monthly_interval_counts_from_the_start_month() -> None:
    """Every three months on the 15th from January runs in January, April and July."""
    rule = _rule(frequency="monthly", day_of_month=15, interval=3)
    runs = upcoming_runs(rule, datetime(2026, 1, 1, tzinfo=UTC), 3)
    assert [run.date() for run in runs] == [date(2026, 1, 15), date(2026, 4, 15), date(2026, 7, 15)]


def test_weekly_runs_on_the_chosen_weekdays() -> None:
    """Monday and Thursday every week."""
    rule = _rule(frequency="weekly", weekdays=(0, 3), starts_on=date(2026, 10, 5))
    runs = upcoming_runs(rule, datetime(2026, 10, 5, 0, 0, tzinfo=UTC), 4)
    assert [run.date() for run in runs] == [
        date(2026, 10, 5),
        date(2026, 10, 8),
        date(2026, 10, 12),
        date(2026, 10, 15),
    ]


def test_every_other_week_keeps_its_fortnight() -> None:
    """Every two weeks on Friday, from a Wednesday, skips the next week's Friday."""
    rule = _rule(frequency="weekly", weekdays=(4,), interval=2, starts_on=date(2026, 10, 7))
    runs = upcoming_runs(rule, datetime(2026, 10, 7, tzinfo=UTC), 3)
    assert [run.date() for run in runs] == [date(2026, 10, 9), date(2026, 10, 23), date(2026, 11, 6)]


def test_daily_interval_and_start_date() -> None:
    """Every three days from a future start never runs before it."""
    rule = _rule(interval=3, starts_on=date(2026, 12, 30))
    runs = upcoming_runs(rule, datetime(2026, 10, 1, tzinfo=UTC), 3)
    assert [run.date() for run in runs] == [date(2026, 12, 30), date(2027, 1, 2), date(2027, 1, 5)]


@pytest.mark.parametrize(
    "fields",
    [
        {"frequency": "weekly"},
        {"frequency": "monthly"},
        {"frequency": "hourly"},
        {"interval": 0},
        {"frequency": "weekly", "weekdays": (0,), "interval": 53},
        {"at": "9am"},
        {"timezone": "Mars/Olympus"},
    ],
)
def test_a_rule_that_cannot_run_is_refused(fields: dict[str, object]) -> None:
    """A malformed rule raises rather than scheduling nothing."""
    with pytest.raises(RecurrenceError):
        next_run(_rule(**fields), datetime(2026, 1, 1, tzinfo=UTC))
