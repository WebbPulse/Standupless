"""The MCP tools for initiatives: groups of projects across teams, each with an optional lead team.

Every tool runs the same `app.common.initiative_writes` path the initiative routes
do, so a guest is refused as it is over HTTP, the rollup counts only the projects
the credential can see, and adding a project needs the same write right on one of
its teams the project form does. Initiatives are named by id or by a name unique
in the workspace, and projects by id or by a name unique among the visible ones.
An initiative may sit under a parent as a sub-initiative, and its rollup and
progress take in every project below it. A lead team is named by id, key prefix
or name, and a private one hides the initiative from everyone outside that team.
"""

from __future__ import annotations

from typing import Any, get_args

from app.common.api.schemas.planning import (
    InitiativeCreate,
    InitiativeRead,
    InitiativeStatusField,
    InitiativeUpdate,
    InitiativeUpdateCreate,
    InitiativeUpdatePatch,
    InitiativeUpdateRead,
    ProjectHealthField,
)
from app.common.date_resolution import DATE_RESOLUTIONS, date_label
from app.common.initiative_progress import initiative_progress
from app.common.initiative_writes import (
    NO_TEAM,
    add_project_to_initiative,
    create_initiative,
    create_initiative_update,
    delete_initiative,
    delete_initiative_update,
    get_initiative,
    list_initiative_updates,
    list_initiatives,
    remove_project_from_initiative,
    update_initiative,
    update_initiative_update,
)
from app.common.project_cadence import INTERVAL_OPTIONS
from app.common.readable_ids import initiative_web_url
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    enum,
    initiative_id_ref,
    limit,
    nullable,
    nullable_enum,
    object_schema,
    page_properties,
    project_id_ref,
    resolve_user,
    string,
    team_id_ref,
)
from app.domains.integrations.mcp.transport import ToolError

INITIATIVE_STATUSES: tuple[str, ...] = get_args(InitiativeStatusField)

HEALTHS: tuple[str, ...] = get_args(ProjectHealthField)

INITIATIVE_HELP = "The initiative: id or name"

PROJECT_HELP = "The project: id or name"

TEXT_FIELDS: tuple[str, ...] = (
    "name",
    "description",
    "status",
    "health",
    "start_date",
    "start_date_resolution",
    "target_date",
    "target_date_resolution",
)

CLEARABLE_FIELDS: tuple[str, ...] = ("description", "health", "start_date", "target_date")
"""The initiative fields a tool call clears by passing null."""


def _initiative_json(initiative: InitiativeRead) -> dict[str, Any]:
    """One initiative as the tools answer it, rolled up from the projects this credential sees."""
    return {
        "initiative_id": initiative.initiative_id,
        "name": initiative.name,
        "description": initiative.description,
        "owner_id": initiative.owner_id,
        "team_id": initiative.team_id,
        "status": initiative.status,
        "health": initiative.health,
        "start_date": initiative.start_date,
        "start_date_resolution": initiative.start_date_resolution,
        "start_date_label": date_label(initiative.start_date, initiative.start_date_resolution),
        "target_date": initiative.target_date,
        "target_date_resolution": initiative.target_date_resolution,
        "target_date_label": date_label(initiative.target_date, initiative.target_date_resolution),
        "parent_initiative_id": initiative.parent_initiative_id,
        "ancestors": [ancestor.model_dump() for ancestor in initiative.ancestors],
        "sub_initiative_ids": initiative.sub_initiative_ids,
        "project_ids": initiative.project_ids,
        "rollup_project_ids": initiative.rollup_project_ids,
        "project_count": initiative.project_count,
        "measure": initiative.measure,
        "progress": initiative.progress.model_dump(),
        "counts": initiative.counts.model_dump(),
        "status_counts": initiative.status_counts,
        "points": initiative.points.model_dump(),
        "project_health": initiative.project_health.model_dump(),
        "last_update_at": initiative.last_update_at.isoformat() if initiative.last_update_at else None,
        "update_interval_days": initiative.update_interval_days,
        "update_interval_inherited": initiative.update_interval_inherited,
        "next_update_due_at": initiative.next_update_due_at.isoformat() if initiative.next_update_due_at else None,
        "update_due_state": initiative.update_due_state,
        "updated_at": initiative.updated_at.isoformat(),
    }


def _update_json(update: InitiativeUpdateRead) -> dict[str, Any]:
    """One initiative update as the tools answer it, with whether the caller may change it."""
    return {
        "update_id": update.update_id,
        "initiative_id": update.initiative_id,
        "health": update.health,
        "body": update.body,
        "author_id": update.author_id,
        "source": update.source,
        "created_at": update.created_at.isoformat(),
        "edited_at": update.edited_at.isoformat() if update.edited_at else None,
        "can_edit": update.can_edit,
    }


