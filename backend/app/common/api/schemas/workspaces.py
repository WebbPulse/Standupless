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

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.common.db.dynamo.invites import Invite
from app.common.db.dynamo.memberships import Membership
from app.common.db.dynamo.users import User
from app.common.db.dynamo.workspaces import (
    Workspace,
    WorkspaceFeature,
    is_reserved_slug,
    is_valid_slug,
    normalize_accent_color,
)
from app.common.icons import icon_url
from app.common.project_cadence import DEFAULT_INTERVAL_DAYS, check_interval

WorkspaceRoleField = Literal["owner", "admin", "member", "guest"]

InvitableRoleField = Literal["admin", "member", "guest"]

BranchFormatField = Literal["key_title", "user_key_title", "key"]

PermissionLevelField = Literal["admins", "members"]

MemberStatusField = Literal["active", "suspended", "invited"]

MemberBulkActionField = Literal["change_role", "suspend", "reactivate", "remove", "add_to_team"]

MemberBulkOutcomeField = Literal["changed", "unchanged", "skipped"]

BULK_MAX_MEMBERS = 200
"""The most members one bulk action names, so a request stays inside one Lambda invocation's time."""


def check_slug_value(value: str) -> str:
    """Normalize a requested slug, refusing one off the contract's alphabet or reserved by the product."""
    candidate = value.strip().lower()
    if not is_valid_slug(candidate):
        raise ValueError("slug must be 3 to 40 characters of a to z, 0 to 9 and hyphens")
    if is_reserved_slug(candidate):
        raise ValueError("slug is reserved")
    return candidate


class WorkspaceCreate(BaseModel):
    """The body `POST /api/workspaces` takes."""

    name: str = Field(min_length=1, max_length=80)
    slug: str = Field(min_length=3, max_length=40)

    @field_validator("slug")
    @classmethod
    def check_slug(cls, value: str) -> str:
        """Hold the slug to the contract's alphabet before it reaches the table.

        Validating here means a bad or reserved slug is a 422 naming the field
        rather than a conditional write failure that would read as a conflict.
        """
        return check_slug_value(value)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        candidate = value.strip()
        if not candidate:
            raise ValueError("name must not be blank")
        return candidate


class WorkspaceFeatures(BaseModel):
    """Which areas of the product are on for the workspace, every one on unless an admin turned it off."""

    initiatives: bool = Field(default=True, description="Initiatives and their updates")
    customers: bool = Field(default=True, description="Customers and customer requests")
    releases: bool = Field(default=True, description="Team releases and the release pipeline")
    documents: bool = Field(default=True, description="Documents on teams, projects and initiatives")
    pulse: bool = Field(default=True, description="The Pulse feed of updates and following projects or initiatives")

    @classmethod
    def from_row(cls, workspace: Workspace) -> "WorkspaceFeatures":
        """The flags of a stored workspace, an area it never stored counted as on."""
        return cls(**{feature.value: workspace.feature_enabled(feature) for feature in WorkspaceFeature})


class WorkspaceFeaturesUpdate(BaseModel):
    """The areas to turn on or off; an absent area is left as it is, and an unknown one is refused."""

    model_config = ConfigDict(extra="forbid")

    initiatives: Optional[bool] = None
    customers: Optional[bool] = None
    releases: Optional[bool] = None
    documents: Optional[bool] = None
    pulse: Optional[bool] = None


