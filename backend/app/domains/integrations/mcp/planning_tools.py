"""The MCP tools that read cycles, projects and milestones and write projects.

Cycles and projects answer the planning routes' own read shapes, counts included,
through the same `app.common` visibility and write paths, so a project on a team
the credential cannot see is invisible here as it is over HTTP, and a project
write is held to the same team membership rules. Cycles and milestones stay read
only: their writes are team planning a person does in the product.
"""

from __future__ import annotations

from typing import Any

from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.api.schemas.planning import CycleRead, MilestoneRead, ProjectCreate, ProjectRead, ProjectUpdate
from app.common.planning_rules import load_readable_cycle, load_readable_project, require_team_reader
from app.common.project_writes import create_project, list_projects, update_project
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    enum,
    limit,
    nullable,
    object_schema,
    page_properties,
    resolve_user,
    string,
    string_list,
)
from app.domains.integrations.mcp.transport import ToolError

CYCLE_STATUSES: tuple[str, ...] = ("upcoming", "active", "completed", "cancelled")

PROJECT_STATUSES: tuple[str, ...] = ("backlog", "planned", "in_progress", "paused", "completed", "canceled")

PROJECT_FIELDS: tuple[str, ...] = ("name", "description", "start_date", "target_date", "status", "team_ids")


def _cycle_json(cycle: CycleRead) -> dict[str, Any]:
    """One cycle as the tools answer it: its window, derived status and issue counts."""
    return {
        "cycle_id": cycle.cycle_id,
        "team_id": cycle.team_id,
        "name": cycle.name,
        "start_date": cycle.start_date,
        "end_date": cycle.end_date,
        "goal": cycle.goal,
        "status": cycle.status,
        "counts": cycle.counts.model_dump(),
    }


def _project_json(project: ProjectRead) -> dict[str, Any]:
    """One project as the tools answer it, its teams narrowed to the visible ones."""
    return {
        "project_id": project.project_id,
        "team_ids": project.team_ids,
        "name": project.name,
        "description": project.description,
        "lead_id": project.lead_id,
        "status": project.status,
        "start_date": project.start_date,
        "target_date": project.target_date,
        "counts": project.counts.model_dump(),
        "updated_at": project.updated_at.isoformat(),
    }


def _list_cycles(call: ToolCall) -> Any:
    """One page of a team's cycles by start date, optionally narrowed by status.

    The status is derived from the dates, so it is filtered after the read, as the
    cycles route does, and a page can come back shorter than the limit while
    next_cursor still names more.
    """
    team_id = str(call.require("team_id"))
    require_team_reader(call.repositories, call.context, team_id)
    wanted = call.optional("status")
    if wanted is not None and wanted not in CYCLE_STATUSES:
        raise ToolError(f"status must be one of: {', '.join(CYCLE_STATUSES)}")
    scope = f"cycles:{call.context.workspace_id}:{team_id}"
    rows, last_key = call.repositories.planning.list_cycles(
        call.context.workspace_id,
        team_id,
        limit=limit(call.optional("limit")),
        start_key=decode_cursor(call.optional("cursor"), scope),
    )
    cycles = [CycleRead.from_row(row) for row in rows]
    if wanted is not None:
        cycles = [row for row in cycles if row.status == wanted]
    return {"cycles": [_cycle_json(row) for row in cycles], "next_cursor": encode_cursor(last_key, scope)}


def _get_cycle(call: ToolCall) -> Any:
    """One cycle of a visible team, with its counts."""
    cycle = load_readable_cycle(
        call.repositories, call.context, str(call.require("team_id")), str(call.require("cycle_id"))
    )
    return _cycle_json(CycleRead.from_row(cycle))


def _list_projects(call: ToolCall) -> Any:
    """One page of the projects on teams this credential can see."""
    team_id = call.optional("team_id")
    status_filter = call.optional("status")
    rows, next_cursor = list_projects(
        call.repositories,
        call.context,
        team_id=str(team_id) if team_id else None,
        status_filter=str(status_filter) if status_filter else None,
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
    )
    return {"projects": [_project_json(row) for row in rows], "next_cursor": next_cursor}


def _get_project(call: ToolCall) -> Any:
    """One project with its milestones, when at least one of its teams is visible."""
    project, visible = load_readable_project(call.repositories, call.context, str(call.require("project_id")))
    body = _project_json(ProjectRead.from_row(project, visible))
    milestones = call.repositories.planning.list_milestones(call.context.workspace_id, project.project_id)
    body["milestones"] = [_milestone_json(MilestoneRead.from_row(row)) for row in milestones]
    return body


