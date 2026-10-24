"""The projects list arrangement, shared by the account preference and saved project views.

Held in `common` because the identity image saves one arrangement per person and
the views and integrations images save named ones, and all three must accept and
read back exactly the same choices.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping, Optional, get_args

from pydantic import BaseModel

ProjectsLayoutField = Literal["list", "board", "timeline"]

ProjectsGroupField = Literal["status", "health", "priority", "initiative", "lead", "team", "none"]

ProjectsOrderField = Literal["target", "start", "name", "priority", "progress", "created", "updated"]

ProjectsClosedField = Literal["all", "week", "month", "quarter", "none"]

ProjectsZoomField = Literal["week", "month", "quarter", "year"]


class ProjectsDisplay(BaseModel):
    """How the person arranges the workspace projects list.

    `closed` is how far back completed and canceled projects show: all of them,
    those closed in the past week, month or quarter, or none. `zoom` is the
    timeline layout's scale. Every field has the list's own default, so an
    account that never arranged the list reads as the list opens.
    """

    layout: ProjectsLayoutField = "list"
    group: ProjectsGroupField = "status"
    order: ProjectsOrderField = "target"
    closed: ProjectsClosedField = "all"
    zoom: ProjectsZoomField = "month"


PROJECTS_DISPLAY_FIELDS: dict[str, tuple[str, ...]] = {
    "layout": get_args(ProjectsLayoutField),
    "group": get_args(ProjectsGroupField),
    "order": get_args(ProjectsOrderField),
    "closed": get_args(ProjectsClosedField),
    "zoom": get_args(ProjectsZoomField),
}
"""The choices each stored projects display field may still hold."""


def stored_projects_display(stored: Optional[Mapping[str, Any]]) -> ProjectsDisplay:
    """A stored projects display, each field the default once its choice is retired or missing."""
    defaults = ProjectsDisplay().model_dump()
    values = stored or {}
    return ProjectsDisplay.model_validate(
        {
            field: str(values.get(field, "")) if str(values.get(field, "")) in allowed else defaults[field]
            for field, allowed in PROJECTS_DISPLAY_FIELDS.items()
        }
    )
