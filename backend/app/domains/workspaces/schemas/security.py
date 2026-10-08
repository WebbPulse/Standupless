"""Request and response schemas for the workspace authentication policy routes."""

from __future__ import annotations

from datetime import datetime
from typing import Optional, cast

from pydantic import BaseModel, Field

from app.common.db.dynamo.memberships import SIGN_IN_METHODS, AuthPolicy, SignInMethod


class AuthPolicyUpdate(BaseModel):
    """The body `PUT /api/workspaces/{workspace_id}/auth-policy` takes.

    A field left out keeps its stored value.
    """

    require_two_factor: Optional[bool] = Field(
        default=None,
        description="Whether every member must have an authenticator app to reach the workspace.",
    )
    allowed_methods: Optional[list[SignInMethod]] = Field(
        default=None,
        min_length=1,
        description="The sign-in methods a session may have used to reach the workspace.",
    )


class AuthPolicyRead(BaseModel):
    """The workspace's authentication policy and whether its plan allows turning it on."""

    require_two_factor: bool
    allowed_methods: list[SignInMethod]
    updated_at: Optional[datetime] = None
    updated_by: Optional[str] = None
    available: bool = Field(description="Whether the workspace's plan includes the authentication policy.")
    current_method: Optional[SignInMethod] = Field(
        default=None,
        description="How the caller's own session signed in, which the allowed methods must keep.",
    )

    @classmethod
    def from_policy(
        cls,
        policy: AuthPolicy,
        *,
        available: bool,
        current_method: Optional[str] = None,
    ) -> "AuthPolicyRead":
        """Build the response from the stored policy, the plan's verdict and the caller's sign-in method."""
        method = cast(SignInMethod, current_method) if current_method in SIGN_IN_METHODS else None
        return cls(
            require_two_factor=policy.require_two_factor,
            allowed_methods=list(policy.allowed_methods),
            updated_at=policy.updated_at,
            updated_by=policy.updated_by,
            available=available,
            current_method=method,
        )
