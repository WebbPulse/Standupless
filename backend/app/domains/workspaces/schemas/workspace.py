"""Request and response schemas for the workspaces domain.

Every list route answers an object with one plural key, never a bare array, so a
cursor can arrive beside the items without breaking a client.
`webbpulse.http.CursorPage` carries an `items` key instead, so it cannot serve
these bodies; the envelopes stay declared here and the gap is reported upstream.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.common.db.dynamo.invites import Invite
from app.common.db.dynamo.memberships import Membership
from app.common.db.dynamo.users import User
from app.common.db.dynamo.workspaces import Workspace, is_valid_slug

WorkspaceRoleField = Literal["owner", "admin", "member", "guest"]

InvitableRoleField = Literal["admin", "member", "guest"]


class WorkspaceCreate(BaseModel):
    """The body `POST /api/workspaces` takes."""

    name: str = Field(min_length=1, max_length=80)
    slug: str = Field(min_length=3, max_length=40)

    @field_validator("slug")
    @classmethod
    def check_slug(cls, value: str) -> str:
        """Hold the slug to the contract's alphabet before it reaches the table.

        Validating here means a bad slug is a 422 naming the field rather than a
        conditional write failure that would read as a conflict.
        """
        candidate = value.strip().lower()
        if not is_valid_slug(candidate):
            raise ValueError("slug must be 3 to 40 characters of a to z, 0 to 9 and hyphens")
        return candidate

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        candidate = value.strip()
        if not candidate:
            raise ValueError("name must not be blank")
        return candidate


class WorkspaceUpdate(BaseModel):
    """The body `PATCH /api/workspaces/{workspace_id}` takes.

    Only the name is editable: the slug is the tenant's public handle and changing
    one would break every link that carries it.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: Optional[str]) -> Optional[str]:
        """Reject a name that is only whitespace."""
        if value is None:
            return None
        candidate = value.strip()
        if not candidate:
            raise ValueError("name must not be blank")
        return candidate


class WorkspaceRead(BaseModel):
    """One workspace as the API returns it.

    `role` is the caller's own role, present only on a response to a member, so a
    client can render the right controls without a second call.
    """

    id: str
    name: str
    slug: str
    plan: str
    created_at: datetime
    role: Optional[WorkspaceRoleField] = None

    @classmethod
    def from_row(cls, workspace: Workspace, role: Optional[str] = None) -> "WorkspaceRead":
        """Build the response shape from a stored workspace row and the caller's role."""
        return cls(
            id=workspace.id,
            name=workspace.name,
            slug=workspace.slug,
            plan=workspace.plan,
            created_at=workspace.created_at,
            role=role,  # pyright: ignore[reportArgumentType]
        )


class WorkspaceListRead(BaseModel):
    """The body `GET /api/workspaces` answers with."""

    workspaces: list[WorkspaceRead]


class MemberRead(BaseModel):
    """One workspace member, joined with the user row for a renderable identity."""

    user_id: str
    email: str
    display_name: str
    role: WorkspaceRoleField
    joined_at: datetime

    @classmethod
    def from_rows(cls, membership: Membership, user: Optional[User]) -> "MemberRead":
        """Build the response from a membership and the user row it points at.

        A missing user row still answers a member, because the membership is the
        authorization fact and dropping it would hide someone who holds access.
        """
        return cls(
            user_id=membership.user_id,
            email=user.email if user is not None else "",
            display_name=display_name_for(user),
            role=membership.role,  # pyright: ignore[reportArgumentType]
            joined_at=membership.joined_at,
        )


class MemberListRead(BaseModel):
    """The body the members list route answers with."""

    members: list[MemberRead]


class MemberUpdate(BaseModel):
    """The body a member role change takes."""

    role: WorkspaceRoleField


class InviteCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/invites` takes.

    `owner` is absent from the role type on purpose: ownership is granted to an
    existing member, never handed to an unaccepted email address.
    """

    email: EmailStr
    role: InvitableRoleField


class InviteRead(BaseModel):
    """One invite as the API returns it, carrying no token."""

    invite_id: str
    email: str
    role: str
    invited_by: str
    expires_at: datetime
    created_at: datetime

    @classmethod
    def from_row(cls, invite: Invite) -> "InviteRead":
        """Build the response shape from a stored invite row."""
        return cls(
            invite_id=invite.invite_id,
            email=invite.email,
            role=invite.role,
            invited_by=invite.invited_by,
            expires_at=invite.expires_at,
            created_at=invite.created_at,
        )


class InviteCreated(InviteRead):
    """The 201 body of a created invite, carrying the token exactly once.

    Only the hash is stored, so this response is the single moment the token
    exists in readable form. Mail delivery is out of M1's scope, which is why the
    token is returned to the caller to pass on.
    """

    token: str

    @classmethod
    def from_created(cls, invite: Invite, token: str) -> "InviteCreated":
        """Build the one-time response from the stored invite and its raw token."""
        return cls(
            invite_id=invite.invite_id,
            email=invite.email,
            role=invite.role,
            invited_by=invite.invited_by,
            expires_at=invite.expires_at,
            created_at=invite.created_at,
            token=token,
        )


class InviteListRead(BaseModel):
    """The body the invites list route answers with."""

    invites: list[InviteRead]


class InviteAccept(BaseModel):
    """The body `POST /api/invites/accept` takes."""

    token: str = Field(min_length=1)


def display_name_for(user: Optional[User]) -> str:
    """A renderable name for a user row, falling back to the email local part.

    The contract promises a `display_name` on every member, so a user who never
    set one still gets something a client can show.
    """
    if user is None:
        return ""
    name = user.display_name.strip()
    if name:
        return name
    return user.email.partition("@")[0]
