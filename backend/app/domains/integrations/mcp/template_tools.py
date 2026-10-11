"""MCP tools for issue templates: a team's, its parent team's and the workspace's.

A template is named by its id or its name, and a tool given `team_id` works on
that team's templates while one without it works on the workspace's. The tools
run the same `app.common.issue_templates` functions as the routes, so a team's
templates are held to team membership and the workspace's to workspace admin,
and a narrowed credential needs the `admin` scope for a workspace template
exactly as the route's scope table asks.
"""

from __future__ import annotations

from typing import Any, Optional

from app.common import issue_templates
from app.common.api.dependencies.authz import Capability, check_capability, missing_scopes
from app.common.api.schemas.templates import POSITION_MAX, TemplateCreate, TemplateRead, TemplateUpdate
from app.common.db.dynamo.team_templates import IssueTemplate
from app.domains.integrations.mcp.toolkit import (
    NOT_VISIBLE,
    PRIORITIES,
    Tool,
    ToolCall,
    enum,
    nullable,
    object_schema,
    resolve_user,
    string,
    string_list,
)
from app.domains.integrations.mcp.transport import ToolError

TEMPLATE_TEAM_ARGUMENT = "Team: id, key such as ENG, or name; omit for a workspace template"

TEMPLATE_ARGUMENT = "The template: its id or its name"

_FIELDS = (
    "title",
    "body",
    "status_id",
    "priority",
    "assignee_id",
    "label_ids",
    "estimate",
    "project_id",
    "project_milestone_id",
    "cycle_id",
    "position",
)


def _one(rows: list[IssueTemplate], reference: str) -> IssueTemplate:
    """The template whose id or name matches, refusing an ambiguous name and an unknown one."""
    for row in rows:
        if row.template_id == reference:
            return row
    folded = reference.casefold()
    named = [row for row in rows if row.name.casefold() == folded]
    if len(named) > 1:
        raise ToolError(f"More than one template is named {reference}; pass its id")
    if not named:
        raise ToolError(NOT_VISIBLE)
    return named[0]


def template_ref(call: ToolCall, team_id: str, value: Any) -> IssueTemplate:
    """One template a team offers the caller, its own, its parent's or the workspace's."""
    rows = issue_templates.team_templates(call.repositories, call.context, team_id)
    return _one(rows, str(value).strip())


def _own_ref(call: ToolCall, team_id: Optional[str], value: Any) -> IssueTemplate:
    """One template of the team itself, or of the workspace with no team, for the write tools."""
    if team_id:
        rows = issue_templates.team_templates(call.repositories, call.context, team_id)
        rows = [row for row in rows if row.team_id == team_id]
    else:
        rows = issue_templates.list_workspace_templates(call.repositories, call.context)
    return _one(rows, str(value).strip())


def _workspace_admin(call: ToolCall) -> None:
    """Hold a workspace template write to workspace admin and to a credential carrying `admin`."""
    if missing_scopes(call.context.scopes, ("admin",)):
        raise ToolError("Missing scope: admin")
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)


def _fields(call: ToolCall, *, patch: bool) -> dict[str, Any]:
    """The template fields the caller sent, `me` resolved to the caller.

    A create reads only the values given, while a patch keeps an explicit null so
    it clears that field.
    """
    names = ("name", *_FIELDS)
    if patch:
        fields = {name: call.arguments[name] for name in names if call.present(name)}
    else:
        fields = {name: call.arguments[name] for name in names if call.optional(name) is not None}
    if fields.get("assignee_id") is not None:
        fields["assignee_id"] = resolve_user(call, fields["assignee_id"])
    return fields


def _json(row: IssueTemplate, team_id: Optional[str]) -> dict[str, Any]:
    """One template as the tools answer it, in the route's response shape."""
    return TemplateRead.from_row(row, team_id).model_dump(mode="json")


def _list_templates(call: ToolCall) -> Any:
    """Every template a team offers and its default, or every workspace template."""
    team_id = call.optional("team_id")
    if team_id:
        rows, default = issue_templates.list_team_templates(call.repositories, call.context, team_id)
        return {"templates": [_json(row, team_id) for row in rows], "default_template_id": default}
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    rows = issue_templates.list_workspace_templates(call.repositories, call.context)
    return {"templates": [_json(row, None) for row in rows], "default_template_id": None}


