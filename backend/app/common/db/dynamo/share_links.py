"""The `share_links` table: one token, one target, and nothing that widens.

A share link is a capability: holding the token is the whole of the authorization,
so the row it resolves to is the whole of what it grants. The row names exactly one
issue or one saved view, and the public read is bounded by that name rather than by
a filter applied afterwards.

The token is stored only as its SHA-256, exactly as an API key is, so the listing a
settings page reads cannot be replayed as a credential.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import SHARE_LINKS

TargetType = Literal["issue", "view"]

TARGET_TYPES: tuple[str, ...] = ("issue", "view")

TOKEN_BYTES = 32
"""How much entropy a share token carries.

256 bits, because the token is the only credential on a public route and there is
no rate limit, lockout or second factor standing behind it. Guessing must be
infeasible rather than merely impractical.
"""

TOKEN_PREFIX = "shr_"
"""What every share token starts with, so one is recognisable in a log or a report.

Distinct from the API key prefix because the two are never interchangeable: a share
token authenticates a route that takes it in the path, and an API key a route that
takes it in a header.
"""


def new_token() -> str:
    """A fresh share token. The one copy that will ever exist in the clear."""
    return f"{TOKEN_PREFIX}{secrets.token_urlsafe(TOKEN_BYTES)}"


def hash_token(token: str) -> str:
    """The stored form of a token: its SHA-256, hex encoded.

    Plain SHA-256 rather than a password hash, as the identity package does for its
    own tokens: the input is 256 bits of entropy this product generated, so there is
    no dictionary to slow down and a work factor would only cost the read path.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def target_key(workspace_id: str, target_type: str, target_id: str) -> str:
    """The `ws_target-index` hash key, which is what scopes a listing to a workspace.

    Composite and workspace first, per the design's invariant that no index hash key
    is a bare entity id, so a listing cannot reach out of its tenant even if a
    target id were guessed.
    """
    return f"{workspace_id}#{target_type}#{target_id}"


def expiry_timestamp(days: int | None, *, now: datetime | None = None) -> int:
    """The TTL stamp a link expires at, or 0 for one that does not expire."""
    if not days:
        return 0
    moment = (now or utc_now()) + timedelta(days=days)
    return int(moment.timestamp())


class ShareLink(BaseModel):
    """One public read-only link onto one issue or one saved view."""

    token_hash: str
    ws_target: str
    workspace_id: str
    target_type: str
    target_id: str
    project_id: str
    title: str
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    expires_at: int = 0
    revoked_at: datetime | None = None

    def is_expired(self, *, now: datetime | None = None) -> bool:
        """Whether this link's expiry has passed. A zero `expires_at` never expires.

        Checked on the read path rather than trusted to the TTL sweep, because
        DynamoDB deletes an expired item on its own schedule and a link must stop
        resolving at its expiry rather than at its deletion.
        """
        if not self.expires_at:
            return False
        moment = now or datetime.now(timezone.utc)
        return moment.timestamp() >= self.expires_at

    def is_usable(self, *, now: datetime | None = None) -> bool:
        """Whether this link may be resolved right now."""
        return self.revoked_at is None and not self.is_expired(now=now)


class ShareLinkRepository:
    """Reads and writes `share_links` rows.

    `get` takes a token hash and no workspace, because an anonymous reader has no
    workspace to give and resolving one is exactly what the read is for. Every later
    decision is made against the workspace on the row, so the tenant still comes
    from stored state.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(SHARE_LINKS, repository)

    def get(self, token_hash: str) -> ShareLink | None:
        """One link by its token hash, or `None`. A point read, no index."""
        if not token_hash:
            return None
        item = self._repository.get({"token_hash": token_hash})
        return ShareLink.model_validate(dict(item)) if item is not None else None

    def resolve(self, token: str, *, now: datetime | None = None) -> ShareLink | None:
        """One usable link by its plaintext token, or `None` for every refusal.

        `None` for absent, revoked and expired alike, because the caller is
        anonymous and telling the three apart would say whether a guessed token ever
        existed.
        """
        link = self.get(hash_token(token))
        if link is None or not link.is_usable(now=now):
            return None
        return link

    def create(self, link: ShareLink) -> ShareLink:
        """Store a new link, raising `ConditionFailed` when the hash is taken."""
        self._repository.put(as_item(link), condition=Attr("token_hash").not_exists())
        return link

    def revoke(self, token_hash: str, *, revoked_at: datetime | None = None) -> ShareLink | None:
        """Mark one link revoked, or `None` when it was not there.

        A write rather than a delete, so the settings list can show that a link was
        revoked rather than silently losing the row a person is looking for.
        """
        try:
            item = self._repository.set_attributes(
                {"token_hash": token_hash},
                {"revoked_at": (revoked_at or utc_now()).isoformat()},
                condition=Attr("token_hash").exists(),
            )
        except ConditionFailed:
            return None
        return ShareLink.model_validate(dict(item)) if item is not None else None

    def list_for_target(self, workspace_id: str, target_type: str, target_id: str) -> list[ShareLink]:
        """Every link onto one target, newest first, through `ws_target-index`."""
        if not workspace_id or not target_id:
            return []
        items: list[Mapping[str, Any]] = list(
            self._repository.iter_query(
                Key("ws_target").eq(target_key(workspace_id, target_type, target_id)),
                index_name="ws_target-index",
                max_items=500,
            )
        )
        rows = [ShareLink.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: row.created_at, reverse=True)

    def list_for_targets(self, workspace_id: str, targets: list[tuple[str, str]]) -> list[ShareLink]:
        """Every link onto any of several targets, newest first.

        A fan-out over `ws_target-index` rather than a workspace-wide read, because
        the table is partitioned by token hash and has no workspace partition to
        query. The caller passes the targets it may see, so an invisible project's
        links are never fetched rather than fetched and filtered.
        """
        collected: list[ShareLink] = []
        for target_type, target_id in targets:
            collected.extend(self.list_for_target(workspace_id, target_type, target_id))
        return sorted(collected, key=lambda row: row.created_at, reverse=True)
