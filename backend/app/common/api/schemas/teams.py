"""Request and response schemas for the teams domain.

Every list body is an object with one plural key, matching the workspaces domain
and the contract. `next_issue_number` is never a field on any of these models: it
is an allocation detail and exposing it would leak how many issues exist.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, StrictBool, field_validator, model_validator

from app.common.db.dynamo.memberships import Membership
from app.common.db.dynamo.team_config import (
    MAX_UPCOMING_CYCLES,
    ArchiveSettings,
    CycleSettings,
    Label,
    Status,
    TriageSettings,
)
from app.common.db.dynamo.teams import Team, is_valid_key_prefix
from app.common.db.dynamo.users import User
from app.common.icons import icon_url
from app.common.status_appearance import StatusColor, StatusIcon, check_icon

EstimateScaleField = Literal["off", "exponential", "fibonacci", "linear", "tshirt"]

StatusCategoryField = Literal["backlog", "unstarted", "started", "completed", "cancelled"]

TeamRoleField = Literal["admin", "member"]

COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")


def _check_key_prefix(value: str) -> str:
    """Hold a key prefix to the contract's alphabet, uppercase only."""
    candidate = value.strip()
    if candidate != candidate.upper():
        raise ValueError("key_prefix must be uppercase")
    if not is_valid_key_prefix(candidate):
        raise ValueError("key_prefix must be 2 to 6 characters, starting with a letter, A to Z and 0 to 9")
    return candidate


class TeamCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/teams` takes."""

    name: str = Field(min_length=1, max_length=80)
    key_prefix: str = Field(min_length=2, max_length=6)
    description: Optional[str] = Field(default=None, max_length=2000)
    estimate_scale: EstimateScaleField = "off"
    estimate_extended: bool = False
    estimate_allow_zero: bool = False
    estimate_count_unestimated: bool = False
    private: bool = False

    @field_validator("key_prefix")
    @classmethod
    def check_key_prefix(cls, value: str) -> str:
        """Hold the key prefix to the contract's alphabet.

        Validating here makes a bad prefix a 422 naming the field, so the only
        conflict the create route has to handle is a prefix already in use.
        """
        return _check_key_prefix(value)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        candidate = value.strip()
        if not candidate:
            raise ValueError("name must not be blank")
        return candidate


class TeamUpdate(BaseModel):
    """The body a team patch takes.

    A new `key_prefix` retires the old one as an alias, so issue keys under the
    old prefix keep resolving and no other team can take it. `sync_pr_labels`
    turns off copying this team's issue labels onto linked pull requests.
    `private` hides the team and its issues from everyone who is not a member.
    `estimate_extended` adds the larger values to the scale, `estimate_allow_zero`
    adds 0, and `estimate_count_unestimated` counts an unestimated issue as one
    point in cycle and project progress instead of skipping it.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    key_prefix: Optional[str] = Field(default=None, min_length=2, max_length=6)
    estimate_scale: Optional[EstimateScaleField] = None
    estimate_extended: Optional[bool] = None
    estimate_allow_zero: Optional[bool] = None
    estimate_count_unestimated: Optional[bool] = None
    description: Optional[str] = Field(default=None, max_length=2000)
    sync_pr_labels: Optional[bool] = None
    private: Optional[bool] = None

    @field_validator("key_prefix")
    @classmethod
    def check_key_prefix(cls, value: Optional[str]) -> Optional[str]:
        """Hold a new key prefix to the same alphabet create does."""
        if value is None:
            return None
        return _check_key_prefix(value)

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


class TeamRead(BaseModel):
    """One team as the API returns it, carrying the caller's team role."""

    id: str
    workspace_id: str
    name: str
    key_prefix: str
    description: Optional[str] = None
    estimate_scale: str
    estimate_extended: bool = False
    estimate_allow_zero: bool = False
    estimate_count_unestimated: bool = False
    sync_pr_labels: bool = True
    private: bool = False
    icon_url: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    role: Optional[TeamRoleField] = None
    member_count: int = 0
    is_member: bool = False
    retired_key_prefixes: list[str] = Field(default_factory=list)

    @classmethod
    def from_row(
        cls,
        team: Team,
        role: Optional[str] = None,
        *,
        member_count: int = 0,
        is_member: bool = False,
        retired_key_prefixes: Optional[list[str]] = None,
        private: bool = False,
    ) -> "TeamRead":
        """Build the response from a team row, the caller's role and membership counts.

        `member_count` and `is_member` count explicit team memberships, the rows
        join, leave and the members routes write. `private` comes from the
        authorization context, which already read the workspace's private set.
        """
        return cls(
            id=team.team_id,
            workspace_id=team.workspace_id,
            name=team.name,
            key_prefix=team.key_prefix,
            description=team.description,
            estimate_scale=team.estimate_scale,
            estimate_extended=team.estimate_extended,
            estimate_allow_zero=team.estimate_allow_zero,
            estimate_count_unestimated=team.estimate_count_unestimated,
            sync_pr_labels=team.sync_pr_labels,
            private=private,
            icon_url=icon_url(team.icon_key),
            created_at=team.created_at,
            updated_at=team.updated_at,
            role=role,  # pyright: ignore[reportArgumentType]
            member_count=member_count,
            is_member=is_member,
            retired_key_prefixes=retired_key_prefixes or [],
        )


class TeamListRead(BaseModel):
    """The body the teams list route answers with."""

    teams: list[TeamRead]


MAX_TEAM_ORDER = 500
"""The most team ids one saved sidebar order may name."""


class TeamOrderUpdate(BaseModel):
    """The body the team order put takes: the caller's teams, first to last.

    Teams left out keep their default place after the named ones, so a client
    that has not seen a new team yet cannot hide it.
    """

    team_ids: list[str] = Field(max_length=MAX_TEAM_ORDER)


class TeamMemberUpdate(BaseModel):
    """The body a team membership put takes."""

    role: TeamRoleField


class TeamMemberRead(BaseModel):
    """One team member, joined with their user row for display."""

    user_id: str
    email: str
    display_name: str
    avatar_url: Optional[str] = None
    role: TeamRoleField
    added_at: datetime

    @classmethod
    def from_rows(cls, membership: Membership, user: Optional[User]) -> "TeamMemberRead":
        """Build the response from a team membership and its user row."""
        return cls(
            user_id=membership.user_id,
            email=user.email if user is not None else "",
            display_name=display_name(user),
            avatar_url=icon_url(user.icon_key) if user is not None else None,
            role=membership.role,  # pyright: ignore[reportArgumentType]
            added_at=membership.joined_at,
        )


class TeamMemberListRead(BaseModel):
    """The body the team members list route answers with."""

    members: list[TeamMemberRead]


class StatusCreate(BaseModel):
    """The body a status create takes.

    `color` and `icon` are optional, and a status without them renders from its
    category. The icon must be one of its category's variants.
    """

    name: str = Field(min_length=1, max_length=60)
    category: StatusCategoryField
    position: Optional[int] = Field(default=None, ge=0)
    color: Optional[StatusColor] = None
    icon: Optional[StatusIcon] = None

    @model_validator(mode="after")
    def check_icon_category(self) -> "StatusCreate":
        """Refuse an icon drawn for another category."""
        check_icon(self.category, self.icon)
        return self


class StatusUpdate(BaseModel):
    """The body a status patch takes.

    An explicit null `color` or `icon` clears it back to the category default. The
    icon is checked against the category in `team_workflow.update_status`, where
    the stored category is known when the patch does not name one.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    category: Optional[StatusCategoryField] = None
    position: Optional[int] = Field(default=None, ge=0)
    color: Optional[StatusColor] = None
    icon: Optional[StatusIcon] = None


ConfigScope = Literal["team", "workspace"]


class StatusRead(BaseModel):
    """One workflow status as the API returns it, `null` color and icon meaning the default.

    `scope` says whether the team owns it or inherits it from the workspace. An
    inherited status the team hid carries `hidden`, and one it renamed locally
    carries the workspace name in `inherited_name`.
    """

    id: str
    name: str
    category: StatusCategoryField
    position: int
    color: Optional[StatusColor] = None
    icon: Optional[StatusIcon] = None
    scope: ConfigScope = "team"
    hidden: bool = False
    inherited_name: Optional[str] = None

    @classmethod
    def from_row(cls, status: Status) -> "StatusRead":
        """Build the response shape from a stored status row."""
        return cls(
            id=status.status_id,
            name=status.name,
            category=status.category,  # pyright: ignore[reportArgumentType]
            position=status.position,
            color=status.color,  # pyright: ignore[reportArgumentType]
            icon=status.icon,  # pyright: ignore[reportArgumentType]
            scope=status.scope,  # pyright: ignore[reportArgumentType]
            hidden=status.hidden,
            inherited_name=status.inherited_name,
        )


class StatusListRead(BaseModel):
    """The body the statuses list route answers with, ordered by position."""

    statuses: list[StatusRead]


class LabelCreate(BaseModel):
    """The body a label create takes.

    `is_group` makes a label group, which holds child labels and is never put on
    an issue itself. `parent_id` puts the new label in an existing group of the
    same scope. A group cannot sit in another group.
    """

    name: str = Field(min_length=1, max_length=60)
    color: str
    is_group: bool = False
    parent_id: Optional[str] = Field(default=None, min_length=1)

    @field_validator("color")
    @classmethod
    def check_color(cls, value: str) -> str:
        """Hold the colour to `#rrggbb`, lowercased so two spellings never differ."""
        candidate = value.strip().lower()
        if not COLOR_PATTERN.match(candidate):
            raise ValueError("color must be #rrggbb")
        return candidate


