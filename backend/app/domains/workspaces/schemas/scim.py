"""Request and response schemas for a workspace's SCIM provisioning settings.

A token's plaintext appears in exactly one response, the one that mints it. Every
other read carries only the prefix, so the settings page can tell tokens apart
without ever being able to show one again.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field
from webbpulse.identity.api_keys import ApiKeyRecord

from app.domains.workspaces.schemas.api_key import ApiKeyRead


class ScimTokenCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/sso/scim/tokens` takes."""

    name: str = Field(default="SCIM", min_length=1, max_length=80, description="A label, such as the directory's name.")


class ScimTokenRead(BaseModel):
    """One live SCIM bearer token, without its secret."""

    key_id: str
    name: str
    prefix: str
    created_by: str
    created_at: datetime
    last_used_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, row: ApiKeyRecord) -> "ScimTokenRead":
        """The token's public fields, parsed the way an API key listing parses them."""
        read = ApiKeyRead.from_row(row)
        return cls(
            key_id=read.key_id,
            name=read.name,
            prefix=read.prefix,
            created_by=read.created_by,
            created_at=read.created_at,
            last_used_at=read.last_used_at,
        )


class ScimTokenCreated(ScimTokenRead):
    """The one response that carries a SCIM token's plaintext."""

    secret: str


class ScimSettingsRead(BaseModel):
    """What an identity provider needs to provision the workspace: the base URL and the live tokens."""

    base_url: str
    tokens: list[ScimTokenRead]
