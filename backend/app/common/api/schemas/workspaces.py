"""Request and response schemas for workspaces, members and invites.

Shared by the workspaces routes and the MCP workspace tools, so both validate the
same bodies and answer the same shapes.

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
from app.common.db.dynamo.workspaces import Workspace, is_valid_slug, normalize_accent_color
from app.common.icons import icon_url
from app.common.project_cadence import DEFAULT_INTERVAL_DAYS, check_interval

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

    The name, the accent color and the default project update cadence are
    editable. The slug is not: it is the tenant's public handle and changing one
    would break every link that carries it. An absent field is left alone, and an
    explicit null `accent_color` goes back to the Standupless default.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    accent_color: Optional[str] = Field(default=None, description="The accent as #rrggbb, or null for the default")
    project_update_interval_days: Optional[int] = None

    @field_validator("accent_color")
    @classmethod
    def check_accent_color(cls, value: Optional[str]) -> Optional[str]:
        """Hold the accent to `#rrggbb`, stored lowercase so two spellings never differ."""
        if value is None:
            return None
        normalized = normalize_accent_color(value)
        if normalized is None:
            raise ValueError("accent_color must be a hex color such as #b8451a")
        return normalized

    @field_validator("project_update_interval_days")
    @classmethod
    def check_update_interval(cls, value: Optional[int]) -> Optional[int]:
        """Hold the default project update cadence to the allowed options."""
        return check_interval(value)

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
    icon_url: Optional[str] = None
    accent_color: Optional[str] = None
    role: Optional[WorkspaceRoleField] = None
    deletion_scheduled_at: Optional[datetime] = None
    deletion_scheduled_by: Optional[str] = None
    purge_after: Optional[datetime] = None
    project_update_interval_days: int = DEFAULT_INTERVAL_DAYS
    auth_policy_blocked: bool = False
    auth_policy_reason: Optional[Literal["two_factor", "sign_in_method"]] = Field(
        default=None,
        description="Why the authentication policy refuses the caller's session, when it does.",
    )
    auth_policy_allowed_methods: Optional[list[str]] = Field(
        default=None,
        description="The sign-in methods the workspace allows, when the caller's way of signing in is not one.",
    )

    @classmethod
    def from_row(
        cls,
        workspace: Workspace,
        role: Optional[str] = None,
        *,
        auth_policy_blocked: bool = False,
        auth_policy_reason: Optional[str] = None,
        auth_policy_allowed_methods: Optional[list[str]] = None,
    ) -> "WorkspaceRead":
        """Build the response shape from a stored workspace row and the caller's role.

        The deletion fields are set only while a deletion is scheduled, so every
        member sees the banner and the date the workspace goes.
        """
        return cls(
            id=workspace.id,
            name=workspace.name,
            slug=workspace.slug,
            plan=workspace.plan,
            created_at=workspace.created_at,
            icon_url=icon_url(workspace.icon_key),
            accent_color=workspace.accent_color,
            role=role,  # pyright: ignore[reportArgumentType]
            deletion_scheduled_at=workspace.deletion_scheduled_at,
            deletion_scheduled_by=workspace.deletion_scheduled_by,
            purge_after=workspace.purge_after,
            project_update_interval_days=workspace.project_update_interval_days,
            auth_policy_blocked=auth_policy_blocked,
            auth_policy_reason=auth_policy_reason,  # pyright: ignore[reportArgumentType]
            auth_policy_allowed_methods=auth_policy_allowed_methods,
        )


class WorkspaceDeletionRequest(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/deletion` takes.

    The workspace's name typed out again, compared exactly after trimming, so a
    deletion is never one misplaced click.
    """

    confirm_name: str = Field(min_length=1, max_length=80)


class WorkspaceListRead(BaseModel):
    """The body `GET /api/workspaces` answers with."""

    workspaces: list[WorkspaceRead]


class MemberRead(BaseModel):
    """One workspace member, joined with the user row for a renderable identity."""

    user_id: str
    email: str
    display_name: str
    avatar_url: Optional[str] = None
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
            avatar_url=icon_url(user.icon_key) if user is not None else None,
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
