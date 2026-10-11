"""Request and response schemas for issue templates.

A template is a name and the issue fields it fills, every one optional, because
a template that only sets the labels is as useful as one that fills everything.
Fields that need a table read to judge, such as a status of the team, are held
by the write path in `app.common.issue_templates`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.common.api.schemas.issues import TITLE_MAX, PriorityField
from app.common.api.schemas.teams import ConfigScope
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.team_templates import IssueTemplate, TemplateSettings

TEMPLATE_NAME_MAX = 80

ESTIMATE_MAX = 16

POSITION_MAX = 10000


def _check_name(value: Optional[str]) -> Optional[str]:
    """Reject a name that is only whitespace, answering it stripped."""
    if value is None:
        return None
    candidate = value.strip()
    if not candidate:
        raise ValueError("name must not be blank")
    return candidate


def _check_title(value: Optional[str]) -> Optional[str]:
    """Read a blank default title as no title, keeping a trailing space so a prefix such as "Bug: " survives."""
    if value is None:
        return None
    return value.lstrip() or None


def _check_body(value: Optional[str]) -> Optional[str]:
    """Hold a default body to the issue body's byte cap, so any issue it fills can hold it."""
    if value is not None and len(value.encode("utf-8")) > ISSUE_BODY_MAX_BYTES:
        raise ValueError(f"body must be at most {ISSUE_BODY_MAX_BYTES} bytes")
    return value


def _distinct(values: Optional[list[str]]) -> Optional[list[str]]:
    """Hold a list of ids to distinct, non-blank values in their given order."""
    if values is None:
        return None
    return [value for value in dict.fromkeys(item.strip() for item in values) if value]


class TemplateFields(BaseModel):
    """The issue fields a template fills, shared by its create and update shapes."""

    title: Optional[str] = Field(default=None, max_length=TITLE_MAX)
    body: Optional[str] = None
    status_id: Optional[str] = None
    priority: Optional[PriorityField] = None
    assignee_id: Optional[str] = None
    estimate: Optional[str] = Field(default=None, max_length=ESTIMATE_MAX)
    project_id: Optional[str] = None
    project_milestone_id: Optional[str] = None
    cycle_id: Optional[str] = None
    position: Optional[int] = Field(default=None, ge=0, le=POSITION_MAX)

    @field_validator("title")
    @classmethod
    def check_title(cls, value: Optional[str]) -> Optional[str]:
        """Drop leading whitespace from the default title, keeping a prefix's trailing space."""
        return _check_title(value)

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> Optional[str]:
        """Hold the body to the shared byte cap."""
        return _check_body(value)


class TemplateCreate(TemplateFields):
    """The body a template create takes: a name and any of the issue fields."""

    name: str = Field(min_length=1, max_length=TEMPLATE_NAME_MAX)
    label_ids: list[str] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        return _check_name(value) or ""

    @field_validator("label_ids")
    @classmethod
    def check_label_ids(cls, value: list[str]) -> list[str]:
        """Hold the labels to distinct ids."""
        return _distinct(value) or []


class TemplateUpdate(TemplateFields):
    """The body a template patch takes: only the fields sent change, and null clears one."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=TEMPLATE_NAME_MAX)
    label_ids: Optional[list[str]] = None

    @field_validator("name")
    @classmethod
    def check_name(cls, value: Optional[str]) -> Optional[str]:
        """Reject a name that is only whitespace."""
        return _check_name(value)

    @field_validator("label_ids")
    @classmethod
    def check_label_ids(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Hold the labels to distinct ids."""
        return _distinct(value)


class TemplateRead(BaseModel):
    """One template as the API returns it.

    `scope` says where it comes from as the team in the path sees it: the team's
    own, its parent team's, or the workspace's. `team_id` is `None` for a
    workspace template.
    """

    id: str
    name: str
    team_id: Optional[str] = None
    scope: ConfigScope = "team"
    title: Optional[str] = None
    body: Optional[str] = None
    status_id: Optional[str] = None
    priority: Optional[PriorityField] = None
    assignee_id: Optional[str] = None
    label_ids: list[str] = Field(default_factory=list)
    estimate: Optional[str] = None
    project_id: Optional[str] = None
    project_milestone_id: Optional[str] = None
    cycle_id: Optional[str] = None
    position: int = 0
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row: IssueTemplate, team_id: Optional[str] = None) -> "TemplateRead":
        """Build the response shape from a stored row, scoped as `team_id` sees it."""
        if row.team_id is None:
            scope = "workspace"
        elif team_id is None or row.team_id == team_id:
            scope = "team"
        else:
            scope = "parent"
        return cls(
            id=row.template_id,
            name=row.name,
            team_id=row.team_id,
            scope=scope,  # pyright: ignore[reportArgumentType]
            title=row.title,
            body=row.body,
            status_id=row.status_id,
            priority=row.priority,  # pyright: ignore[reportArgumentType]
            assignee_id=row.assignee_id,
            label_ids=list(row.label_ids),
            estimate=row.estimate,
            project_id=row.project_id,
            project_milestone_id=row.project_milestone_id,
            cycle_id=row.cycle_id,
            position=row.position,
            created_by=row.created_by,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class TemplateListRead(BaseModel):
    """The body a template list answers with, and the template a new issue starts from.

    `default_template_id` is the team's own default, else its parent's, and is
    always one of `templates`; a workspace list carries none.
    """

    templates: list[TemplateRead]
    default_template_id: Optional[str] = None


class TemplateSettingsRead(BaseModel):
    """A team's template settings as the API returns them.

    `default_template_id` is what the team saved and `effective_default_template_id`
    what its create dialog opens with, which falls back to the parent team's.
    """

    team_id: str
    default_template_id: Optional[str] = None
    effective_default_template_id: Optional[str] = None

    @classmethod
    def from_row(cls, row: TemplateSettings, effective: Optional[str]) -> "TemplateSettingsRead":
        """Build the response shape from a stored settings row and the resolved default."""
        return cls(
            team_id=row.team_id,
            default_template_id=row.default_template_id,
            effective_default_template_id=effective,
        )


class TemplateSettingsUpdate(BaseModel):
    """The body a team's template settings patch takes; null clears the default."""

    default_template_id: Optional[str] = None