class LabelUpdate(BaseModel):
    """The body a label patch takes.

    `parent_id` moves a label into a group of the same scope, and an explicit
    null takes it out of its group. A field left out keeps its current value.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    color: Optional[str] = None
    parent_id: Optional[str] = Field(default=None, min_length=1)

    @field_validator("color")
    @classmethod
    def check_color(cls, value: Optional[str]) -> Optional[str]:
        """Hold the colour to `#rrggbb` when one is being set."""
        if value is None:
            return None
        candidate = value.strip().lower()
        if not COLOR_PATTERN.match(candidate):
            raise ValueError("color must be #rrggbb")
        return candidate


class LabelRead(BaseModel):
    """One label as the API returns it, with the same `scope`, `hidden` and `inherited_name` a status carries.

    `is_group` marks a label group and `parent_id` names the group a label is in.
    """

    id: str
    name: str
    color: str
    scope: ConfigScope = "team"
    hidden: bool = False
    inherited_name: Optional[str] = None
    is_group: bool = False
    parent_id: Optional[str] = None

    @classmethod
    def from_row(cls, label: Label) -> "LabelRead":
        """Build the response shape from a stored label row."""
        return cls(
            id=label.label_id,
            name=label.name,
            color=label.color,
            scope=label.scope,  # pyright: ignore[reportArgumentType]
            hidden=label.hidden,
            inherited_name=label.inherited_name,
            is_group=label.is_group,
            parent_id=label.parent_id,
        )


class LabelListRead(BaseModel):
    """The body the labels list route answers with."""

    labels: list[LabelRead]


class OverrideUpdate(BaseModel):
    """The body a team's override of a workspace status or label takes.

    `hidden` hides or shows it in the team. `name` renames it in the team only,
    and an explicit null clears the rename back to the workspace name. A field
    left out keeps its current value.
    """

    hidden: Optional[bool] = None
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)


class CycleSettingsUpdate(BaseModel):
    """The body a team's cycle settings patch takes, every field optional.

    `start_weekday` counts from Monday as 0 to Sunday as 6.
    """

    enabled: Optional[bool] = None
    duration_weeks: Optional[int] = Field(default=None, ge=1, le=8)
    cooldown_weeks: Optional[int] = Field(default=None, ge=0, le=2)
    start_weekday: Optional[int] = Field(default=None, ge=0, le=6)
    upcoming_count: Optional[int] = Field(default=None, ge=1, le=MAX_UPCOMING_CYCLES)
    auto_add_started: Optional[bool] = None
    move_unfinished: Optional[bool] = None


class CycleSettingsRead(BaseModel):
    """A team's automatic cycle settings as the API returns them."""

    team_id: str
    enabled: bool
    duration_weeks: int
    cooldown_weeks: int
    start_weekday: int
    upcoming_count: int
    auto_add_started: bool
    move_unfinished: bool
    updated_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, settings: CycleSettings) -> "CycleSettingsRead":
        """Build the response from a stored or default settings row."""
        return cls(
            team_id=settings.team_id,
            enabled=settings.enabled,
            duration_weeks=settings.duration_weeks,
            cooldown_weeks=settings.cooldown_weeks,
            start_weekday=settings.start_weekday,
            upcoming_count=settings.upcoming_count,
            auto_add_started=settings.auto_add_started,
            move_unfinished=settings.move_unfinished,
            updated_at=settings.updated_at,
        )


ArchivePeriodField = Literal[1, 3, 6, 9, 12]


class ArchiveSettingsUpdate(BaseModel):
    """The body a team's auto-archive settings patch takes.

    `period_months` is how long after an issue was completed or cancelled it is
    archived, one of Linear's own choices.
    """

    period_months: Optional[ArchivePeriodField] = None


class ArchiveSettingsRead(BaseModel):
    """A team's auto-archive setting as the API returns it."""

    team_id: str
    period_months: int
    updated_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, settings: ArchiveSettings) -> "ArchiveSettingsRead":
        """Build the response from a stored or default settings row."""
        return cls(team_id=settings.team_id, period_months=settings.period_months, updated_at=settings.updated_at)


class TriageSettingsUpdate(BaseModel):
    """The body a team's triage settings patch takes."""

    enabled: Optional[StrictBool] = None


class TriageSettingsRead(BaseModel):
    """A team's triage setting as the API returns it."""

    team_id: str
    enabled: bool
    updated_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, settings: TriageSettings) -> "TriageSettingsRead":
        """Build the response from a stored or default settings row."""
        return cls(team_id=settings.team_id, enabled=settings.enabled, updated_at=settings.updated_at)


def display_name(user: Optional[User]) -> str:
    """A renderable name for a user row, falling back to the email local part."""
    if user is None:
        return ""
    name = user.display_name.strip()
    if name:
        return name
    return user.email.partition("@")[0]