def _interval(value: Any) -> int:
    """An update cadence in days, refused unless it is one of the allowed options."""
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    if isinstance(value, bool) or not isinstance(value, int) or value not in INTERVAL_OPTIONS:
        options = ", ".join(str(option) for option in INTERVAL_OPTIONS)
        raise ToolError(f"update_interval_days must be one of: {options}")
    return value


def _payload(call: ToolCall, *, nullable_fields: bool) -> dict[str, Any]:
    """The initiative fields named in a tool call, as the route's body would carry them."""
    payload: dict[str, Any] = {}
    for name in TEXT_FIELDS:
        if call.optional(name) is not None:
            payload[name] = call.arguments[name]
        elif nullable_fields and call.present(name) and name in CLEARABLE_FIELDS:
            payload[name] = None
    if call.present("owner_id"):
        payload["owner_id"] = resolve_user(call, call.arguments["owner_id"])
    if call.optional("team_id") is not None:
        payload["team_id"] = team_id_ref(call, call.arguments["team_id"])
    elif nullable_fields and call.present("team_id"):
        payload["team_id"] = None
    if call.optional("parent_initiative_id") is not None:
        payload["parent_initiative_id"] = initiative_id_ref(call, call.arguments["parent_initiative_id"])
    elif nullable_fields and call.present("parent_initiative_id"):
        payload["parent_initiative_id"] = None
    if call.optional("update_interval_days") is not None:
        payload["update_interval_days"] = _interval(call.arguments["update_interval_days"])
    elif nullable_fields and call.present("update_interval_days"):
        payload["update_interval_days"] = None
    return payload


def _list_initiatives(call: ToolCall) -> Any:
    """One page of the initiatives the credential sees by target date, optionally narrowed by status or lead team."""
    status_filter = call.optional("status")
    team = call.optional("team_id")
    if bool(call.optional("no_team")):
        if team is not None:
            raise ToolError("Pass team_id or no_team, not both")
        team_filter: str | None = NO_TEAM
    else:
        team_filter = team_id_ref(call, team) if team is not None else None
    rows, next_cursor = list_initiatives(
        call.repositories,
        call.context,
        status_filter=str(status_filter) if status_filter else None,
        team_filter=team_filter,
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
    )
    return {"initiatives": [_initiative_json(row) for row in rows], "next_cursor": next_cursor}


def _get_initiative(call: ToolCall) -> Any:
    """One initiative with its rollup."""
    initiative_id = initiative_id_ref(call, call.require("initiative_id"))
    body = _initiative_json(get_initiative(call.repositories, call.context, initiative_id))
    workspace = call.repositories.workspaces.get(call.context.workspace_id)
    if workspace is not None:
        body["web_url"] = initiative_web_url(workspace.slug, body["initiative_id"], body["name"])
    return body


def _get_progress(call: ToolCall) -> Any:
    """An initiative's scope, started and completed work per day across its sub-initiatives."""
    initiative_id = initiative_id_ref(call, call.require("initiative_id"))
    return initiative_progress(call.repositories, call.context, initiative_id).model_dump()


def _create_initiative(call: ToolCall) -> Any:
    """Create an initiative with no projects yet."""
    payload = InitiativeCreate.model_validate(_payload(call, nullable_fields=False))
    return _initiative_json(create_initiative(call.repositories, call.context, payload))


def _update_initiative(call: ToolCall) -> Any:
    """Patch an initiative's fields, through the route's own path."""
    initiative_id = initiative_id_ref(call, call.require("initiative_id"))
    payload = InitiativeUpdate.model_validate(_payload(call, nullable_fields=True))
    return _initiative_json(update_initiative(call.repositories, call.context, initiative_id, payload))


def _delete_initiative(call: ToolCall) -> Any:
    """Delete an initiative and its updates; its projects stay, outside any initiative."""
    initiative_id = initiative_id_ref(call, call.require("initiative_id"))
    delete_initiative(call.repositories, call.context, initiative_id)
    return {"deleted": True, "initiative_id": initiative_id}


def _membership(call: ToolCall) -> tuple[str, str]:
    """The initiative and project ids one membership tool call names."""
    initiative_id = initiative_id_ref(call, call.require("initiative_id"))
    return initiative_id, project_id_ref(call, call.require("project_id"))


