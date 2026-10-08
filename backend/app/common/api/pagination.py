"""Opaque list cursors over `webbpulse.dynamodb`'s start-key codec, and the fan-out merge.

The list envelope is `webbpulse.http.cursor_page` and the codec is
`webbpulse.dynamodb.encode_start_key`; only the page-one fallback is here. The
package's `encode_cursor` signs under an application secret, and the issues domain
is a gateway-authorized function that holds no such secret, so these cursors are
stamped with their scope and validated rather than signed. A cursor minted under
one workspace or query is refused on any other.
"""

from __future__ import annotations

import hashlib
from typing import Any, Optional, Sequence

from webbpulse.dynamodb import InvalidStartKey, decode_start_key, encode_start_key


def digest_scope(scope: str) -> str:
    """A scope of any length as a fixed-length one.

    A fan-out scope names every team it read, which grows with the workspace, while
    a start-key token has a length cap; the digest keeps the binding and the bound.
    """
    return hashlib.sha256(scope.encode("utf-8")).hexdigest()


def resume_key(cursor: Optional[str], scope: str) -> dict[str, Any] | None:
    """A cursor back as a start key, or `None` for the first page when it will not serve.

    A malformed, stale or foreign-scoped cursor starts the caller from the beginning,
    which is a correct answer, while a 500 or 400 on an old bookmark would not be.
    """
    try:
        return decode_start_key(cursor, scope=scope)
    except InvalidStartKey:
        return None


def encode_offset_cursor(offset: int, scope: str) -> str | None:
    """A position in a merged result set as a cursor, or `None` at the end.

    The fan-out across several teams has no single `LastEvaluatedKey`: the merge
    happens after the reads, so the only meaningful boundary is how far into the
    merged order the caller got.
    """
    if offset <= 0:
        return None
    return encode_start_key({"offset": offset}, scope=scope)


def decode_offset_cursor(cursor: Optional[str], scope: str) -> int:
    """A merged-fan-out cursor back as an offset, or 0 when it will not serve."""
    payload = resume_key(cursor, scope)
    if not payload:
        return 0
    try:
        offset = int(payload.get("offset", 0))
    except (TypeError, ValueError):
        return 0
    return max(offset, 0)


def merge_sorted(rows: Sequence[Any], key: Any, *, descending: bool) -> list[Any]:
    """Every row of a fan-out in one order.

    The per-team reads each come back in their own index order, and the merged
    answer has to be sorted by the requested key across all of them.
    """
    return sorted(rows, key=key, reverse=descending)
