"""The MCP tools for project statuses, the workspace's and each team's own stages inside the six fixed categories.

A workspace admin adds a workspace status and a team admin one of their team's,
decided against the status's scope rather than by the token's `admin` scope. A
project status is named by its id, its name case-insensitively, or a category
(`backlog`, `planned`, `in_progress` or `started`, `paused`, `completed`,
`canceled`, or the legacy `done`), which lands on that category's default
status. The project tools take a status the same way, among the statuses of
the workspace and the teams the caller finds.
"""

from __future__ import annotations

from typing import Any, Optional

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.project_statuses import ProjectStatusCreate, ProjectStatusRead
from app.common.db.dynamo.planning import PROJECT_STATUSES, ProjectStatusRow
from app.common.project_scopes import findable_team_ids, offered
from app.common.project_statuses import (
    CATEGORY_FILTER_PREFIX,
    category_of,
    create_project_status,
    find_status,
    list_project_statuses,
    resolve_status,
    workspace_project_statuses,
)
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, enum, object_schema, string
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
        "team_id": row.team_id,
        "is_default": row.is_default,
        "project_count": row.project_count,
    }


def project_statuses(call: ToolCall) -> list[ProjectStatusRow]:
    """The project statuses a reference may name: the workspace's, defaults before any edit, and findable teams'."""
    rows = workspace_project_statuses(call.repositories, call.context.workspace_id)
    return offered(rows, findable_team_ids(call.repositories, call.context))


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
    """The workspace's project statuses with one team's or every team's, with how many visible projects sit in each."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    listed = list_project_statuses(call.repositories, call.context, call.optional("team_id"))
    return {"statuses": [_status_json(row) for row in listed.statuses]}


def _create(call: ToolCall) -> Any:
    """Add a project status to one category of the workspace, or of the team named."""
    category = category_of(str(call.require("category")))
    if category is None:
        raise ToolError(f"No project status category is named {call.require('category')}")
    payload = ProjectStatusCreate.model_validate(
        {
            "name": call.require("name"),
            "category": category,
            "color": call.optional("color"),
            "description": call.optional("description"),
            "position": call.optional("position"),
            "team_id": call.optional("team_id"),
        }
    )
    return _status_json(create_project_status(call.repositories, call.context, payload))


PROJECT_STATUS_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_project_statuses",
        description=(
            "The workspace's project statuses and each team's own by category then position, each with its "
            "category, colour, team_id (null for a workspace status), whether it is the category's default and how "
            "many visible projects sit in it. Give team_id for the workspace's statuses and that team's only, the "
            "set a project on the team is offered."
        ),
        scopes=("projects:read",),
        schema=object_schema(
            {"team_id": string("A team by id, key or name, to list the workspace's statuses with that team's only")}
        ),
        handler=_list,
    ),
    Tool(
        name="create_project_status",
        description=(
            "Add a project status to one category. Without team_id it is a workspace status, which needs workspace "
            "admin; with team_id it belongs to that team, which needs team admin, and only projects on the team are "
            "offered it. Names are unique, ignoring case, among the workspace's statuses and the team's. It lands "
            "last in its category unless a position is given."
        ),
        scopes=("statuses:write",),
        schema=object_schema(
            {
                "name": string("The status name"),
                "category": enum(
                    (*PROJECT_STATUSES, "started"), "The category the status sits in; started means in_progress"
                ),
                "color": string("A hex colour such as #5e6ad2"),
                "description": string("A short description, up to 100 characters"),
                "position": {"type": "integer", "minimum": 0, "description": "Its place within the category, from 0"},
                "team_id": string(
                    "The team that owns the status, by id, key or name; leave out for a workspace status"
                ),
            },
            required=("name", "category"),
        ),
        handler=_create,
    ),
)
