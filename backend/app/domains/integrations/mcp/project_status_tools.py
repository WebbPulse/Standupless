"""The MCP tool for project statuses, the workspace's own stages inside the six fixed categories.

A project status is named by its id, its name case-insensitively, or a category
(`backlog`, `planned`, `in_progress` or `started`, `paused`, `completed`,
`canceled`, or the legacy `done`), which lands on that category's default
status. The project tools take a status the same way.
"""

from __future__ import annotations

from typing import Any, Optional

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.project_statuses import ProjectStatusRead
from app.common.db.dynamo.planning import ProjectStatusRow
from app.common.project_statuses import (
    CATEGORY_FILTER_PREFIX,
    category_of,
    find_status,
    list_project_statuses,
    resolve_status,
    workspace_project_statuses,
)
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema
from app.domains.integrations.mcp.transport import ToolError

STATUS_HELP = (
    "The project status: its id, its name, or a category (backlog, planned, in_progress or started, paused, "
    "completed, canceled), which lands on that category's default status"
)


def _status_json(row: ProjectStatusRead) -> dict[str, Any]:
    """One project status as the tools answer it."""
    return {
        "status_id": row.id,
        "name": row.name,
        "category": row.category,
        "color": row.color,
        "description": row.description,
        "position": row.position,
        "is_default": row.is_default,
        "project_count": row.project_count,
    }


def project_statuses(call: ToolCall) -> list[ProjectStatusRow]:
    """The workspace's project statuses, the seeded defaults before any edit."""
    return workspace_project_statuses(call.repositories, call.context.workspace_id)


def project_status_ref(call: ToolCall, value: Any, rows: Optional[list[ProjectStatusRow]] = None) -> ProjectStatusRow:
    """The project status an id, a name or a category names, or a tool error."""
    reference = str(value).strip()
    if not reference:
        raise ToolError("A project status is required")
    found = resolve_status(rows if rows is not None else project_statuses(call), reference, by_name=True)
    if found is None:
        raise ToolError(f"No project status is named {reference}")
    return found


def project_status_fields(call: ToolCall, status: Any, status_id: Any) -> dict[str, str]:
    """The `status` and `status_id` body fields a tool call's status arguments come to.

    A bare category stays a category, so a patch keeps a project already in it
    where it is; an id or a name becomes the status id.
    """
    fields: dict[str, str] = {}
    rows = project_statuses(call) if status is not None or status_id is not None else []
    if status_id is not None:
        fields["status_id"] = project_status_ref(call, status_id, rows).status_id
    if status is not None:
        reference = str(status).strip()
        category = category_of(reference)
        if category is not None:
            fields["status"] = category
        else:
            row = project_status_ref(call, reference, rows)
            if "status_id" in fields and fields["status_id"] != row.status_id:
                raise ToolError("status and status_id name different project statuses")
            fields["status_id"] = row.status_id
    return fields


def status_filter_value(call: ToolCall, value: Any) -> str:
    """A list filter's status as the filter takes it: a category keeps the whole category, a name becomes its id."""
    reference = str(value).strip()
    category = category_of(reference)
    if category is not None:
        return f"{CATEGORY_FILTER_PREFIX}{category}"
    rows = project_statuses(call)
    if find_status(rows, reference) is not None:
        return reference
    return project_status_ref(call, reference, rows).status_id


def status_names(call: ToolCall) -> dict[str, str]:
    """Each workspace project status id with its name, for the project answers."""
    return {row.status_id: row.name for row in project_statuses(call)}


def _list(call: ToolCall) -> Any:
    """Every project status by category then position, with how many visible projects sit in each."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    listed = list_project_statuses(call.repositories, call.context)
    return {"statuses": [_status_json(row) for row in listed.statuses]}


PROJECT_STATUS_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_project_statuses",
        description=(
            "The workspace's project statuses by category then position, each with its category, colour, "
            "whether it is the category's default and how many visible projects sit in it."
        ),
        scopes=("projects:read",),
        schema=object_schema({}),
        handler=_list,
    ),
)