def _add_project(call: ToolCall) -> Any:
    """Put a project in an initiative, moving it out of any other."""
    initiative_id, project_id = _membership(call)
    project = add_project_to_initiative(call.repositories, call.context, initiative_id, project_id)
    return {"project_id": project.project_id, "initiative_id": project.initiative_id}


def _remove_project(call: ToolCall) -> Any:
    """Take a project out of the initiative it is in."""
    initiative_id, project_id = _membership(call)
    project = remove_project_from_initiative(call.repositories, call.context, initiative_id, project_id)
    return {"project_id": project.project_id, "initiative_id": project.initiative_id}


def _list_updates(call: ToolCall) -> Any:
    """One page of an initiative's updates, newest first."""
    rows, next_cursor = list_initiative_updates(
        call.repositories,
        call.context,
        initiative_id_ref(call, call.require("initiative_id")),
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
    )
    return {"updates": [_update_json(row) for row in rows], "next_cursor": next_cursor}


def _create_update(call: ToolCall) -> Any:
    """Post an update on an initiative, setting its health."""
    initiative_id = initiative_id_ref(call, call.require("initiative_id"))
    fields = {"body": call.optional("body"), "template_id": call.optional("template_id")}
    payload = InitiativeUpdateCreate.model_validate(
        {"health": call.require("health"), **{name: value for name, value in fields.items() if value is not None}}
    )
    return _update_json(create_initiative_update(call.repositories, call.context, initiative_id, payload))


def _update_update(call: ToolCall) -> Any:
    """Edit an update's body or health as its author, the initiative's owner or an admin."""
    initiative_id = initiative_id_ref(call, call.require("initiative_id"))
    payload: dict[str, Any] = {}
    for name in ("body", "health"):
        if call.optional(name) is not None:
            payload[name] = call.arguments[name]
    updated = update_initiative_update(
        call.repositories,
        call.context,
        initiative_id,
        str(call.require("update_id")),
        InitiativeUpdatePatch.model_validate(payload),
    )
    return _update_json(updated)


def _delete_update(call: ToolCall) -> Any:
    """Delete an update; the initiative falls back to the previous update's health."""
    initiative_id = initiative_id_ref(call, call.require("initiative_id"))
    update_id = str(call.require("update_id"))
    delete_initiative_update(call.repositories, call.context, initiative_id, update_id)
    return {"deleted": True, "update_id": update_id, "initiative_id": initiative_id}


INITIATIVE_PROPERTIES: dict[str, Any] = {
    "name": string("The initiative name"),
    "description": nullable("The description, in Markdown"),
    "owner_id": nullable("The owner: user id, 'me' for the caller, or null"),
    "team_id": nullable(
        "The lead team: id, key prefix or name; a private team hides the initiative from non-members. "
        "null makes it workspace level"
    ),
    "status": enum(INITIATIVE_STATUSES, "The initiative status"),
    "health": nullable_enum(HEALTHS, "The initiative health, or null for none"),
    "start_date": nullable(
        "Start date, YYYY-MM-DD, never after target_date; any day in the period when start_date_resolution is coarse"
    ),
    "start_date_resolution": enum(
        DATE_RESOLUTIONS,
        "How wide start_date is: day (the default), or the month, quarter, half or year it opens; "
        "the date moves to that period's first day",
    ),
    "target_date": nullable("Target date, YYYY-MM-DD; any day in the period when target_date_resolution is coarse"),
    "target_date_resolution": enum(
        DATE_RESOLUTIONS,
        "How wide target_date is: day (the default), or the month, quarter, half or year it closes; "
        "the date moves to that period's last day",
    ),
    "parent_initiative_id": nullable(
        "The parent initiative to nest this one under, by id or name; null makes it top level"
    ),
    "update_interval_days": {
        "type": ["integer", "null"],
        "enum": [*INTERVAL_OPTIONS, None],
        "description": (
            "Days between initiative updates: 7, 14 or 30, 0 for none, or null to follow the workspace default"
        ),
    },
}

MEMBERSHIP_SCHEMA = object_schema(
    {"initiative_id": string(INITIATIVE_HELP), "project_id": string(PROJECT_HELP)},
    required=("initiative_id", "project_id"),
)

