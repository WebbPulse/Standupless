"""The projects list arrangement, shared by the account preference and saved project views.

Held in `common` because the identity image saves one arrangement per person and
the views and integrations images save named ones, and all three must accept and
read back exactly the same choices.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping, Optional, get_args

from pydantic import BaseModel, field_validator

ProjectsLayoutField = Literal["list", "board", "timeline"]

ProjectsGroupField = Literal["status", "health", "priority", "initiative", "lead", "team", "none"]

ProjectsOrderField = Literal["target", "start", "name", "priority", "progress", "created", "updated", "customers"]

ProjectsClosedField = Literal["all", "week", "month", "quarter", "none"]

ProjectsZoomField = Literal["week", "month", "quarter", "year"]

PROJECTS_COLUMNS: tuple[str, ...] = (
    "health",
    "priority",
    "status",
    "lead",
    "start",
    "target",
    "teams",
    "issues",
    "progress",
)
"""Every column the projects list can show beside the name, in the order it draws them."""

DEFAULT_PROJECTS_COLUMNS = "health,priority,status,lead,start,target,teams,progress"
"""The columns a list that was never arranged shows, every one but the issue count."""


def column_tokens(value: Any) -> list[str]:
    """The column names a stored or sent value holds, from a comma separated text or a list."""
    if isinstance(value, str):
        return [token.strip() for token in value.split(",") if token.strip()]
    if isinstance(value, (list, tuple)):
        return [str(token).strip() for token in value if str(token).strip()]
    return []


def ordered_columns(tokens: list[str]) -> str:
    """The known columns among `tokens`, in the list's own order, as the comma separated text stored."""
    return ",".join(column for column in PROJECTS_COLUMNS if column in tokens)


class ProjectsDisplay(BaseModel):
    """How the person arranges the workspace projects list.

    `closed` is how far back completed and canceled projects show: all of them,
    those closed in the past week, month or quarter, or none. `zoom` is the
    timeline layout's scale. `columns` names the list columns shown beside the
    project name, comma separated in the list's own order, and empty shows the
    name alone; a list of names is accepted and stored the same way. Every field
    has the list's own default, so an account that never arranged the list reads
    as the list opens.
    """

    layout: ProjectsLayoutField = "list"
    group: ProjectsGroupField = "status"
    order: ProjectsOrderField = "target"
    closed: ProjectsClosedField = "all"
    zoom: ProjectsZoomField = "month"
    columns: str = DEFAULT_PROJECTS_COLUMNS

    @field_validator("columns", mode="before")
    @classmethod
    def _known_columns(cls, value: Any) -> str:
        """Refuse a column the list does not draw, and store the rest in the list's order."""
        if not isinstance(value, (str, list, tuple)):
            raise ValueError("columns must be a comma separated text or a list of column names")
        tokens = column_tokens(value)
        unknown = sorted(set(tokens) - set(PROJECTS_COLUMNS))
        if unknown:
            raise ValueError(f"Unknown projects list columns: {', '.join(unknown)}")
        return ordered_columns(tokens)


PROJECTS_DISPLAY_FIELDS: dict[str, tuple[str, ...]] = {
    "layout": get_args(ProjectsLayoutField),
    "group": get_args(ProjectsGroupField),
    "order": get_args(ProjectsOrderField),
    "closed": get_args(ProjectsClosedField),
    "zoom": get_args(ProjectsZoomField),
}
"""The choices each stored single choice projects display field may still hold; `columns` is a set instead."""


def stored_projects_display(stored: Optional[Mapping[str, Any]]) -> ProjectsDisplay:
    """A stored projects display, each field the default once its choice is retired or missing."""
    defaults = ProjectsDisplay().model_dump()
    values = stored or {}
    chosen: dict[str, Any] = {
        field: str(values.get(field, "")) if str(values.get(field, "")) in allowed else defaults[field]
        for field, allowed in PROJECTS_DISPLAY_FIELDS.items()
    }
    held = values.get("columns")
    chosen["columns"] = defaults["columns"] if held is None else ordered_columns(column_tokens(held))
    return ProjectsDisplay.model_validate(chosen)
