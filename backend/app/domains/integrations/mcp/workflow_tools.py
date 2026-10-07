"""MCP tools for workspace statuses and labels and the team overrides of them.

A workspace status or label is inherited live by every team. A workspace admin
manages the records themselves, and a team admin can hide one in the team or
rename it there, which is an override the team route writes too. The tools run
the same `app.common.team_workflow` functions and check the same capabilities as
their routes.
"""

from __future__ import annotations

from typing import Any

from app.common import team_workflow
from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.teams import LabelCreate, LabelUpdate, OverrideUpdate, StatusCreate, StatusUpdate
from app.common.db.dynamo.team_config import Label, Status
from app.common.status_appearance import STATUS_COLORS, STATUS_ICONS
from app.domains.integrations.mcp.team_tools import (
    ICON_ARGUMENT,
    STATUS_CATEGORIES,
    TEAM_ARGUMENT,
    admin_team,
    boolean,
    given_arguments,
    integer,
    label_json,
    label_ref,
    status_json,
    status_ref,
)
from app.domains.integrations.mcp.toolkit import (
    NOT_VISIBLE,
    Tool,
    ToolCall,
    enum,
    nullable,
    nullable_enum,
    object_schema,
    string,
)
from app.domains.integrations.mcp.transport import ToolError


def _workspace_status_ref(call: ToolCall, value: Any) -> Status:
    """One workspace status, named by its id or its name, case-insensitively."""
    reference = str(value).strip()
    rows = call.repositories.team_config.list_workspace_statuses(call.context.workspace_id)
    return _one(rows, "status_id", reference, "status")


def _workspace_label_ref(call: ToolCall, value: Any) -> Label:
    """One workspace label, named by its id or its name, case-insensitively."""
    reference = str(value).strip()
    rows = call.repositories.team_config.list_workspace_labels(call.context.workspace_id)
    return _one(rows, "label_id", reference, "label")


def _one(rows: list[Any], id_attribute: str, reference: str, noun: str) -> Any:
    """The row whose id or name matches, refusing an ambiguous name and an unknown one."""
    for row in rows:
        if getattr(row, id_attribute) == reference:
            return row
    folded = reference.casefold()
    named = [row for row in rows if row.name.casefold() == folded]
    if len(named) > 1:
        raise ToolError(f"More than one workspace {noun} is named {reference}; pass its {id_attribute}")
    if not named:
        raise ToolError(NOT_VISIBLE)
    return named[0]


def _override(call: ToolCall) -> OverrideUpdate:
    """The override patch the caller sent, an explicit null name clearing a rename."""
    return OverrideUpdate.model_validate(given_arguments(call, ("hidden", "name")))


def _list_workspace_statuses(call: ToolCall) -> Any:
    """Every workspace status in board order."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    rows = team_workflow.ordered_workspace_statuses(call.repositories, call.context.workspace_id)
    return {"statuses": [status_json(row) for row in rows]}


def _create_workspace_status(call: ToolCall) -> Any:
    """Add a workspace status every team inherits."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    payload = StatusCreate.model_validate(given_arguments(call, ("name", "category", "position", "color", "icon")))
    return status_json(team_workflow.create_workspace_status(call.repositories, call.context.workspace_id, payload))


def _update_workspace_status(call: ToolCall) -> Any:
    """Rename, recategorise, recolor or move a workspace status in every team at once."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    found = _workspace_status_ref(call, call.require("status"))
    payload = StatusUpdate.model_validate(given_arguments(call, ("name", "category", "position", "color", "icon")))
    updated = team_workflow.update_workspace_status(
        call.repositories, call.context.workspace_id, found.status_id, payload
    )
    return status_json(updated)


def _delete_workspace_status(call: ToolCall) -> Any:
    """Delete a workspace status, moving every team's issues in it to the named replacement, as the route does."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    found = _workspace_status_ref(call, call.require("status"))
    named = call.optional("replacement_status")
    replacement = _workspace_status_ref(call, named) if named else None
    team_workflow.delete_workspace_status(
        call.repositories,
        call.context.workspace_id,
        found.status_id,
        actor_id=call.context.user_id,
        replacement_status_id=replacement.status_id if replacement else None,
    )
    return {
        "deleted": True,
        "status_id": found.status_id,
        "name": found.name,
        "replacement_status_id": replacement.status_id if replacement else None,
    }