INITIATIVE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_initiatives",
        description=(
            "One page of the workspace's initiatives by target date, each rolled up from the projects in it and "
            "in its sub-initiatives: project count, issue counts, points and how many projects stand at each "
            "health. Each names its lead team, parent and direct sub-initiatives."
        ),
        scopes=("projects:read",),
        schema=object_schema(
            {
                "status": enum(INITIATIVE_STATUSES, "Only initiatives in this status"),
                "team_id": string("Only initiatives led by this team: id, key prefix or name"),
                "no_team": {"type": "boolean", "description": "Only workspace level initiatives, with no lead team"},
                **page_properties(),
            }
        ),
        handler=_list_initiatives,
    ),
    Tool(
        name="get_initiative",
        description=(
            "One initiative with its owner, status, health, target date, parent chain, sub-initiatives, "
            "projects and a rollup across every sub-initiative below it."
        ),
        scopes=("projects:read",),
        schema=object_schema({"initiative_id": string(INITIATIVE_HELP)}, required=("initiative_id",)),
        handler=_get_initiative,
    ),
    Tool(
        name="get_initiative_progress",
        description=(
            "An initiative's progress over time: scope, started and completed work per day, in issues or points, "
            "across its projects and every sub-initiative's, from the issues the credential can see."
        ),
        scopes=("projects:read",),
        schema=object_schema({"initiative_id": string(INITIATIVE_HELP)}, required=("initiative_id",)),
        handler=_get_progress,
    ),
    Tool(
        name="create_initiative",
        description=(
            "Create an initiative that groups projects across teams, optionally as a sub-initiative of a parent. "
            "The status defaults to planned."
        ),
        scopes=("projects:write",),
        schema=object_schema(INITIATIVE_PROPERTIES, required=("name",)),
        handler=_create_initiative,
    ),
    Tool(
        name="update_initiative",
        description=(
            "Change an initiative's fields. Only the fields named are written; null clears the description, "
            "owner, health, target date and parent, and returns the update cadence to the workspace default. "
            "A parent may not be the initiative itself or one below it, and nesting stops at five levels."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {"initiative_id": string(INITIATIVE_HELP), **INITIATIVE_PROPERTIES}, required=("initiative_id",)
        ),
        handler=_update_initiative,
    ),
    Tool(
        name="delete_initiative",
        description=(
            "Permanently delete an initiative and its updates. Its projects stay but leave the initiative, and "
            "its sub-initiatives move up to its parent. Needs its creator, its owner or a workspace admin."
        ),
        scopes=("projects:write",),
        schema=object_schema({"initiative_id": string(INITIATIVE_HELP)}, required=("initiative_id",)),
        handler=_delete_initiative,
        destructive=True,
    ),
    Tool(
        name="add_project_to_initiative",
        description="Put a project in an initiative. A project is in at most one, so this moves it from any other.",
        scopes=("projects:write",),
        schema=MEMBERSHIP_SCHEMA,
        handler=_add_project,
        idempotent=True,
    ),
    Tool(
        name="remove_project_from_initiative",
        description="Take a project out of an initiative. The project itself is kept.",
        scopes=("projects:write",),
        schema=MEMBERSHIP_SCHEMA,
        handler=_remove_project,
        destructive=True,
    ),
    Tool(
        name="list_initiative_updates",
        description="One page of an initiative's written status updates, newest first, each with its health.",
        scopes=("projects:read",),
        schema=object_schema(
            {"initiative_id": string(INITIATIVE_HELP), **page_properties()}, required=("initiative_id",)
        ),
        handler=_list_updates,
    ),
    Tool(
        name="create_initiative_update",
        description=(
            "Post a status update on an initiative, in Markdown, with its health. Posting sets its health. "
            "Give template_id instead of body to post a workspace document template's body."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "initiative_id": string(INITIATIVE_HELP),
                "body": string("The update, in Markdown. Required unless template_id is given"),
                "health": enum(HEALTHS, "How the initiative stands"),
                "template_id": string(
                    "A workspace document template whose body the update takes when body is left out: id or name"
                ),
            },
            required=("initiative_id", "health"),
        ),
        handler=_create_update,
    ),
    Tool(
        name="update_initiative_update",
        description=(
            "Edit an initiative update's body or health, as its author, the initiative's owner or an admin. "
            "Changing the newest update's health moves the initiative's health."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "initiative_id": string(INITIATIVE_HELP),
                "update_id": string("The update"),
                "body": string("The update, in Markdown"),
                "health": enum(HEALTHS, "How the initiative stands"),
            },
            required=("initiative_id", "update_id"),
        ),
        handler=_update_update,
    ),
    Tool(
        name="delete_initiative_update",
        description=(
            "Permanently delete an initiative update, as its author, the initiative's owner or an admin. "
            "Deleting the newest one returns the initiative to the previous update's health."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {"initiative_id": string(INITIATIVE_HELP), "update_id": string("The update")},
            required=("initiative_id", "update_id"),
        ),
        handler=_delete_update,
        destructive=True,
    ),
)
