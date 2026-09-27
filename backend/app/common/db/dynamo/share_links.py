"""Share link policy: what a token may target, and the product fields it carries.

The storage is not here. Share links are the identity package's share tokens,
stored in its own `share-tokens` table through `DynamoShareTokenStore`, and the
package's `mint_share_token`, `verify_share_token` and `revoke_share_token` are
what run.

What stays is the product's own shape. The package models a token as a tenant, a
target and an opaque `capability` mapping it never interprets, so `team_id` and
`title` travel in that mapping and are read back out through `ShareLinkView`. A
`filter` link, which publishes an unsaved team filter, also carries the filter and
the sort it was snapshotted with, so the link reads exactly what it showed at mint
time whatever happens to the page it came from.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Mapping

from webbpulse.identity.share_tokens import ShareTokenRecord

TargetType = Literal["issue", "view", "filter"]

TARGET_TYPES: tuple[str, ...] = ("issue", "view", "filter")

CAPABILITY_TEAM_ID = "team_id"

CAPABILITY_TITLE = "title"

CAPABILITY_FILTER = "filter"

CAPABILITY_SORT = "sort"


def share_capability(
    team_id: str,
    title: str,
    *,
    filter: Mapping[str, Any] | None = None,
    sort: str | None = None,
) -> dict[str, Any]:
    """The product fields a minted token carries in the package's `capability`.

    The package stores this mapping untouched, which is what keeps a share link one
    row in one table rather than a package row plus a product row beside it. The
    filter and sort are present only on a `filter` link.
    """
    capability: dict[str, Any] = {CAPABILITY_TEAM_ID: team_id, CAPABILITY_TITLE: title}
    if filter is not None:
        capability[CAPABILITY_FILTER] = dict(filter)
    if sort is not None:
        capability[CAPABILITY_SORT] = sort
    return capability


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
        """Whether this link targets an issue, a saved view or a filter snapshot."""
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
    def filter(self) -> dict[str, Any]:
        """The filter a `filter` link snapshotted, empty for every other kind."""
        stored = self._capability.get(CAPABILITY_FILTER)
        return dict(stored) if isinstance(stored, Mapping) else {}

    @property
    def sort(self) -> str:
        """The sort a `filter` link snapshotted, empty for every other kind."""
        return str(self._capability.get(CAPABILITY_SORT, "") or "")

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
