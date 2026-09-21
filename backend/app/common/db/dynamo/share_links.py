"""Share link policy: what a token may target, and the product fields it carries.

The storage is not here. Share links are the identity package's share tokens,
stored in its own `share-tokens` table through `DynamoShareTokenStore`, and the
package's `mint_share_token`, `verify_share_token` and `revoke_share_token` are
what run.

What stays is the product's own shape. The package models a token as a tenant, a
target and an opaque `capability` mapping it never interprets, so `team_id` and
`title` travel in that mapping and are read back out through `ShareLinkView`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Mapping

from webbpulse.identity.share_tokens import ShareTokenRecord

TargetType = Literal["issue", "view"]

TARGET_TYPES: tuple[str, ...] = ("issue", "view")

CAPABILITY_TEAM_ID = "team_id"

CAPABILITY_TITLE = "title"


def share_capability(team_id: str, title: str) -> dict[str, str]:
    """The product fields a minted token carries in the package's `capability`.

    The package stores this mapping untouched, which is what keeps a share link one
    row in one table rather than a package row plus a product row beside it.
    """
    return {CAPABILITY_TEAM_ID: team_id, CAPABILITY_TITLE: title}


class ShareLinkView:
    """One share token read as this product's share link.

    A reader over the package's record rather than a second model of it, so there
    is one stored shape and the product's extra fields are projected out of the
    capability mapping instead of being persisted twice.
    """

    def __init__(self, record: ShareTokenRecord) -> None:
        """Wrap one stored record."""
        self._record = record

    @property
    def record(self) -> ShareTokenRecord:
        """The underlying package record."""
        return self._record

    @property
    def token_hash(self) -> str:
        """The stored form of the token, which is also this link's handle."""
        return self._record.token_hash

    @property
    def workspace_id(self) -> str:
        """The workspace this link belongs to, which the package calls the tenant."""
        return self._record.tenant_id

    @property
    def target_type(self) -> str:
        """Whether this link targets an issue or a saved view."""
        return self._record.target_type

    @property
    def target_id(self) -> str:
        """The id of the one row this link resolves."""
        return self._record.target_id

    @property
    def team_id(self) -> str:
        """The team the target belongs to, read out of the capability mapping."""
        return str(self._capability.get(CAPABILITY_TEAM_ID, "") or "")

    @property
    def title(self) -> str:
        """The target's title as it was at mint time, for the settings listing."""
        return str(self._capability.get(CAPABILITY_TITLE, "") or "")

    @property
    def created_by(self) -> str:
        """Who minted this link."""
        return self._record.created_by

    @property
    def created_at(self) -> datetime:
        """When this link was minted."""
        return _as_datetime(self._record.created_at) or datetime.now(timezone.utc)

    @property
    def expires_at(self) -> int:
        """The TTL stamp, zero when the link does not expire."""
        return self._record.expires_at

    @property
    def revoked_at(self) -> datetime | None:
        """When this link was revoked, or `None` while it is live."""
        return _as_datetime(self._record.revoked_at)

    def is_usable(self, *, now: datetime | None = None) -> bool:
        """Whether this link may be resolved right now, per the package's own check."""
        return self._record.is_usable(now=now)

    @property
    def _capability(self) -> Mapping[str, Any]:
        """The product fields the package round-tripped untouched."""
        return self._record.capability or {}


def _as_datetime(stamp: str) -> datetime | None:
    """An ISO stamp as an instant, or `None` when it is empty.

    The package writes a trailing `Z`, which is rewritten to an explicit UTC offset
    so the result is always aware and compares against other aware instants.
    """
    if not stamp:
        return None
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))
