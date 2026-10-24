"""The MCP tools for project labels, the workspace's one set of labels for projects.

Every tool runs the same `app.common.project_labels` path the project label routes
do: any workspace reader lists them and only a workspace admin changes them. A
project label is named by its id or its name, case-insensitively.
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
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema, string
from app.domains.integrations.mcp.transport import ToolError

LABEL_HELP = "The project label: its id or its name"


def _label_json(label: ProjectLabelRead) -> dict[str, Any]:
    """One project label as the tools answer it."""
    return {
        "label_id": label.id,
        "name": label.name,
        "color": label.color,
        "description": label.description,
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


def project_label_ref(call: ToolCall, value: Any) -> ProjectLabel:
    """One project label of the workspace, by id or name."""
    return _find(call.repositories.planning.list_project_labels(call.context.workspace_id), value)


def project_label_ids(call: ToolCall, values: Any, *, allow_none: bool = False) -> list[str]:
    """Project label references resolved to ids, `none` kept as is when the caller filters by it."""
    items = values if isinstance(values, list) else [values]
    rows = call.repositories.planning.list_project_labels(call.context.workspace_id)
    resolved: list[str] = []
    for item in items:
        if allow_none and str(item).strip() == NO_LABEL:
            resolved.append(NO_LABEL)
            continue
        resolved.append(_find(rows, item).label_id)
    return list(dict.fromkeys(resolved))


def _list(call: ToolCall) -> Any:
    """Every project label by name, with how many visible projects carry each."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    listed = list_project_labels(call.repositories, call.context)
    return {"labels": [_label_json(label) for label in listed.labels]}


def _create(call: ToolCall) -> Any:
    """Add a project label to the workspace."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    payload = ProjectLabelCreate.model_validate(
        {
            "name": call.require("name"),
            "color": call.require("color"),
            "description": call.optional("description"),
        }
    )
    return _label_json(create_project_label(call.repositories, call.context, payload))


def _update(call: ToolCall) -> Any:
    """Rename, recolour or redescribe a project label."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    found = project_label_ref(call, call.require("label"))
    fields = {name: call.arguments[name] for name in ("name", "color", "description") if name in call.arguments}
    payload = ProjectLabelUpdate.model_validate(fields)
    return _label_json(update_project_label(call.repositories, call.context, found.label_id, payload))


def _delete(call: ToolCall) -> Any:
    """Delete a project label and take it off every project."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    found = project_label_ref(call, call.require("label"))
    cleared = delete_project_label(call.repositories, call.context, found.label_id)
    return {"deleted": True, "label_id": found.label_id, "name": found.name, "projects_cleared": cleared}


PROJECT_LABEL_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_project_labels",
        description="The workspace's project labels in name order, each with how many visible projects carry it.",
        scopes=("projects:read",),
        schema=object_schema({}),
        handler=_list,
    ),
    Tool(
        name="create_project_label",
        description="Add a project label to the workspace. Needs workspace admin. Names are unique, ignoring case.",
        scopes=("labels:write", "admin"),
        schema=object_schema(
            {
                "name": string("The label name, unique among the project labels"),
                "color": string("A hex colour such as #5e6ad2"),
                "description": string("A short description, up to 100 characters"),
            },
            required=("name", "color"),
        ),
        handler=_create,
    ),
    Tool(
        name="update_project_label",
        description="Rename, recolour or redescribe a project label. Needs workspace admin.",
        scopes=("labels:write", "admin"),
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
            "Permanently delete a project label, removing it from every project carrying it. Needs workspace admin."
        ),
        scopes=("labels:write", "admin"),
        schema=object_schema({"label": string(LABEL_HELP)}, required=("label",)),
        handler=_delete,
        destructive=True,
    ),
)
