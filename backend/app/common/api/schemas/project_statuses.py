"""Request and response bodies for the workspace's project statuses.

A project status is a named stage a workspace sets up inside one of the six fixed
categories: backlog, planned, started (stored as `in_progress`), paused,
completed and canceled. Every rule reads the category; the status carries the
name, colour and order people see.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional, cast

from pydantic import BaseModel, Field, field_validator

from app.common.api.schemas.project_labels import _check_color, _check_name
from app.common.api.schemas.teams import LABEL_DESCRIPTION_MAX
from app.common.db.dynamo.planning import ProjectStatusRow

PROJECT_STATUS_NAME_MAX = 60

ProjectStatusCategory = Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"]


class ProjectStatusCreate(BaseModel):
    """The body a project status create takes; it lands last in its category unless a position is given."""

    name: str = Field(min_length=1, max_length=PROJECT_STATUS_NAME_MAX)
    category: ProjectStatusCategory
    color: Optional[str] = None
    description: Optional[str] = Field(default=None, max_length=LABEL_DESCRIPTION_MAX)
    position: Optional[int] = Field(default=None, ge=0)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Trim the name and refuse a blank one."""
        return _check_name(value) or ""

    @field_validator("color")
    @classmethod
    def check_color(cls, value: Optional[str]) -> Optional[str]:
        """Hold the colour to `#rrggbb` when one is given."""
        return _check_color(value)


class ProjectStatusUpdate(BaseModel):
    """The body a project status patch takes; an omitted field keeps its value, a null colour or description clears it.

    The category never changes: a status lives in the category it was made in.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=PROJECT_STATUS_NAME_MAX)
    color: Optional[str] = None
    description: Optional[str] = Field(default=None, max_length=LABEL_DESCRIPTION_MAX)
    position: Optional[int] = Field(default=None, ge=0)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: Optional[str]) -> Optional[str]:
        """Trim the name and refuse a blank one."""
        return _check_name(value)

    @field_validator("color")
    @classmethod
    def check_color(cls, value: Optional[str]) -> Optional[str]:
        """Hold the colour to `#rrggbb` when one is being set."""
        return _check_color(value)


class ProjectStatusRead(BaseModel):
    """One project status as the API returns it, with how many projects sit in it."""

    id: str
    name: str
    category: ProjectStatusCategory
    color: Optional[str] = Field(default=None, description="A `#rrggbb` colour, or null to draw the category's tone")
    description: Optional[str] = None
    position: int
    is_default: bool = Field(description="Whether this is the status a bare category value lands on")
    project_count: int = Field(default=0, description="Projects the caller can see that sit in the status")
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row: ProjectStatusRow, *, is_default: bool, project_count: int = 0) -> "ProjectStatusRead":
        """Build the response shape from a project status row."""
        return cls(
            id=row.status_id,
            name=row.name,
            category=cast(ProjectStatusCategory, row.category),
            color=row.color,
            description=row.description,
            position=row.position,
            is_default=is_default,
            project_count=project_count,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class ProjectStatusListRead(BaseModel):
    """The body the project statuses list route answers with, by category then position."""

    statuses: list[ProjectStatusRead]
