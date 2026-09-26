"""Request and response schemas for the teams domain.

Every list body is an object with one plural key, matching the workspaces domain
and the contract. `next_issue_number` is never a field on any of these models: it
is an allocation detail and exposing it would leak how many issues exist.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

from app.common.db.dynamo.memberships import Membership
from app.common.db.dynamo.team_config import Label, Status
from app.common.db.dynamo.teams import Team, is_valid_key_prefix
from app.common.db.dynamo.users import User

EstimateScaleField = Literal["off", "fibonacci", "linear", "tshirt"]

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
    old prefix keep resolving and no other team can take it.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    key_prefix: Optional[str] = Field(default=None, min_length=2, max_length=6)
    estimate_scale: Optional[EstimateScaleField] = None
    description: Optional[str] = Field(default=None, max_length=2000)

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
    ) -> "TeamRead":
        """Build the response from a team row, the caller's role and membership counts.

        `member_count` and `is_member` count explicit team memberships, the rows
        join, leave and the members routes write.
        """
        return cls(
            id=team.team_id,
            workspace_id=team.workspace_id,
            name=team.name,
            key_prefix=team.key_prefix,
            description=team.description,
            estimate_scale=team.estimate_scale,
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


class TeamMemberUpdate(BaseModel):
    """The body a team membership put takes."""

    role: TeamRoleField


class TeamMemberRead(BaseModel):
    """One team member, joined with their user row for display."""

    user_id: str
    email: str
    display_name: str
    role: TeamRoleField
    added_at: datetime

    @classmethod
    def from_rows(cls, membership: Membership, user: Optional[User]) -> "TeamMemberRead":
        """Build the response from a team membership and its user row."""
        return cls(
            user_id=membership.user_id,
            email=user.email if user is not None else "",
            display_name=_display_name(user),
            role=membership.role,  # pyright: ignore[reportArgumentType]
            added_at=membership.joined_at,
        )


class TeamMemberListRead(BaseModel):
    """The body the team members list route answers with."""

    members: list[TeamMemberRead]


class StatusCreate(BaseModel):
    """The body a status create takes."""

    name: str = Field(min_length=1, max_length=60)
    category: StatusCategoryField
    position: Optional[int] = Field(default=None, ge=0)


class StatusUpdate(BaseModel):
    """The body a status patch takes."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    category: Optional[StatusCategoryField] = None
    position: Optional[int] = Field(default=None, ge=0)


class StatusRead(BaseModel):
    """One workflow status as the API returns it."""

    id: str
    name: str
    category: StatusCategoryField
    position: int

    @classmethod
    def from_row(cls, status: Status) -> "StatusRead":
        """Build the response shape from a stored status row."""
        return cls(
            id=status.status_id,
            name=status.name,
            category=status.category,  # pyright: ignore[reportArgumentType]
            position=status.position,
        )


class StatusListRead(BaseModel):
    """The body the statuses list route answers with, ordered by position."""

    statuses: list[StatusRead]


class LabelCreate(BaseModel):
    """The body a label create takes."""

    name: str = Field(min_length=1, max_length=60)
    color: str

    @field_validator("color")
    @classmethod
    def check_color(cls, value: str) -> str:
        """Hold the colour to `#rrggbb`, lowercased so two spellings never differ."""
        candidate = value.strip().lower()
        if not COLOR_PATTERN.match(candidate):
            raise ValueError("color must be #rrggbb")
        return candidate


class LabelUpdate(BaseModel):
    """The body a label patch takes."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    color: Optional[str] = None

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
    """One label as the API returns it."""

    id: str
    name: str
    color: str

    @classmethod
    def from_row(cls, label: Label) -> "LabelRead":
        """Build the response shape from a stored label row."""
        return cls(id=label.label_id, name=label.name, color=label.color)


class LabelListRead(BaseModel):
    """The body the labels list route answers with."""

    labels: list[LabelRead]


def _display_name(user: Optional[User]) -> str:
    """A renderable name for a user row, falling back to the email local part."""
    if user is None:
        return ""
    name = user.display_name.strip()
    if name:
        return name
    return user.email.partition("@")[0]
