"""Estimate scales and arithmetic shared by issue writes, the cycle rollup and insights.

Held in `common` because the planning consumer and the views and integrations
images each weigh estimates, and two ladders for what a t-shirt size is worth
would let insights and velocity disagree about the same issue. The value sets
each scale offers live here too, so the values a team may pick and the points
they weigh cannot drift apart.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

SCALE_ESTIMATES: dict[str, tuple[str, ...]] = {
    "exponential": ("1", "2", "4", "8", "16"),
    "fibonacci": ("1", "2", "3", "5", "8"),
    "linear": ("1", "2", "3", "4", "5"),
    "tshirt": ("XS", "S", "M", "L", "XL"),
}
"""The values each scale offers before the team extends it."""

EXTENDED_ESTIMATES: dict[str, tuple[str, ...]] = {
    "exponential": ("32", "64"),
    "fibonacci": ("13", "21"),
    "linear": ("6", "7"),
    "tshirt": ("XXL", "XXXL"),
}
"""The larger values a team's extended toggle adds on top of its scale."""

ZERO_ESTIMATE = "0"
"""The estimate a team's zero toggle adds, the same spelling on every scale."""

TSHIRT_POINTS: dict[str, int] = {"XS": 1, "S": 2, "M": 3, "L": 5, "XL": 8, "XXL": 13, "XXXL": 21}
"""What a t-shirt estimate weighs in points, so every scale sums the same way."""


def estimate_points(value: Any) -> int:
    """One issue estimate as whole points, zero when it is unset or unreadable.

    A numeric estimate is its own value; a t-shirt size maps onto a Fibonacci-like
    ladder so a team on that scale still gets a velocity.
    """
    if value is None:
        return 0
    text = str(value).strip()
    if not text:
        return 0
    if text.upper() in TSHIRT_POINTS:
        return TSHIRT_POINTS[text.upper()]
    try:
        number = Decimal(text)
    except InvalidOperation:
        return 0
    if not number.is_finite() or number <= 0:
        return 0
    return int(number)


def is_unestimated(value: Any) -> bool:
    """Whether an issue carries no estimate at all; a zero estimate is an estimate."""
    return value is None or not str(value).strip()


def allowed_estimates(scale: str, *, extended: bool = False, allow_zero: bool = False) -> tuple[str, ...]:
    """Every estimate one scale accepts under the team's toggles, empty when the scale is off.

    Zero leads the list so a picker reads smallest first, and the extended values
    follow the base ones for the same reason.
    """
    base = SCALE_ESTIMATES.get(scale)
    if base is None:
        return ()
    values = (ZERO_ESTIMATE,) if allow_zero else ()
    values += base
    if extended:
        values += EXTENDED_ESTIMATES.get(scale, ())
    return values
