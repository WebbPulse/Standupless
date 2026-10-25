"""Coarse planning dates: a day, or a whole month, quarter, half or year, as Linear sets them.

A coarse date is stored as one real day beside its resolution. A start date is
held at the first day of its period and a target date at the last, so every
ordering, filter, overdue rule and timeline bar that reads the plain date keeps
working and reads a coarse target as the end of its period. A day resolution is
stored as no resolution at all, so a row written before resolutions existed
reads back exactly as it did.
"""

from __future__ import annotations

import calendar
from datetime import date
from typing import Any, Literal, Optional, cast, get_args

DateResolution = Literal["day", "month", "quarter", "half", "year"]

DATE_RESOLUTIONS: tuple[str, ...] = get_args(DateResolution)

DateEdge = Literal["start", "end"]

MONTH_NAMES: tuple[str, ...] = tuple(calendar.month_abbr[1:])


def _period_months(day: date, resolution: str) -> tuple[int, int]:
    """The first and last month of the period a day falls in."""
    if resolution == "month":
        return day.month, day.month
    if resolution == "quarter":
        first = (day.month - 1) // 3 * 3 + 1
        return first, first + 2
    if resolution == "half":
        first = 1 if day.month <= 6 else 7
        return first, first + 5
    return 1, 12


def period_start(value: str, resolution: Optional[str]) -> str:
    """The first day of the period `value` falls in, or `value` itself at day resolution."""
    if not resolution or resolution == "day":
        return value
    day = date.fromisoformat(value)
    first, _ = _period_months(day, resolution)
    return date(day.year, first, 1).isoformat()


def period_end(value: str, resolution: Optional[str]) -> str:
    """The last day of the period `value` falls in, or `value` itself at day resolution."""
    if not resolution or resolution == "day":
        return value
    day = date.fromisoformat(value)
    _, last = _period_months(day, resolution)
    return date(day.year, last, calendar.monthrange(day.year, last)[1]).isoformat()


def snap(value: str, resolution: Optional[str], edge: DateEdge) -> str:
    """One date moved to the start or the end of its period."""
    return period_start(value, resolution) if edge == "start" else period_end(value, resolution)


def stored_resolution(resolution: Optional[str]) -> Optional[str]:
    """The resolution as a row stores it: None for a day, so an exact date carries nothing extra."""
    return None if not resolution or resolution == "day" else resolution


def read_resolution(value: Optional[str], resolution: Optional[str]) -> Optional[DateResolution]:
    """The resolution a read answers: none without a date, `day` for an exact one or an unknown stored value."""
    if not value:
        return None
    return cast(DateResolution, resolution) if resolution in DATE_RESOLUTIONS else "day"


def date_label(value: Optional[str], resolution: Optional[str]) -> Optional[str]:
    """A date as people read it at its resolution: `2026-11-15`, `Nov 2026`, `Q3 2026`, `H2 2026` or `2026`."""
    if not value:
        return None
    if not resolution or resolution == "day":
        return value
    day = date.fromisoformat(value)
    if resolution == "month":
        return f"{MONTH_NAMES[day.month - 1]} {day.year}"
    if resolution == "quarter":
        return f"Q{(day.month - 1) // 3 + 1} {day.year}"
    if resolution == "half":
        return f"H{1 if day.month <= 6 else 2} {day.year}"
    return str(day.year)


def settle_date_fields(
    fields: dict[str, Any],
    date_name: str,
    resolution_name: str,
    edge: DateEdge,
    current_date: Optional[str],
) -> Optional[str]:
    """Settle one date and its resolution in a patch, answering a refusal message or None.

    A date set without a resolution is an exact day, as it always was. A date
    set with one is moved to its period's edge. A resolution set alone moves the
    stored date, and is refused when there is none. Clearing the date clears the
    resolution with it.
    """
    date_set = date_name in fields
    resolution_set = resolution_name in fields
    if not date_set and not resolution_set:
        return None
    resolution = fields.get(resolution_name) if resolution_set else None
    value = fields[date_name] if date_set else current_date
    if value is None:
        if resolution_set and stored_resolution(resolution) is not None:
            return f"{resolution_name} needs a {date_name}"
        fields[resolution_name] = None
        if date_set:
            fields[date_name] = None
        return None
    fields[date_name] = snap(value, resolution, edge)
    fields[resolution_name] = stored_resolution(resolution)
    return None