class WorkspaceUpdate(BaseModel):
    """The body `PATCH /api/workspaces/{workspace_id}` takes.

    The name, the accent color, the default project update cadence, the git
    branch name format, who may invite people or create teams and whether
    third-party apps need an admin's approval are editable, and so are the
    areas of the product that are on and the slug in the workspace URL. A
    changed slug keeps the old one as an alias, so links carrying it still land
    here and no other workspace can take it. An absent field is left alone, and an
    explicit null `accent_color` goes back to the Standupless default.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    slug: Optional[str] = Field(
        default=None,
        min_length=3,
        max_length=40,
        description="The workspace URL slug; the old slug keeps redirecting here",
    )
    accent_color: Optional[str] = Field(default=None, description="The accent as #rrggbb, or null for the default")
    project_update_interval_days: Optional[int] = None
    branch_format: Optional[BranchFormatField] = Field(
        default=None,
        description="How copied git branch names are built: key_title, user_key_title or key",
    )
    invite_permission: Optional[PermissionLevelField] = Field(
        default=None,
        description="Who may invite new members: admins, or every member",
    )
    team_creation_permission: Optional[PermissionLevelField] = Field(
        default=None,
        description="Who may create teams: admins, or every member",
    )
    third_party_app_approvals: Optional[bool] = Field(
        default=None,
        description="Whether members need an admin's approval before authorizing a third-party app",
    )
    features: Optional[WorkspaceFeaturesUpdate] = Field(
        default=None,
        description="Areas to turn on or off: initiatives, customers, releases, documents and pulse",
    )

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

    @field_validator("slug")
    @classmethod
    def check_slug(cls, value: Optional[str]) -> Optional[str]:
        """Hold a new slug to the same alphabet and reserved list as creation."""
        if value is None:
            return None
        return check_slug_value(value)

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


class SlugAvailabilityRead(BaseModel):
    """Whether a workspace could move to a slug, and why not when it cannot."""

    slug: str
    available: bool
    reason: Optional[Literal["invalid", "reserved", "taken", "current"]] = Field(
        default=None,
        description="Why the slug is unavailable: invalid, reserved, taken, or current when it is already this workspace's",
    )


class WorkspaceRead(BaseModel):
    """One workspace as the API returns it.

    `role` is the caller's own role, present only on a response to a member, so a
    client can render the right controls without a second call.
    """

    id: str
    name: str
    slug: str
    retired_slugs: list[str] = Field(
        default_factory=list,
        description="Earlier slugs that still redirect to this workspace, oldest first",
    )
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
    auth_policy_reason: Optional[Literal["two_factor", "sign_in_method", "sso"]] = Field(
        default=None,
        description="Why the authentication policy refuses the caller's session, when it does.",
    )
    auth_policy_allowed_methods: Optional[list[str]] = Field(
        default=None,
        description="The sign-in methods the workspace allows, when the caller's way of signing in is not one.",
    )
    branch_format: BranchFormatField = Field(
        default="key_title",
        description="How copied git branch names are built: key_title, user_key_title or key",
    )
    invite_permission: PermissionLevelField = Field(
        default="admins",
        description="Who may invite new members: admins, or every member",
    )
    team_creation_permission: PermissionLevelField = Field(
        default="members",
        description="Who may create teams: admins, or every member",
    )
    third_party_app_approvals: bool = Field(
        default=False,
        description="Whether members need an admin's approval before authorizing a third-party app",
    )
    features: WorkspaceFeatures = Field(
        default_factory=WorkspaceFeatures,
        description="Which areas are on; writes to an area that is off are refused with FEATURE_DISABLED",
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
            retired_slugs=list(workspace.retired_slugs),
            plan=workspace.effective_plan(),
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
            branch_format=workspace.branch_format,  # pyright: ignore[reportArgumentType]
            invite_permission=workspace.invite_permission,  # pyright: ignore[reportArgumentType]
            team_creation_permission=workspace.team_creation_permission,  # pyright: ignore[reportArgumentType]
            third_party_app_approvals=bool(workspace.third_party_app_approvals),
            features=WorkspaceFeatures.from_row(workspace),
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
    """One workspace member, joined with the user row for a renderable identity.

    `display_name` is the member's handle. `previous_handles` are the handles they
    gave up, so a client can render a mention written under one as the current name.
    `status` is `suspended` for a member who keeps their history but holds no
    access, and `invited` for a pending invite, which then carries `invite_id`,
    answers the invite id as `user_id` and the invite's sent time as `joined_at`.
    """

    user_id: str
    email: str
    display_name: str
    full_name: str = ""
    previous_handles: list[str] = Field(default_factory=list)
    avatar_url: Optional[str] = None
    role: WorkspaceRoleField
    joined_at: datetime
    status: MemberStatusField = "active"
    suspended_at: Optional[datetime] = None
    suspended_by: Optional[str] = None
    invite_id: Optional[str] = None

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
            full_name=user.full_name if user is not None else "",
            previous_handles=list(user.previous_handles) if user is not None else [],
            avatar_url=icon_url(user.icon_key) if user is not None else None,
            role=membership.role,  # pyright: ignore[reportArgumentType]
            joined_at=membership.joined_at,
            status="suspended" if membership.is_suspended else "active",
            suspended_at=membership.suspended_at,
            suspended_by=membership.suspended_by,
        )

    @classmethod
    def from_invite(cls, invite: Invite) -> "MemberRead":
        """A pending invite as an `invited` row of the members list."""
        return cls(
            user_id=invite.invite_id,
            email=invite.email,
            display_name=invite.email,
            role=invite.role,  # pyright: ignore[reportArgumentType]
            joined_at=invite.created_at,
            status="invited",
            invite_id=invite.invite_id,
        )


class MemberListRead(BaseModel):
    """The body the members list route answers with."""

    members: list[MemberRead]


class MemberUpdate(BaseModel):
    """The body a member role change takes."""

    role: WorkspaceRoleField


class MemberBulkUpdate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/members/bulk` takes.

    One action applied to every named member: `role` is the role `change_role`
    sets, and `team_id` the team `add_to_team` adds them to as members.
    """

    action: MemberBulkActionField
    user_ids: list[str] = Field(min_length=1, max_length=BULK_MAX_MEMBERS)
    role: Optional[WorkspaceRoleField] = None
    team_id: Optional[str] = Field(default=None, min_length=1, max_length=64)

    @field_validator("user_ids")
    @classmethod
    def check_user_ids(cls, value: list[str]) -> list[str]:
        """Drop repeats and blanks, keeping first-seen order, so no member is acted on or audited twice."""
        kept = [user_id for user_id in dict.fromkeys(item.strip() for item in value) if user_id]
        if not kept:
            raise ValueError("user_ids must name at least one member")
        return kept

    @model_validator(mode="after")
    def check_arguments(self) -> "MemberBulkUpdate":
        """Require the role a role change sets and the team an add names, and refuse them elsewhere."""
        if (self.action == "change_role") != (self.role is not None):
            raise ValueError("role is required for change_role and only allowed there")
        if (self.action == "add_to_team") != (self.team_id is not None):
            raise ValueError("team_id is required for add_to_team and only allowed there")
        return self