def _list_workspace_labels(call: ToolCall) -> Any:
    """Every workspace label in name order."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    rows = team_workflow.ordered_workspace_labels(call.repositories, call.context.workspace_id)
    return {"labels": [label_json(row) for row in rows]}


def _create_workspace_label(call: ToolCall) -> Any:
    """Add a workspace label every team inherits."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    payload = LabelCreate.model_validate({"name": call.require("name"), "color": call.require("color")})
    return label_json(team_workflow.create_workspace_label(call.repositories, call.context.workspace_id, payload))


def _update_workspace_label(call: ToolCall) -> Any:
    """Rename or recolour a workspace label in every team at once."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    found = _workspace_label_ref(call, call.require("label"))
    payload = LabelUpdate.model_validate(given_arguments(call, ("name", "color")))
    updated = team_workflow.update_workspace_label(
        call.repositories, call.context.workspace_id, found.label_id, payload
    )
    return label_json(updated)


def _delete_workspace_label(call: ToolCall) -> Any:
    """Delete a workspace label from every team."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    found = _workspace_label_ref(call, call.require("label"))
    team_workflow.delete_workspace_label(call.repositories, call.context.workspace_id, found.label_id)
    return {"deleted": True, "label_id": found.label_id, "name": found.name}


def _override_team_status(call: ToolCall) -> Any:
    """Hide, show or rename an inherited status in one team."""
    team = admin_team(call)
    found = status_ref(call, team.team_id, call.require("status"))
    updated = team_workflow.set_status_override(
        call.repositories, call.context.workspace_id, team.team_id, found.status_id, _override(call)
    )
    return status_json(updated)


def _reset_team_status_override(call: ToolCall) -> Any:
    """Show an inherited status again in one team, under its workspace name."""
    team = admin_team(call)
    found = status_ref(call, team.team_id, call.require("status"))
    updated = team_workflow.clear_status_override(
        call.repositories, call.context.workspace_id, team.team_id, found.status_id
    )
    return status_json(updated)


def _override_team_label(call: ToolCall) -> Any:
    """Hide, show or rename an inherited label in one team."""
    team = admin_team(call)
    found = label_ref(call, team.team_id, call.require("label"))
    updated = team_workflow.set_label_override(
        call.repositories, call.context.workspace_id, team.team_id, found.label_id, _override(call)
    )
    return label_json(updated)


def _reset_team_label_override(call: ToolCall) -> Any:
    """Show an inherited label again in one team, under its workspace name."""
    team = admin_team(call)
    found = label_ref(call, team.team_id, call.require("label"))
    updated = team_workflow.clear_label_override(
        call.repositories, call.context.workspace_id, team.team_id, found.label_id
    )
    return label_json(updated)


_OVERRIDE_FIELDS = {
    "hidden": boolean("true hides it in the team, false shows it again"),
    "name": nullable("A team-only name, or null to go back to the workspace name"),
}

