"""Request and response schemas for the workspace authentication policy routes."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.common.db.dynamo.memberships import AuthPolicy


class AuthPolicyUpdate(BaseModel):
    """The body `PUT /api/workspaces/{workspace_id}/auth-policy` takes."""

    require_two_factor: bool = Field(
        description="Whether every member must have an authenticator app to reach the workspace.",
    )


class AuthPolicyRead(BaseModel):
    """The workspace's authentication policy and whether its plan allows turning it on."""

    require_two_factor: bool
    updated_at: Optional[datetime] = None
    updated_by: Optional[str] = None
    available: bool = Field(description="Whether the workspace's plan includes the authentication policy.")

    @classmethod
    def from_policy(cls, policy: AuthPolicy, *, available: bool) -> "AuthPolicyRead":
        """Build the response from the stored policy and the plan's verdict."""
        return cls(
            require_two_factor=policy.require_two_factor,
            updated_at=policy.updated_at,
            updated_by=policy.updated_by,
            available=available,
        )
