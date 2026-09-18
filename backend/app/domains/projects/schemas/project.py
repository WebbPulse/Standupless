"""Request and response schemas for the projects domain.

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
from app.common.db.dynamo.project_config import Label, Status
from app.common.db.dynamo.projects import Project, is_valid_key_prefix
from app.common.db.dynamo.users import User

EstimateScaleField = Literal["off", "fibonacci", "linear", "tshirt"]

StatusCategoryField = Literal["backlog", "unstarted", "started", "completed", "cancelled"]

ProjectRoleField = Literal["admin", "member"]

COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")


class ProjectCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/projects` takes."""

    name: str = Field(min_length=1, max_length=80)
    key_prefix: str = Field(min_length=2, max_length=6)
    estimate_scale: EstimateScaleField = "off"

    @field_validator("key_prefix")
    @classmethod
    def check_key_prefix(cls, value: str) -> str:
        """Hold the key prefix to the contract's alphabet, uppercased.

        Validating here makes a bad prefix a 422 naming the field, so the only
        conflict the create route has to handle is a prefix already in use.
        """
        candidate = value.strip()
        if candidate != candidate.upper():
            raise ValueError("key_prefix must be uppercase")
        if not is_valid_key_prefix(candidate):
            raise ValueError("key_prefix must be 2 to 6 characters, starting with a letter, A to Z and 0 to 9")
        return candidate

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        candidate = value.strip()
        if not candidate:
            raise ValueError("name must not be blank")
        return candidate


class ProjectUpdate(BaseModel):
    """The body a project patch takes. The key prefix is fixed once allocated."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    estimate_scale: Optional[EstimateScaleField] = None
    description: Optional[str] = Field(default=None, max_length=2000)

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


class ProjectRead(BaseModel):
    """One project as the API returns it, carrying the caller's project role."""

    id: str
    workspace_id: str
    name: str
    key_prefix: str
    description: Optional[str] = None
    estimate_scale: str
    created_at: datetime
    updated_at: datetime
    role: Optional[ProjectRoleField] = None

    @classmethod
    def from_row(cls, project: Project, role: Optional[str] = None) -> "ProjectRead":
        """Build the response shape from a stored project row and the caller's role."""
        return cls(
            id=project.project_id,
            workspace_id=project.workspace_id,
            name=project.name,
            key_prefix=project.key_prefix,
            description=project.description,
            estimate_scale=project.estimate_scale,
            created_at=project.created_at,
            updated_at=project.updated_at,
            role=role,  # pyright: ignore[reportArgumentType]
        )


class ProjectListRead(BaseModel):
    """The body the projects list route answers with."""

    projects: list[ProjectRead]


class ProjectMemberUpdate(BaseModel):
    """The body a project membership put takes."""

    role: ProjectRoleField


class ProjectMemberRead(BaseModel):
    """One project member, joined with their user row for display."""

    user_id: str
    email: str
    display_name: str
    role: ProjectRoleField
    added_at: datetime

    @classmethod
    def from_rows(cls, membership: Membership, user: Optional[User]) -> "ProjectMemberRead":
        """Build the response from a project membership and its user row."""
        return cls(
            user_id=membership.user_id,
            email=user.email if user is not None else "",
            display_name=_display_name(user),
            role=membership.role,  # pyright: ignore[reportArgumentType]
            added_at=membership.joined_at,
        )


class ProjectMemberListRead(BaseModel):
    """The body the project members list route answers with."""

    members: list[ProjectMemberRead]


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
