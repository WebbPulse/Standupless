"""Request and response schemas for the API key routes.

`ApiKeyCreated` is the only shape in the product that carries a live credential,
and it is separate from `ApiKeyRead` rather than an optional field on it so no
listing can ever serialise a secret by accident: the read model has no field to
put one in.

Scope validation lives here rather than in the handler so an unknown scope is a
422 naming the offending strings, which a caller can act on, rather than a key
minted with a scope that silently grants nothing.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

from app.common.db.dynamo.api_keys import (
    API_KEY_SCOPES,
    ApiKey,
    normalise_scopes,
    unknown_scopes,
)

ApiKeyKindField = Literal["user", "workspace"]

ApiKeyScopeListField = Literal["mine", "workspace"]

MAX_KEYS_PER_WORKSPACE = 25

MIN_EXPIRY_DAYS = 1

MAX_EXPIRY_DAYS = 365


class ApiKeyCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/api-keys` takes."""

    name: str = Field(min_length=1, max_length=80)
    scopes: list[str] = Field(min_length=1)
    kind: ApiKeyKindField = "user"
    expires_in_days: Optional[int] = Field(default=None, ge=MIN_EXPIRY_DAYS, le=MAX_EXPIRY_DAYS)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace.

        A key is recognised in a settings list by its name and its prefix, and a
        blank name leaves only the prefix, which is the part a person does not
        read.
        """
        candidate = value.strip()
        if not candidate:
            raise ValueError("name must not be blank")
        return candidate

    @field_validator("scopes")
    @classmethod
    def check_scopes(cls, value: list[str]) -> list[str]:
        """Hold the requested scopes to the five the contract fixes.

        An empty list is refused rather than accepted, because a key that
        authenticates and then refuses everything is harder to diagnose than one
        that was never minted.
        """
        unknown = unknown_scopes(value)
        if unknown:
            raise ValueError(f"unknown scopes: {', '.join(unknown)}; allowed: {', '.join(API_KEY_SCOPES)}")
        normalised = normalise_scopes(value)
        if not normalised:
            raise ValueError("scopes must name at least one of: " + ", ".join(API_KEY_SCOPES))
        return normalised


class ApiKeyRead(BaseModel):
    """One stored key as a listing renders it. Carries no credential."""

    key_id: str
    name: str
    kind: ApiKeyKindField
    prefix: str
    scopes: list[str]
    created_by: str
    created_at: datetime
    expires_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, row: ApiKey) -> "ApiKeyRead":
        """Project a stored row onto the response, dropping the hash.

        The hash is omitted rather than rendered because it is the stored form of
        the credential: publishing it would turn a read grant on the listing into
        an offline target.
        """
        return cls(
            key_id=row.key_id,
            name=row.name,
            kind="workspace" if row.kind == "workspace" else "user",
            prefix=row.prefix,
            scopes=list(row.scopes),
            created_by=row.created_by,
            created_at=row.created_at,
            expires_at=_as_datetime(row.expires_at),
            last_used_at=row.last_used_at,
            revoked_at=row.revoked_at,
        )


class ApiKeyCreated(ApiKeyRead):
    """The one response that carries the plaintext key.

    There is no route that shows `secret` again and no support path that can
    recover it, because the stored row holds only a SHA-256 of it. A lost key is
    revoked and reminted.
    """

    secret: str


class ApiKeyListRead(BaseModel):
    """The list envelope, one plural key, per the contract's list shape."""

    api_keys: list[ApiKeyRead]


def _as_datetime(stamp: int) -> Optional[datetime]:
    """A TTL stamp as an instant, or `None` for a key that does not expire.

    Zero means no expiry in the table, and the contract renders that as a null
    rather than as the epoch, which a client would otherwise read as long expired.
    """
    if not stamp:
        return None
    return datetime.fromtimestamp(stamp, tz=timezone.utc)
