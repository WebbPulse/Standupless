"""Base 62 fractional order keys, the server's twin of the web client's `orderBetween`.

A manual position is a key that sorts between its neighbours as a plain string,
so a reorder rewrites one row and two viewers reading the same rows agree on the
order without any renumbering.
"""

from __future__ import annotations

from typing import Iterable, Optional

BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def order_key_between(before: Optional[str], after: Optional[str]) -> str:
    """The shortest key that sorts after `before` and ahead of `after`, either open when None.

    Raises ValueError when `before` does not sort ahead of `after`, or when no key
    fits ahead of an all zero `after`.
    """
    low = before or ""
    high = after or ""
    if high and low >= high:
        raise ValueError("before must sort ahead of after")
    key = ""
    bounded = bool(high)
    index = 0
    while True:
        if bounded and index >= len(high):
            raise ValueError("no key sorts ahead of an all zero key")
        low_digit = BASE62.index(low[index]) if index < len(low) else 0
        high_digit = BASE62.index(high[index]) if bounded else len(BASE62)
        if high_digit - low_digit > 1:
            return key + BASE62[(low_digit + high_digit) // 2]
        if high_digit > low_digit:
            bounded = False
        key += BASE62[low_digit]
        index += 1


def order_key_first(existing: Iterable[Optional[str]]) -> Optional[str]:
    """A key that sorts ahead of every placed key in `existing`, or None when none fits.

    Rows never placed are skipped, since they already sort after every placed one.
    """
    placed = [key for key in existing if key]
    try:
        return order_key_between(None, min(placed) if placed else None)
    except ValueError:
        return None
