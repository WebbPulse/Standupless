"""Request and response bodies for the workspace's project labels.

Project labels tag projects the way issue labels tag issues, but they are their
own set: one list for the whole workspace, managed by its admins, and never put
on an issue.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.common.api.schemas.teams import COLOR_PATTERN, LABEL_DESCRIPTION_MAX
from app.common.db.dynamo.planning import ProjectLabel

PROJECT_LABEL_NAME_MAX = 60


def _check_color(value: Optional[str]) -> Optional[str]:
    """Hold a colour to `#rrggbb`, lowercased so two spellings never differ."""
    if value is None:
        return None
    candidate = value.strip().lower()
    if not COLOR_PATTERN.match(candidate):
        raise ValueError("color must be #rrggbb")
    return candidate


def _check_name(value: Optional[str]) -> Optional[str]:
    """Trim a name and refuse one that is only whitespace."""
    if value is None:
        return None
    candidate = value.strip()
    if not candidate:
        raise ValueError("name must not be blank")
    return candidate


class ProjectLabelCreate(BaseModel):
    """The body a project label create takes."""

    name: str = Field(min_length=1, max_length=PROJECT_LABEL_NAME_MAX)
    color: str
    description: Optional[str] = Field(default=None, max_length=LABEL_DESCRIPTION_MAX)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Trim the name and refuse a blank one."""
        return _check_name(value) or ""

    @field_validator("color")
    @classmethod
    def check_color(cls, value: str) -> str:
        """Hold the colour to `#rrggbb`."""
        return _check_color(value) or ""


class ProjectLabelUpdate(BaseModel):
    """The body a project label patch takes; an omitted field keeps its value, a null or empty description clears it."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=PROJECT_LABEL_NAME_MAX)
    color: Optional[str] = None
    description: Optional[str] = Field(default=None, max_length=LABEL_DESCRIPTION_MAX)

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


class ProjectLabelRead(BaseModel):
    """One project label as the API returns it, with how many projects carry it."""

    id: str
    name: str
    color: str
    description: Optional[str] = None
    project_count: int = Field(default=0, description="Projects of the workspace that carry the label")
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, label: ProjectLabel, project_count: int = 0) -> "ProjectLabelRead":
        """Build the response shape from a stored project label row."""
        return cls(
            id=label.label_id,
            name=label.name,
            color=label.color,
            description=label.description,
            project_count=project_count,
            created_at=label.created_at,
            updated_at=label.updated_at,
        )


class ProjectLabelListRead(BaseModel):
    """The body the project labels list route answers with, by name."""

    labels: list[ProjectLabelRead]
