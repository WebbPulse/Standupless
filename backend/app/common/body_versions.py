"""The version token an issue description or a document body is saved against, so a stale save is refused.

An editor reads `body_version` with the text it starts from and sends it back as
`base_body_version` on the save. The token is a digest of the text itself rather
than a stored counter, so every write path keeps it true without stamping
anything, rows written before it existed need no backfill, and a property-only
edit never makes an open editor stale. The write is then conditioned on the
stored text still being the text the token was taken from, so two saves racing
each other cannot both land.
"""

from __future__ import annotations

import hashlib
from typing import Any, Optional

from boto3.dynamodb.conditions import Attr
from fastapi import HTTPException, status

BODY_VERSION_LENGTH = 32
"""How many hex characters of the digest a token carries."""

BODY_CHANGED = "BODY_CHANGED"
"""The error code a save made against an older body answers with."""

BODY_CHANGED_MESSAGE = "Someone else edited this since you opened it"
"""The sentence the stale save 409 carries."""


def body_version(text: Optional[str]) -> str:
    """The version token of one body, the same for a missing and an empty one."""
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:BODY_VERSION_LENGTH]


def is_stale(base: Optional[str], stored: Optional[str]) -> bool:
    """Whether a save sent against `base` would overwrite a body that changed since; no base is never stale."""
    return base is not None and base != body_version(stored)


def body_condition(stored: Optional[str], attribute: str = "body") -> Any:
    """The write condition that holds only while the stored body is still `stored`.

    An empty issue description is stored as a null, an empty string or not at
    all, so all three read as the same empty body.
    """
    if not stored:
        return Attr(attribute).not_exists() | Attr(attribute).attribute_type("NULL") | Attr(attribute).eq("")
    return Attr(attribute).eq(stored)


def body_changed(current: Optional[str]) -> HTTPException:
    """The 409 a stale save answers, carrying the body that is there now and its version."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "error_code": BODY_CHANGED,
            "message": BODY_CHANGED_MESSAGE,
            "details": {"body": current or "", "body_version": body_version(current)},
        },
    )