class MemberBulkResult(BaseModel):
    """What a bulk action did to one member.

    `changed` and `unchanged` carry the member as they now stand, absent once
    removed. `skipped` carries the refusal the single route would have answered,
    as `error_code` and `message`, so the caller can say why.
    """

    user_id: str
    outcome: MemberBulkOutcomeField
    error_code: Optional[str] = None
    message: Optional[str] = None
    member: Optional[MemberRead] = None


class MemberBulkRead(BaseModel):
    """What a bulk member action answers with: one result per named member, in request order, and the tallies."""

    results: list[MemberBulkResult]
    changed: int = 0
    unchanged: int = 0
    skipped: int = 0


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


class InviteLinkRead(BaseModel):
    """Whether the workspace's reusable invite link is on, and who minted the current one.

    The token is stored only as a hash, so this shape never carries it. It is
    shown once, in `InviteLinkCreated`, when the link is enabled or reset.
    """

    enabled: bool
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None


class InviteLinkCreated(InviteLinkRead):
    """The 201 body of an enabled or reset invite link, carrying its token exactly once."""

    token: str


class InviteLinkToken(BaseModel):
    """The body the invite link preview and join routes take."""

    token: str = Field(min_length=1, max_length=256)


class InviteLinkPreview(BaseModel):
    """What a signed-in visitor sees before joining through an invite link."""

    workspace_id: str
    name: str
    slug: str
    already_member: bool


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
