"""Relative date bounds for list filters: `today`, or a signed offset such as `-14d`, `+1w` or `-1m`.

A saved view or a URL holds the offset as written, so "created in the last two
weeks" keeps rolling instead of freezing to the day it was picked. Each list
resolves the offset against the request day, in UTC because the issue
timestamps are compared by their UTC day. Offsets are calendar based: a day or
a week moves by that many days, and a month or a year moves to the same day of
the month, clamped to the month's last day, so `-1m` from 31 March is 28 or 29
February. An absolute `YYYY-MM-DD` day is not touched here.
"""

from __future__ import annotations

import calendar
import re
from datetime import date, datetime, timedelta, timezone
from typing import Optional

TODAY = "today"
"""The relative bound that means the request day itself."""

RELATIVE_DAY = re.compile(r"^(?:today|[+-](\d{1,4})([dwmy]))$")
"""A relative bound: `today`, or a sign, up to four digits and a unit of days, weeks, months or years."""

RELATIVE_SYNTAX = "a day YYYY-MM-DD, or relative to today: today, -14d, +7d, -2w, -1m or +1y"
"""How a date bound may be written, for tool descriptions and refusals."""


def utc_today() -> date:
    """The request day a relative bound resolves against, the current UTC day."""
    return datetime.now(timezone.utc).date()


def is_relative_day(value: object) -> bool:
    """Whether a bound is written relative to today rather than as a day."""
    return isinstance(value, str) and RELATIVE_DAY.match(value.strip().lower()) is not None


def looks_relative(value: object) -> bool:
    """Whether a bound reads as an attempt at a relative offset: a leading sign or letter.

    A bound that looks relative but does not parse is refused, so a typo such as
    `-14days` is an error rather than a text compare that keeps nothing.
    """
    if not isinstance(value, str):
        return False
    text = value.strip()
    return bool(text) and (text[0] in "+-" or text[0].isalpha())


def day_bound_well_formed(value: object) -> bool:
    """Whether a stored date bound can run: any absolute text as before, or a valid relative offset."""
    return not looks_relative(value) or is_relative_day(value)


def _add_months(day: date, months: int) -> date:
    """`day` moved by whole calendar months, clamped to the last day of the month it lands in."""
    index = day.year * 12 + day.month - 1 + months
    year, month = divmod(index, 12)
    month += 1
    last = calendar.monthrange(year, month)[1]
    return date(year, month, min(day.day, last))


def resolve_relative(value: str, today: date) -> str:
    """A relative bound as the `YYYY-MM-DD` day it means on `today`.

    Raises `ValueError` when `value` is not a relative bound or lands outside the
    calendar's range.
    """
    match = RELATIVE_DAY.match(value.strip().lower())
    if match is None:
        raise ValueError(f"not a relative day: {value}")
    if match.group(1) is None:
        return today.isoformat()
    sign = -1 if value.strip().startswith("-") else 1
    amount = sign * int(match.group(1))
    unit = match.group(2)
    try:
        if unit == "d":
            moved = today + timedelta(days=amount)
        elif unit == "w":
            moved = today + timedelta(weeks=amount)
        elif unit == "m":
            moved = _add_months(today, amount)
        else:
            moved = _add_months(today, amount * 12)
    except (OverflowError, ValueError):
        raise ValueError(f"relative day out of range: {value}") from None
    return moved.isoformat()


def resolve_day_bound(value: Optional[str], today: Optional[date] = None) -> Optional[str]:
    """A bound with a relative offset resolved to its day, any other text returned untouched.

    `today` defaults to the current UTC day. Raises `ValueError` for a bound that
    looks relative but does not parse.
    """
    if value is None:
        return None
    if is_relative_day(value):
        return resolve_relative(value, today or utc_today())
    if looks_relative(value):
        raise ValueError(f"date bounds must be {RELATIVE_SYNTAX}")
    return value