def _create_template(call: ToolCall) -> Any:
    """Add a template to a team, or to the workspace when no team is named."""
    team_id = call.optional("team_id")
    payload = TemplateCreate.model_validate(_fields(call, patch=False))
    if team_id:
        return _json(issue_templates.create_team_template(call.repositories, call.context, team_id, payload), team_id)
    _workspace_admin(call)
    return _json(issue_templates.create_workspace_template(call.repositories, call.context, payload), None)


def _update_template(call: ToolCall) -> Any:
    """Change, clear or move one of a team's own templates, or a workspace template."""
    team_id = call.optional("team_id")
    if not team_id:
        _workspace_admin(call)
    found = _own_ref(call, team_id, call.require("template"))
    payload = TemplateUpdate.model_validate(_fields(call, patch=True))
    if team_id:
        updated = issue_templates.update_team_template(
            call.repositories, call.context, team_id, found.template_id, payload
        )
    else:
        updated = issue_templates.update_workspace_template(call.repositories, call.context, found.template_id, payload)
    return _json(updated, team_id)


def _delete_template(call: ToolCall) -> Any:
    """Delete one of a team's own templates, or a workspace template."""
    team_id = call.optional("team_id")
    if not team_id:
        _workspace_admin(call)
    found = _own_ref(call, team_id, call.require("template"))
    if team_id:
        issue_templates.delete_team_template(call.repositories, call.context, team_id, found.template_id)
    else:
        issue_templates.delete_workspace_template(call.repositories, call.context, found.template_id)
    return {"deleted": True, "template_id": found.template_id, "name": found.name}


def _field_properties(*, patch: bool) -> dict[str, Any]:
    """The template field arguments, nullable on a patch so a null clears one."""
    value = nullable if patch else string
    return {
        "title": value("The default issue title"),
        "body": value("The default issue body, in Markdown"),
        "status_id": value("A status of the team, or a workspace status for a workspace template"),
        "priority": enum(PRIORITIES, "The default priority"),
        "assignee_id": value("The default assignee; 'me' is the caller"),
        "label_ids": string_list("The default labels, by id"),
        "estimate": value("The default estimate, in the team's scale; not kept on a workspace template"),
        "project_id": value("A project the team is on"),
        "project_milestone_id": value("A milestone of that project"),
        "cycle_id": value("A cycle of the team; refused on a workspace template"),
        "position": {
            "type": "integer",
            "minimum": 0,
            "maximum": POSITION_MAX,
            "description": "Zero-based place in the picker; defaults to the end",
        },
    }


TEMPLATE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_templates",
        description=(
            "The issue templates a team offers, its own, its parent team's and the workspace's, each tagged with "
            "its scope, and the default its create dialog opens with. Without team_id, the workspace templates."
        ),
        scopes=("teams:read",),
        schema=object_schema({"team_id": string(TEMPLATE_TEAM_ARGUMENT)}),
        handler=_list_templates,
    ),
    Tool(
        name="create_template",
        description=(
            "Save an issue template that prefills new issues: a name and any default fields. With team_id it "
            "belongs to that team and its sub-teams and needs team membership; without it every team offers it "
            "and it needs workspace admin. Pass its id or name as template_id to create_issue."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEMPLATE_TEAM_ARGUMENT),
                "name": string("The template name shown in the picker"),
                **_field_properties(patch=False),
            },
            required=("name",),
        ),
        handler=_create_template,
    ),
    Tool(
        name="update_template",
        description=(
            "Change, clear or move one issue template; only the fields named are written and null clears one. "
            "With team_id it edits that team's own template, without it a workspace template (workspace admin)."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEMPLATE_TEAM_ARGUMENT),
                "template": string(TEMPLATE_ARGUMENT),
                "name": string("A new name"),
                **_field_properties(patch=True),
            },
            required=("template",),
        ),
        handler=_update_template,
        idempotent=True,
    ),
    Tool(
        name="delete_template",
        description=(
            "Permanently delete one issue template. Issues already created from it keep their fields. With "
            "team_id it deletes that team's own template, without it a workspace template (workspace admin)."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {"team_id": string(TEMPLATE_TEAM_ARGUMENT), "template": string(TEMPLATE_ARGUMENT)},
            required=("template",),
        ),
        handler=_delete_template,
        destructive=True,
    ),
)