WORKFLOW_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_workspace_statuses",
        description="The workspace statuses every team inherits, in board order.",
        scopes=("statuses:read",),
        schema=object_schema({}),
        handler=_list_workspace_statuses,
    ),
    Tool(
        name="create_workspace_status",
        description=(
            "Add a workflow status every team inherits, at the end of the board unless a position is given. "
            "Needs workspace admin."
        ),
        scopes=("statuses:write", "admin"),
        schema=object_schema(
            {
                "name": string("The status name"),
                "category": enum(STATUS_CATEGORIES, "Which board category it belongs to"),
                "position": integer("Zero-based position in the board order", 0, 10000),
                "color": enum(STATUS_COLORS, "A palette color; omit for the category default"),
                "icon": enum(STATUS_ICONS, ICON_ARGUMENT),
            },
            required=("name", "category"),
        ),
        handler=_create_workspace_status,
    ),
    Tool(
        name="update_workspace_status",
        description=(
            "Rename a workspace status, change its category, color or icon, or move it, in every team at once. "
            "Needs workspace admin."
        ),
        scopes=("statuses:write", "admin"),
        schema=object_schema(
            {
                "status": string("The workspace status: its id or its name"),
                "name": string("A new name"),
                "category": enum(STATUS_CATEGORIES, "A new category"),
                "position": integer("A new zero-based position", 0, 10000),
                "color": nullable_enum(STATUS_COLORS, "A palette color, or null for the category default"),
                "icon": nullable_enum(STATUS_ICONS, f"{ICON_ARGUMENT}, or null for the category default"),
            },
            required=("status",),
        ),
        handler=_update_workspace_status,
    ),
    Tool(
        name="delete_workspace_status",
        description=(
            "Permanently delete a workspace status from every team. Needs workspace admin; refused when a team "
            "would lose its last visible status of the category. Issues in it, archived ones included, move "
            "to replacement_status, another workspace status, which is required while any are there."
        ),
        scopes=("statuses:write", "admin"),
        schema=object_schema(
            {
                "status": string("The workspace status: its id or its name"),
                "replacement_status": string("The workspace status its issues move to: its id or its name"),
            },
            required=("status",),
        ),
        handler=_delete_workspace_status,
        destructive=True,
    ),
    Tool(
        name="list_workspace_labels",
        description="The workspace labels every team inherits, in name order.",
        scopes=("labels:read",),
        schema=object_schema({}),
        handler=_list_workspace_labels,
    ),
    Tool(
        name="create_workspace_label",
        description="Add a label every team inherits. Needs workspace admin.",
        scopes=("labels:write", "admin"),
        schema=object_schema(
            {
                "name": string("The label name, unique within the workspace labels"),
                "color": string("A hex colour such as #5e6ad2"),
            },
            required=("name", "color"),
        ),
        handler=_create_workspace_label,
    ),
    Tool(
        name="update_workspace_label",
        description="Rename or recolour a workspace label in every team at once. Needs workspace admin.",
        scopes=("labels:write", "admin"),
        schema=object_schema(
            {
                "label": string("The workspace label: its id or its name"),
                "name": string("A new name"),
                "color": string("A new hex colour such as #5e6ad2"),
            },
            required=("label",),
        ),
        handler=_update_workspace_label,
    ),
    Tool(
        name="delete_workspace_label",
        description=(
            "Permanently delete a workspace label, removing it from every team and every issue carrying it. "
            "Needs workspace admin."
        ),
        scopes=("labels:write", "admin"),
        schema=object_schema({"label": string("The workspace label: its id or its name")}, required=("label",)),
        handler=_delete_workspace_label,
        destructive=True,
    ),
    Tool(
        name="override_team_status",
        description=(
            "Hide an inherited workspace status in one team, show it again, or give it a team-only name. "
            "Needs team admin; the team's last visible status of a category cannot be hidden, and neither can "
            "one that unarchived issues are still in, so move them first."
        ),
        scopes=("statuses:write",),
        schema=object_schema(
            {"team_id": string(TEAM_ARGUMENT), "status": string("The status: its id or its name"), **_OVERRIDE_FIELDS},
            required=("team_id", "status"),
        ),
        handler=_override_team_status,
        idempotent=True,
    ),
    Tool(
        name="reset_team_status_override",
        description="Show an inherited workspace status again in one team, under its workspace name. Needs team admin.",
        scopes=("statuses:write",),
        schema=object_schema(
            {"team_id": string(TEAM_ARGUMENT), "status": string("The status: its id or its name")},
            required=("team_id", "status"),
        ),
        handler=_reset_team_status_override,
        idempotent=True,
    ),
    Tool(
        name="override_team_label",
        description="Hide an inherited workspace label in one team, show it again, or give it a team-only name.",
        scopes=("labels:write",),
        schema=object_schema(
            {"team_id": string(TEAM_ARGUMENT), "label": string("The label: its id or its name"), **_OVERRIDE_FIELDS},
            required=("team_id", "label"),
        ),
        handler=_override_team_label,
        idempotent=True,
    ),
    Tool(
        name="reset_team_label_override",
        description="Show an inherited workspace label again in one team, under its workspace name. Needs team admin.",
        scopes=("labels:write",),
        schema=object_schema(
            {"team_id": string(TEAM_ARGUMENT), "label": string("The label: its id or its name")},
            required=("team_id", "label"),
        ),
        handler=_reset_team_label_override,
        idempotent=True,
    ),
)
