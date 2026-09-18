"""Opaque cursors over DynamoDB's `LastEvaluatedKey`, and the fan-out merge.

`webbpulse.http.CursorPage` renders its items under an `items` key, and every list
body in this product is an object with one plural key, so it cannot serve these
responses; the encoding lives here and design section 6 records the envelope as an
upstream gap.

A cursor is base64url of the JSON key, not an offset, so a page boundary stays
valid while rows are inserted ahead of it. It is opaque by contract: a client that
decodes one and hands back a key naming another workspace is refused, because every
cursor carries the scope it was minted under and a mismatch is dropped rather than
trusted.
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any, Mapping, Sequence

CURSOR_SCOPE_KEY = "__scope"
"""Where a cursor records the query it was minted for.

A `LastEvaluatedKey` is a set of table keys and carries no proof of which read
produced it. Stamping the scope in lets a cursor from one workspace's fan-out be
rejected on another's, rather than being fed to DynamoDB as a start key.
"""


def encode_cursor(start_key: Mapping[str, Any] | None, scope: str) -> str | None:
    """One `LastEvaluatedKey` as an opaque cursor, or `None` when there is no next page.

    The scope is stamped in so `decode_cursor` can refuse a cursor minted under a
    different query without the route having to compare anything itself.
    """
    if not start_key:
        return None
    payload = dict(start_key)
    payload[CURSOR_SCOPE_KEY] = scope
    raw = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(cursor: str | None, scope: str) -> dict[str, Any] | None:
    """An opaque cursor back as a start key, or `None` when it will not serve.

    Returns `None` rather than raising for anything unusable: a malformed, truncated
    or foreign-scoped cursor means the caller starts from the beginning, which is a
    correct answer, while a 500 on a stale bookmark would not be.
    """
    if not cursor:
        return None
    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
        payload = json.loads(raw)
    except (ValueError, binascii.Error, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.pop(CURSOR_SCOPE_KEY, None) != scope:
        return None
    return payload


def encode_offset_cursor(offset: int, scope: str) -> str | None:
    """A position in a merged result set as a cursor, or `None` at the end.

    The fan-out across several projects has no single `LastEvaluatedKey`: the merge
    happens after the reads, so the only meaningful boundary is how far into the
    merged order the caller got. Bounded by the caller's own page cap, so the work
    behind a deep cursor stays bounded too.
    """
    if offset <= 0:
        return None
    return encode_cursor({"offset": offset}, scope)


def decode_offset_cursor(cursor: str | None, scope: str) -> int:
    """A merged-fan-out cursor back as an offset, or 0 when it will not serve."""
    payload = decode_cursor(cursor, scope)
    if not payload:
        return 0
    try:
        offset = int(payload.get("offset", 0))
    except (TypeError, ValueError):
        return 0
    return max(offset, 0)


def merge_sorted(rows: Sequence[Any], key: Any, *, descending: bool) -> list[Any]:
    """Every row of a fan-out in one order.

    The per-project reads each come back sorted by their own index, and the merged
    answer has to be sorted by the requested key across all of them, so the merge is
    a sort rather than a heap: the inputs are already capped at the page window.
    """
    return sorted(rows, key=key, reverse=descending)
