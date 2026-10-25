"""The MCP tools for project labels, the workspace's labels for projects and each team's own.

Every tool runs the same `app.common.project_labels` path the project label routes
do: any workspace reader lists them, a workspace admin changes the workspace's
and a team admin their team's, decided against the label's own scope rather
than by the token's `admin` scope. A project label is named by its id or its
name, case-insensitively, among the labels of the workspace and the teams the
caller finds.
"""

from __future__ import annotations

from typing import Any

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.project_labels import ProjectLabelCreate, ProjectLabelRead, ProjectLabelUpdate
from app.common.db.dynamo.planning import ProjectLabel
from app.common.project_labels import (
    NO_LABEL,
    create_project_label,
    delete_project_label,
    list_project_labels,
    update_project_label,
)
from app.common.project_scopes import findable_team_ids, offered
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema, string
from app.domains.integrations.mcp.transport import ToolError

LABEL_HELP = "The project label: its id or its name"

TEAM_HELP = "A team by id, key or name, to list the workspace's project labels with that team's only"


def _label_json(label: ProjectLabelRead) -> dict[str, Any]:
    """One project label as the tools answer it."""
    return {
        "label_id": label.id,
        "name": label.name,
        "color": label.color,
        "description": label.description,
        "team_id": label.team_id,
        "project_count": label.project_count,
    }


def _find(rows: list[ProjectLabel], value: Any) -> ProjectLabel:
    """The project label an id or a case-insensitive name names, or a tool error."""
    reference = str(value).strip()
    if not reference:
        raise ToolError("A project label is required")
    for row in rows:
        if row.label_id == reference:
            return row
    folded = reference.casefold()
    for row in rows:
        if row.name.casefold() == folded:
            return row
    raise ToolError(f"No project label is named {reference}")


def _reachable(call: ToolCall) -> list[ProjectLabel]:
    """The project labels a reference may name: the workspace's and those of every team the caller finds."""
    rows = call.repositories.planning.list_project_labels(call.context.workspace_id)
    return offered(rows, findable_team_ids(call.repositories, call.context))


def project_label_ref(call: ToolCall, value: Any) -> ProjectLabel:
    """One project label of the workspace or a team the caller finds, by id or name."""
    return _find(_reachable(call), value)


def project_label_ids(call: ToolCall, values: Any, *, allow_none: bool = False) -> list[str]:
    """Project label references resolved to ids, `none` kept as is when the caller filters by it."""
    items = values if isinstance(values, list) else [values]
    rows = _reachable(call)
    resolved: list[str] = []
    for item in items:
        if allow_none and str(item).strip() == NO_LABEL:
            resolved.append(NO_LABEL)
            continue
        resolved.append(_find(rows, item).label_id)
    return list(dict.fromkeys(resolved))


def _list(call: ToolCall) -> Any:
    """The workspace's project labels with one team's or every team's, with how many visible projects carry each."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    listed = list_project_labels(call.repositories, call.context, call.optional("team_id"))
    return {"labels": [_label_json(label) for label in listed.labels]}


def _create(call: ToolCall) -> Any:
    """Add a project label to the workspace, or to the team named."""
    payload = ProjectLabelCreate.model_validate(
        {
            "name": call.require("name"),
            "color": call.require("color"),
            "description": call.optional("description"),
            "team_id": call.optional("team_id"),
        }
    )
    return _label_json(create_project_label(call.repositories, call.context, payload))


def _update(call: ToolCall) -> Any:
    """Rename, recolour or redescribe a project label."""
    found = project_label_ref(call, call.require("label"))
    fields = {name: call.arguments[name] for name in ("name", "color", "description") if name in call.arguments}
    payload = ProjectLabelUpdate.model_validate(fields)
    return _label_json(update_project_label(call.repositories, call.context, found.label_id, payload))


def _delete(call: ToolCall) -> Any:
    """Delete a project label and take it off every project."""
    found = project_label_ref(call, call.require("label"))
    cleared = delete_project_label(call.repositories, call.context, found.label_id)
    return {"deleted": True, "label_id": found.label_id, "name": found.name, "projects_cleared": cleared}


PROJECT_LABEL_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_project_labels",
        description=(
            "The workspace's project labels and each team's own in name order, each with its team_id (null for a "
            "workspace label) and how many visible projects carry it. Give team_id for the workspace's labels and "
            "that team's only, the set a project on the team is offered."
        ),
        scopes=("projects:read",),
        schema=object_schema({"team_id": string(TEAM_HELP)}),
        handler=_list,
    ),
    Tool(
        name="create_project_label",
        description=(
            "Add a project label to the workspace, which needs workspace admin, or with team_id to that team, which "
            "needs team admin; only projects on the team are offered a team label. Names are unique, ignoring case, "
            "among the workspace's labels and the team's."
        ),
        scopes=("labels:write",),
        schema=object_schema(
            {
                "name": string("The label name, unique among the project labels"),
                "color": string("A hex colour such as #5e6ad2"),
                "description": string("A short description, up to 100 characters"),
                "team_id": string("The team that owns the label, by id, key or name; leave out for a workspace label"),
            },
            required=("name", "color"),
        ),
        handler=_create,
    ),
    Tool(
        name="update_project_label",
        description=(
            "Rename, recolour or redescribe a project label. Needs workspace admin for a workspace label, "
            "team admin for a team's."
        ),
        scopes=("labels:write",),
        schema=object_schema(
            {
                "label": string(LABEL_HELP),
                "name": string("A new name"),
                "color": string("A new hex colour such as #5e6ad2"),
                "description": string("A new description; an empty string clears it"),
            },
            required=("label",),
        ),
        handler=_update,
    ),
    Tool(
        name="delete_project_label",
        description=(
            "Permanently delete a project label, removing it from every project carrying it. Needs workspace admin "
            "for a workspace label, team admin for a team's."
        ),
        scopes=("labels:write",),
        schema=object_schema({"label": string(LABEL_HELP)}, required=("label",)),
        handler=_delete,
        destructive=True,
    ),
)
