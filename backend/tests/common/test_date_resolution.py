"""Coarse planning dates: period edges, labels and how a patch settles a date beside its resolution."""

from __future__ import annotations

from typing import Any

import pytest

from app.common.date_resolution import (
    date_label,
    period_end,
    period_start,
    read_resolution,
    settle_date_fields,
    stored_resolution,
)


@pytest.mark.parametrize(
    ("value", "resolution", "start", "end"),
    [
        ("2026-11-15", "day", "2026-11-15", "2026-11-15"),
        ("2026-11-15", None, "2026-11-15", "2026-11-15"),
        ("2026-11-15", "month", "2026-11-01", "2026-11-30"),
        ("2028-02-10", "month", "2028-02-01", "2028-02-29"),
        ("2026-08-04", "quarter", "2026-07-01", "2026-09-30"),
        ("2027-01-01", "quarter", "2027-01-01", "2027-03-31"),
        ("2026-12-31", "quarter", "2026-10-01", "2026-12-31"),
        ("2027-05-20", "half", "2027-01-01", "2027-06-30"),
        ("2027-07-01", "half", "2027-07-01", "2027-12-31"),
        ("2027-03-03", "year", "2027-01-01", "2027-12-31"),
    ],
)
def test_a_period_runs_from_its_first_to_its_last_day(value: str, resolution: Any, start: str, end: str) -> None:
    """Every resolution opens and closes on the calendar edges of its period."""
    assert period_start(value, resolution) == start
    assert period_end(value, resolution) == end


@pytest.mark.parametrize(
    ("value", "resolution", "label"),
    [
        ("2026-11-15", "day", "2026-11-15"),
        ("2026-11-30", "month", "Nov 2026"),
        ("2027-03-31", "quarter", "Q1 2027"),
        ("2026-09-30", "quarter", "Q3 2026"),
        ("2027-12-31", "half", "H2 2027"),
        ("2027-12-31", "year", "2027"),
        (None, "quarter", None),
    ],
)
def test_a_date_reads_at_its_resolution(value: Any, resolution: Any, label: Any) -> None:
    """A coarse date is named by its period, an exact one by the day."""
    assert date_label(value, resolution) == label


def test_a_day_is_stored_as_no_resolution_and_read_back_as_day() -> None:
    """An exact date carries nothing extra on the row, and a dateless read answers no resolution."""
    assert stored_resolution("day") is None
    assert stored_resolution(None) is None
    assert stored_resolution("half") == "half"
    assert read_resolution("2026-01-01", None) == "day"
    assert read_resolution("2026-06-30", "half") == "half"
    assert read_resolution(None, "half") is None


def test_a_patch_widens_a_date_set_with_a_resolution() -> None:
    """A date sent with a coarse resolution moves to its period's edge."""
    fields: dict[str, Any] = {"target_date": "2026-08-04", "target_date_resolution": "quarter"}

    assert settle_date_fields(fields, "target_date", "target_date_resolution", "end", None) is None
    assert fields == {"target_date": "2026-09-30", "target_date_resolution": "quarter"}


def test_a_date_set_alone_is_an_exact_day() -> None:
    """An older caller that sends only the date gets the exact day it always did."""
    fields: dict[str, Any] = {"target_date": "2026-08-04"}

    settle_date_fields(fields, "target_date", "target_date_resolution", "end", "2026-09-30")

    assert fields == {"target_date": "2026-08-04", "target_date_resolution": None}


def test_a_resolution_set_alone_widens_the_stored_date() -> None:
    """Changing only the resolution moves the date already held."""
    fields: dict[str, Any] = {"start_date_resolution": "year"}

    settle_date_fields(fields, "start_date", "start_date_resolution", "start", "2026-08-04")

    assert fields == {"start_date": "2026-01-01", "start_date_resolution": "year"}


def test_a_resolution_with_no_date_is_refused_and_clearing_the_date_clears_it() -> None:
    """There is nothing to widen without a date, and a cleared date leaves no resolution behind."""
    refused: dict[str, Any] = {"target_date_resolution": "month"}
    cleared: dict[str, Any] = {"target_date": None}

    message = settle_date_fields(refused, "target_date", "target_date_resolution", "end", None)
    settle_date_fields(cleared, "target_date", "target_date_resolution", "end", "2026-09-30")

    assert message == "target_date_resolution needs a target_date"
    assert cleared == {"target_date": None, "target_date_resolution": None}


def test_an_untouched_pair_is_left_alone() -> None:
    """A patch naming neither field changes nothing."""
    fields: dict[str, Any] = {"name": "Launch"}

    settle_date_fields(fields, "target_date", "target_date_resolution", "end", "2026-09-30")

    assert fields == {"name": "Launch"}
