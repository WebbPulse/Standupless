"""Estimate arithmetic shared by the cycle rollup and insights.

Held in `common` because the planning consumer and the views and integrations
images each weigh estimates, and two ladders for what a t-shirt size is worth
would let insights and velocity disagree about the same issue.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

TSHIRT_POINTS: dict[str, int] = {"XS": 1, "S": 2, "M": 3, "L": 5, "XL": 8}
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