def _project_payload(call: ToolCall, *, nullable_fields: bool) -> dict[str, Any]:
    """The project fields named in a tool call, as the route's body would carry them."""
    payload: dict[str, Any] = {}
    for name in PROJECT_FIELDS:
        if call.optional(name) is not None:
            payload[name] = call.arguments[name]
        elif nullable_fields and call.present(name) and name in ("description", "start_date", "target_date"):
            payload[name] = None
    if call.present("lead_id"):
        payload["lead_id"] = resolve_user(call, call.arguments["lead_id"])
    return payload


def _create_project(call: ToolCall) -> Any:
    """Create a project on one or more teams the caller may write in."""
    payload = ProjectCreate.model_validate(_project_payload(call, nullable_fields=False))
    return _project_json(create_project(call.repositories, call.context, payload))


def _update_project(call: ToolCall) -> Any:
    """Patch a project's fields or its teams, through the route's own path."""
    payload = ProjectUpdate.model_validate(_project_payload(call, nullable_fields=True))
    return _project_json(update_project(call.repositories, call.context, str(call.require("project_id")), payload))


def _milestone_json(milestone: MilestoneRead) -> dict[str, Any]:
    """One milestone as the tools answer it, in its project's manual order."""
    return {
        "milestone_id": milestone.milestone_id,
        "project_id": milestone.project_id,
        "name": milestone.name,
        "description": milestone.description,
        "target_date": milestone.target_date,
        "counts": milestone.counts.model_dump(),
    }


def _list_project_milestones(call: ToolCall) -> Any:
    """Every milestone of a visible project, in its manual order."""
    project, _ = load_readable_project(call.repositories, call.context, str(call.require("project_id")))
    rows = call.repositories.planning.list_milestones(call.context.workspace_id, project.project_id)
    return {"milestones": [_milestone_json(MilestoneRead.from_row(row)) for row in rows]}


PROJECT_PROPERTIES: dict[str, Any] = {
    "name": string("The project name"),
    "description": nullable("The description, in Markdown"),
    "lead_id": nullable("The lead's user id, 'me' for the caller, or null"),
    "start_date": nullable("Start date, YYYY-MM-DD"),
    "target_date": nullable("Target date, YYYY-MM-DD"),
    "status": enum(PROJECT_STATUSES, "The project status"),
    "team_ids": string_list("Every team the project is on; the caller must be able to write in each one added"),
}

PLANNING_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_cycles",
        description="One page of a team's cycles by start date, with derived status and issue counts.",
        scopes=("teams:read",),
        schema=object_schema(
            {
                "team_id": string("The team whose cycles to read"),
                "status": enum(CYCLE_STATUSES, "Only cycles in this status"),
                **page_properties(),
            },
            required=("team_id",),
        ),
        handler=_list_cycles,
    ),
    Tool(
        name="get_cycle",
        description="One cycle with its window, goal, status and issue counts.",
        scopes=("teams:read",),
        schema=object_schema(
            {"team_id": string("The cycle's team"), "cycle_id": string("The cycle")},
            required=("team_id", "cycle_id"),
        ),
        handler=_get_cycle,
    ),
    Tool(
        name="list_projects",
        description="One page of projects on teams this credential can read, with status and issue counts.",
        scopes=("teams:read",),
        schema=object_schema(
            {
                "team_id": string("Only projects this team is on"),
                "status": enum(PROJECT_STATUSES, "Only projects in this status"),
                **page_properties(),
            }
        ),
        handler=_list_projects,
    ),
    Tool(
        name="get_project",
        description="One project with its teams, lead, dates, status, counts and milestones.",
        scopes=("teams:read",),
        schema=object_schema({"project_id": string("The project")}, required=("project_id",)),
        handler=_get_project,
    ),
    Tool(
        name="create_project",
        description="Create a project on one or more teams. The status defaults to backlog.",
        scopes=("issues:write",),
        schema=object_schema(PROJECT_PROPERTIES, required=("name", "team_ids")),
        handler=_create_project,
    ),
    Tool(
        name="update_project",
        description=(
            "Change a project's fields or its teams. Only the fields named are written; "
            "null clears the description, lead and dates."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {"project_id": string("The project to change"), **PROJECT_PROPERTIES}, required=("project_id",)
        ),
        handler=_update_project,
    ),
    Tool(
        name="list_project_milestones",
        description="Every milestone of a project in its manual order, with issue counts.",
        scopes=("teams:read",),
        schema=object_schema({"project_id": string("The project")}, required=("project_id",)),
        handler=_list_project_milestones,
    ),
)
