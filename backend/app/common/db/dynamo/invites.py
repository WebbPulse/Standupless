"""The `invites` table: a pending workspace membership, addressed by email.

The token is never stored. Only its SHA-256 hash is, indexed by `token_hash-index`,
so the row is useless to anyone who reads the table and the plaintext exists once,
in the response to the admin who minted it.

`expires_at_ttl` is the TTL attribute, carrying the same instant as `expires_at`
in the epoch seconds DynamoDB requires, so a stale invite is reclaimed on its own
schedule. Expiry is checked in code as well, because a TTL delete is not prompt.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Any, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Repository, new_ulid, ttl_at

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import INVITES

TOKEN_INDEX = "token_hash-index"

INVITE_TTL_DAYS = 14

INVITABLE_ROLES: tuple[str, ...] = ("admin", "member", "guest")


def new_invite_id() -> str:
    """A fresh invite id, time sortable so a listing reads in mint order."""
    return new_ulid()


def new_invite_token() -> str:
    """A fresh invite token, returned once and never stored in plaintext."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """The SHA-256 hash of an invite token, which is what the table holds."""
    return hashlib.sha256(token.strip().encode("utf-8")).hexdigest()


def default_expiry() -> datetime:
    """When an invite minted now stops being redeemable."""
    return utc_now() + timedelta(days=INVITE_TTL_DAYS)


class Invite(BaseModel):
    """One pending invitation into a workspace.

    `expires_at` is stored twice: as the ISO timestamp the API returns and as the
    epoch seconds `expires_at_ttl` DynamoDB reclaims on.
    """

    workspace_id: str
    invite_id: str = Field(default_factory=new_invite_id)
    email: str
    role: str
    invited_by: str
    token_hash: str
    expires_at: datetime = Field(default_factory=default_expiry)
    created_at: datetime = Field(default_factory=utc_now)

    def is_expired(self, *, now: datetime | None = None) -> bool:
        """Whether this invite can no longer be redeemed."""
        return self.expires_at <= (now or utc_now())


class InviteRepository:
    """Reads and writes `invites` rows, workspace first except by token hash.

    `get_by_token_hash` is the one method taking no workspace: redeeming an invite
    is how a caller learns which workspace it is for, so the token itself is the
    tenancy proof and the index read answers exactly one row.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(INVITES, repository)

    def get(self, workspace_id: str, invite_id: str) -> Invite | None:
        """One invite of this workspace, or `None`."""
        if not workspace_id or not invite_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "invite_id": invite_id})
        return _as_invite(item) if item is not None else None

    def get_by_token_hash(self, token_hash: str) -> Invite | None:
        """The invite this token hash names, or `None`, through `token_hash-index`."""
        if not token_hash:
            return None
        page = self._repository.query(Key("token_hash").eq(token_hash), index_name=TOKEN_INDEX, limit=1)
        if not page.items:
            return None
        return _as_invite(page.items[0])

    def create(self, invite: Invite) -> Invite:
        """Store a new invite, raising `ConditionFailed` on an id collision."""
        self._repository.put(
            as_item(invite, expires_at_ttl=ttl_at(invite.expires_at)),
            condition=Attr("invite_id").not_exists(),
        )
        return invite

    def list_for_workspace(self, workspace_id: str, *, limit: int = 200) -> list[Invite]:
        """Every invite of this workspace, newest first."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(Key("workspace_id").eq(workspace_id), max_items=limit)
        return sorted((_as_invite(item) for item in items), key=lambda row: row.created_at, reverse=True)

    def delete(self, workspace_id: str, invite_id: str) -> bool:
        """Revoke one invite, reporting whether one was there."""
        if self.get(workspace_id, invite_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "invite_id": invite_id})
        return True


def _as_invite(item: Mapping[str, Any]) -> Invite:
    """One stored item as an `Invite`, ignoring the epoch TTL mirror."""
    fields = {key: value for key, value in item.items() if key != "expires_at_ttl"}
    return Invite.model_validate(fields)
