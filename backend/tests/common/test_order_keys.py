"""Fractional order keys: every key lands strictly between its bounds."""

from __future__ import annotations

import pytest

from app.common.order_keys import order_key_between, order_key_first


def test_an_open_range_starts_in_the_middle() -> None:
    """With no neighbours the key leaves room on both sides."""
    assert order_key_between(None, None) == "V"


@pytest.mark.parametrize(
    ("before", "after"),
    [(None, "V"), ("V", None), ("A", "B"), ("A", "A1"), ("az", "b"), ("zz", None), (None, "01"), ("V", "V0V")],
)
def test_a_key_sorts_strictly_between_its_bounds(before: "str | None", after: "str | None") -> None:
    """The key is after `before` and ahead of `after` as a plain string."""
    key = order_key_between(before, after)

    assert before is None or before < key
    assert after is None or key < after


def test_bounds_out_of_order_or_an_all_zero_ceiling_are_refused() -> None:
    """No key fits, so the caller is told rather than handed a wrong one."""
    with pytest.raises(ValueError):
        order_key_between("B", "A")
    with pytest.raises(ValueError):
        order_key_between(None, "0")


def test_the_first_key_skips_unplaced_rows() -> None:
    """Unplaced rows already sort last, so only placed keys bound the new one."""
    first = order_key_first(["V", None, "F"])

    assert first is not None and first < "F"
    assert order_key_first([None]) == "V"
    assert order_key_first(["0"]) is None
