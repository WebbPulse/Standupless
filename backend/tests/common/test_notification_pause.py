"""When a pause or working hours hold a person's email and desktop notifications."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from pydantic import ValidationError

from app.common.db.dynamo.users import User
from app.common.notification_pause import WorkingHours, bypasses_hold, held_until, next_working_moment, zone_of

MONDAY_NOON = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)


def _person(**fields: Any) -> User:
    """One user with only the fields a test names."""
    return User(id="U1", email="one@example.com", **fields)


def test_nobody_is_held_without_a_pause_or_hours() -> None:
    """The default row reaches the person at once."""
    assert held_until(_person(), MONDAY_NOON) is None


def test_a_running_pause_holds_until_it_ends() -> None:
    """A pause in the future answers its end, and one in the past holds nothing."""
    until = MONDAY_NOON + timedelta(hours=1)

    assert held_until(_person(notifications_paused_until=until), MONDAY_NOON) == until
    assert held_until(_person(notifications_paused_until=until), until) is None


def test_a_pause_without_a_zone_is_read_as_utc() -> None:
    """A naive stored moment is treated as UTC rather than failing the comparison."""
    naive = (MONDAY_NOON + timedelta(hours=2)).replace(tzinfo=None)

    assert held_until(_person(notifications_paused_until=naive), MONDAY_NOON) == MONDAY_NOON + timedelta(hours=2)


def test_working_hours_hold_outside_and_release_inside() -> None:
    """Inside the hours nothing waits, and after them the hold runs to the next working morning."""
    hours = WorkingHours(days=["mon", "tue", "wed", "thu", "fri"], start="09:00", end="17:00")
    person = _person(working_hours=hours, timezone="UTC")

    assert held_until(person, MONDAY_NOON) is None
    evening = MONDAY_NOON.replace(hour=18)
    assert held_until(person, evening) == datetime(2026, 10, 27, 9, 0, tzinfo=timezone.utc)


def test_a_weekend_waits_for_monday() -> None:
    """Saturday for someone who works weekdays holds until Monday's start."""
    hours = WorkingHours(days=["mon", "tue", "wed", "thu", "fri"])
    saturday = datetime(2026, 10, 24, 10, 0, tzinfo=timezone.utc)

    assert held_until(_person(working_hours=hours), saturday) == datetime(2026, 10, 26, 9, 0, tzinfo=timezone.utc)


def test_working_hours_are_read_in_the_persons_zone() -> None:
    """Noon UTC is 08:00 in New York in October, before a 09:00 start there."""
    hours = WorkingHours(days=["mon"], start="09:00", end="17:00")
    person = _person(working_hours=hours, timezone="America/New_York")

    assert held_until(person, MONDAY_NOON) == datetime(2026, 10, 26, 13, 0, tzinfo=timezone.utc)


def test_a_pause_ending_outside_hours_moves_on_to_the_next_start() -> None:
    """A pause and a schedule combine: the later of the two wins."""
    hours = WorkingHours(days=["mon", "tue", "wed", "thu", "fri"])
    person = _person(working_hours=hours, notifications_paused_until=MONDAY_NOON.replace(hour=20))

    assert held_until(person, MONDAY_NOON) == datetime(2026, 10, 27, 9, 0, tzinfo=timezone.utc)


def test_an_unknown_zone_falls_back_to_utc() -> None:
    """A stored zone name the system no longer knows reads as UTC."""
    assert zone_of("Mars/Olympus") == zone_of(None)


def test_next_working_moment_inside_hours_is_now() -> None:
    """A moment already inside the hours is returned as it is."""
    hours = WorkingHours(days=["mon"])
    assert next_working_moment(hours, zone_of("UTC"), MONDAY_NOON) == MONDAY_NOON


@pytest.mark.parametrize(
    "fields",
    [
        {"days": []},
        {"days": ["mon"], "start": "17:00", "end": "09:00"},
        {"days": ["mon"], "start": "24:00"},
        {"days": ["mon"], "end": "5pm"},
        {"days": ["funday"]},
    ],
)
def test_a_malformed_schedule_is_refused(fields: dict[str, Any]) -> None:
    """No days, a day ending before it starts, a bad clock or an unknown day all fail validation."""
    with pytest.raises(ValidationError):
        WorkingHours(**fields)


def test_days_are_kept_in_week_order_once_each() -> None:
    """The stored days read the same whatever order they were sent in."""
    assert WorkingHours(days=["sun", "mon", "mon"]).days == ["mon", "sun"]


def test_only_direct_mentions_and_urgent_assignments_bypass() -> None:
    """The bypass is opt in, covers every mention and only urgent assignments."""
    off = _person()
    on = _person(urgent_bypasses_pause=True)

    assert not bypasses_hold(off, "mentioned", urgent=True)
    assert bypasses_hold(on, "mentioned", urgent=False)
    assert bypasses_hold(on, "assigned", urgent=True)
    assert not bypasses_hold(on, "assigned", urgent=False)
    assert not bypasses_hold(on, "commented", urgent=True)
